import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const source = read('.claude/workflows/security-sweep.js');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const BASELINE = ['contact-handler', 'served-surface', 'ci-workflow', 'npm-supply-chain', 'design-ingest'];
const PUBLIC = ['disclosure', 'outsiders', 'shipped-text'];
const WEB = ['contact-handler', 'served-surface', 'ci-workflow', 'npm-supply-chain', 'disclosure', 'outsiders'];

const block = (name: string) => source.slice(source.indexOf(`const ${name} = [`), source.indexOf('\n]\n', source.indexOf(`const ${name} = [`)));
const keys = (text: string) => [...text.matchAll(/^\s{4}key: '([a-z-]+)'/gm)].map((match) => match[1]);

describe('the security-sweep workflow', () => {
  test('compiles as a Workflow-tool script', () => {
    expect(() => new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', source.replace(/^export const meta/m, 'const meta'))).not.toThrow();
  });

  test('has this repository’s lane sets and nothing else', () => {
    expect(keys(block('BASELINE_LANES'))).toEqual(BASELINE);
    expect(keys(block('PUBLIC_LANES'))).toEqual(PUBLIC);
    expect(source).toMatch(/const LANE_SETS = \{\s*baseline: BASELINE_LANES,\s*public: PUBLIC_LANES,?\s*\}/);
  });

  test('sends exactly the web lanes to the web profile', () => {
    for (const key of [...BASELINE, ...PUBLIC]) {
      const start = source.indexOf(`key: '${key}'`);
      const lane = source.slice(start, source.indexOf('brief:', start));
      expect(/web: true/.test(lane), key).toBe(WEB.includes(key));
    }
  });

  test('carries nothing of codervis', () => {
    for (const word of [/codervis/i, /issuebot/i, /FastAPI/, /\bpytest\b/, /LiveQuotaError/, /PyPI/, /Debian/, /chatgpt/i, /claude\.ai/, /docker/i, /\bvenv/, /pip-audit/, /#\d{2,3}\b/]) {
      expect(source, String(word)).not.toMatch(word);
    }
  });

  test('every prompt starts from WHERE, which carries the hands-off and data rules', () => {
    expect(source).toMatch(/const WHERE = `[\s\S]*\$\{HANDS_OFF\}[\s\S]*\$\{DATA_NOT_INSTRUCTIONS\}`/);
    for (const prompt of ['reconPrompt', 'scanPrompt', 'verifyPrompt', 'escalatePrompt', 'triagePrompt', 'criticPrompt', 'reportPrompt']) {
      expect(source, prompt).toMatch(new RegExp(`const ${prompt} = (\\([^)]*\\) => )?\`\\$\\{WHERE\\}`));
    }
  });

  test('launches agents only through launch()', () => {
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    expect([...code.matchAll(/\bagent\(/g)]).toHaveLength(1);
  });
});

describe('the stage tool profiles', () => {
  const tools = (name: string) => read(`.claude/agents/${name}.md`).match(/^tools: (.+)$/m)?.[1];
  test.each([
    ['sweep-recon', 'Read, Glob, Grep, Bash, Write'],
    ['sweep-lane', 'Read, Glob, Grep, Bash, Edit, Write'],
    ['sweep-lane-web', 'Read, Glob, Grep, Bash, Edit, Write, WebFetch, WebSearch'],
    ['sweep-triage', 'Read, Glob, Grep, Write'],
    ['sweep-report', 'Read, Glob, Grep, Write'],
  ])('%s holds exactly %s', (name, expected) => expect(tools(name)).toBe(expected));
});
