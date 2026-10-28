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

// Ruling 101: every lane's scratch lives outside the repository. An editor extension that scans
// the workspace (Tailwind CSS IntelliSense) imports what a probe leaves there -- a stylesheet's
// `@plugin` beside its module and a `node_modules` -- and "git ignores it" says nothing about what
// scans it. The engine has no filesystem, so it compares paths as text; SKILL.md passes real ones.
describe('the scratch directory', () => {
  const STOPPED = new Error('stopped at the first agent');
  async function start(args: Record<string, unknown>) {
    const prompts: string[] = [];
    const script = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', source.replace(/^export const meta/m, 'const meta'));
    const agent = async (prompt: string) => {
      prompts.push(prompt);
      throw STOPPED;
    };
    try {
      await script(args, agent, async (thunks: (() => unknown)[]) => Promise.all(thunks.map((thunk) => thunk())), async () => [], () => {}, () => {}, { total: null, spent: () => 0, remaining: () => Infinity }, async () => {});
    } catch (error) {
      return { error, prompts };
    }
    return { error: undefined, prompts };
  }
  const REPO = '/home/owner/site';
  const RUN = {
    stamp: '20260101T000000Z',
    sha: '0000000',
    repo: 'owner/site',
    repoRoot: REPO,
    worktree: `${REPO}/.claude/worktrees/security-sweep-20260101T000000Z`,
    runDir: `${REPO}/.claude/security-sweeps/20260101T000000Z`,
  };
  const OUTSIDE = '/tmp/claude-1000/project/session/scratchpad/security-sweep-20260101T000000Z';

  test.each([
    ['missing', {}],
    ['empty', { scratch: '' }],
    ['not a string', { scratch: ['/tmp/x'] }],
    ['relative, which an agent resolves inside the checkout it runs in', { scratch: 'tmp/security-sweep' }],
    ['given with a relative repoRoot', { scratch: '/tmp/security-sweep-x', repoRoot: 'site' }],
  ])('refuses a scratch that is %s, rather than guessing one', async (_what, extra) => {
    const { error, prompts } = await start({ ...RUN, ...extra });
    expect(error).not.toBe(STOPPED);
    expect(String(error)).toMatch(/needs args\.(?:scratch|repoRoot, when given), as an absolute path|needs args\.scratch: an absolute path/);
    expect(prompts).toEqual([]);
  });

  test.each([
    ['the old default beside the worktree', `${RUN.worktree}-scratch`],
    ['the repository root itself', REPO],
    ['under the repository root', `${REPO}/tmp/sweep`],
    ['inside the worktree', `${RUN.worktree}/scratch`],
    ['under the repository by way of ..', '/tmp/../home/owner/site/x'],
    ['under the repository in another letter case', '/HOME/Owner/Site/x'],
    ['under the repository with a trailing slash and doubled separators', '/home/owner//site/x/'],
    ['a folder that holds the repository, which would let a lane write into it', '/home/owner'],
  ])('refuses a scratch that is %s', async (_what, scratch) => {
    const { error, prompts } = await start({ ...RUN, scratch });
    expect(error).not.toBe(STOPPED);
    expect(String(error)).toMatch(/outside the repository/);
    expect(prompts).toEqual([]);
  });

  test('refuses a scratch inside a worktree cut outside the repository', async () => {
    const { error, prompts } = await start({ ...RUN, worktree: '/srv/worktrees/sweep', scratch: '/srv/worktrees/sweep/tmp' });
    expect(String(error)).toMatch(/outside the repository/);
    expect(prompts).toEqual([]);
  });

  test('refuses a Windows scratch under a Windows repository, whatever the slashes and case', async () => {
    const windows = { ...RUN, repoRoot: 'C:\\Users\\Owner\\site', worktree: 'C:\\Users\\Owner\\site\\.claude\\worktrees\\security-sweep-x', runDir: 'C:\\Users\\Owner\\site\\.claude\\security-sweeps\\x' };
    const { error } = await start({ ...windows, scratch: 'c:/users/owner/SITE/.claude/scratch' });
    expect(String(error)).toMatch(/outside the repository/);
    const outside = await start({ ...windows, scratch: 'C:\\Users\\Owner\\AppData\\Local\\Temp\\security-sweep-x-1a2b' });
    expect(outside.error).toBe(STOPPED);
  });

  test('finds the repository from the worktree or the run directory when repoRoot is not passed, and refuses when it cannot', async () => {
    const { repoRoot: _repoRoot, ...derived } = RUN;
    expect(String((await start({ ...derived, scratch: `${RUN.worktree}-scratch` })).error)).toMatch(/outside the repository/);
    expect(String((await start({ ...derived, worktree: '/elsewhere/wt', scratch: `${REPO}/x` })).error)).toMatch(/outside the repository/);
    expect((await start({ ...derived, scratch: OUTSIDE })).error).toBe(STOPPED);
    const unknown = await start({ ...derived, worktree: '/elsewhere/wt', runDir: '/elsewhere/run', scratch: OUTSIDE });
    expect(String(unknown.error)).toMatch(/repoRoot/);
    expect(unknown.prompts).toEqual([]);
  });

  test("admits a scratch outside the repository, a sibling whose name starts with the repository's included, and hands it to the first stage", async () => {
    for (const scratch of [OUTSIDE, `${REPO}-scratch`]) {
      const { error, prompts } = await start({ ...RUN, scratch });
      expect(error, scratch).toBe(STOPPED);
      expect(prompts[0]).toContain(`**Your scratch directory is \`${scratch}\`.**`);
    }
  });

  test('no prompt says the scratch sits inside the repository, and a lane writes nowhere else', () => {
    expect(source).not.toMatch(/sits inside the main checkout/);
    expect(source).not.toMatch(/\$\{worktree\}-scratch/);
    expect(source.replace(/\s+/g, ' ')).toContain('never outside your scratch directory');
  });
});

describe("the skill's phase 0 makes the scratch outside the repository", () => {
  const skill = read('.claude/skills/security-sweep/SKILL.md');
  const phase0 = skill.slice(skill.indexOf('## Phase 0: preflight'), skill.indexOf('### The tracker listing'));
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  test('in the session scratch directory, or with mktemp -d, and never under .claude/worktrees/', () => {
    expect(flat(phase0)).toContain('outside the repository');
    expect(flat(phase0)).toContain('session scratch directory');
    expect(phase0).toContain('mktemp -d "${TMPDIR:-/tmp}/security-sweep-$STAMP-XXXXXXXX"');
    expect(phase0).toContain('[System.IO.Path]::GetTempPath()');
    expect(phase0).not.toContain('$WT-scratch');
    expect(phase0).not.toMatch(/mkdir -p "\$RD" "\$WT/);
  });

  test('checks the scratch is writable, by Write and by Bash, before launching, and says how to add it', () => {
    const text = flat(phase0);
    for (const fragment of ['with the Write tool', 'with Bash', 'stop and tell the owner', '/add-dir', '--add-dir']) expect(text, fragment).toContain(fragment);
  });

  test('passes scratch and repoRoot to the workflow, and phase 8 names the scratch for the owner to delete', () => {
    const workflow = skill.slice(skill.indexOf('## Phase 1-5: the workflow'), skill.indexOf('## Phase 6'));
    expect(workflow).toMatch(/scratch: <absolute>/);
    expect(workflow).toMatch(/repoRoot: <absolute>/);
    const phase8 = flat(skill.slice(skill.indexOf('## Phase 8: cleanup'), skill.indexOf('## Growing the lanes')));
    expect(phase8).not.toContain('.claude/worktrees/security-sweep-$STAMP-scratch');
    expect(phase8).toMatch(/scratch directory's path \(`\$SCRATCH`/);
    expect(phase8).toContain('delete it themselves');
  });
});
