import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
// A site that deletes tools/design-ingest/ must keep agent-files.mjs, or move the predicate into this file.
import { namesAgentInstructions } from '../../tools/design-ingest/agent-files.mjs';

// An agent session in this tree takes instructions only from a fixed, enumerated set of tracked
// files. Both lists below are exact. Adding to one is a deliberate change the owner approves: any
// agent may load such a file, and a committed one binds every session in every copy of the template.
// Kept apart from shipped.test.ts, which pins what .claude/ says; this walks every tracked path.

/** Tracked paths with a segment that names agent instructions (ingest's own list and folding). */
const INSTRUCTION_FILES = ['.claude/skills/new-site/SKILL.md', '.claude/skills/security-sweep/SKILL.md', 'AGENTS.md', 'CLAUDE.md'];

/** Tracked paths with a segment that starts with a dot (ingest's own dot rule). */
const DOT_PATHS = [
  '.claude/README.md',
  '.claude/agents/sweep-lane-web.md',
  '.claude/agents/sweep-lane.md',
  '.claude/agents/sweep-recon.md',
  '.claude/agents/sweep-report.md',
  '.claude/agents/sweep-triage.md',
  '.claude/skills/new-site/SKILL.md',
  '.claude/skills/security-sweep/SKILL.md',
  '.claude/workflows/security-sweep.js',
  '.gitattributes',
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.pre-commit-config.yaml',
];

const WHY = 'any agent may load it, and a committed one binds every session in every copy of this template; adding it to the list in tests/sweep/tree.test.ts is a deliberate change the owner approves';

/** Every problem with a list of tracked paths, one message per path and rule. */
function problems(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const segments = path.split('/');
    if (segments.some(namesAgentInstructions) && !INSTRUCTION_FILES.includes(path)) {
      out.push(`${path} names agent instructions: ${WHY}`);
    }
    if (segments.some((s) => s.startsWith('.')) && !DOT_PATHS.includes(path)) {
      out.push(`${path} is a dotfile or sits in a dot-folder (agent and tool configuration lives there): ${WHY}`);
    }
  }
  return out;
}

const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

describe('no agent-instruction or dot path outside the lists, anywhere in the tree', () => {
  test('the tracked tree passes', () => {
    expect(problems(tracked())).toEqual([]);
  });

  test('both lists name only tracked files', () => {
    const all = new Set(tracked());
    expect([...INSTRUCTION_FILES, ...DOT_PATHS].filter((p) => !all.has(p))).toEqual([]);
  });

  test.each([
    ['a root .mcp.json', '.mcp.json'],
    ['src/AGENTS.md', 'src/AGENTS.md'],
    ['docs/CLAUDE.md', 'docs/CLAUDE.md'],
    ['.github/copilot-instructions.md', '.github/copilot-instructions.md'],
    ['a Cursor rule', '.cursor/rules/x.mdc'],
    ['an editor setting', '.vscode/settings.json'],
    ['Agents.MD in a subfolder (folded)', 'src/pages/Agents.MD'],
    ['a rules file with a fullwidth name', 'docs/ＣＬＡＵＤＥ.md'],
  ])('refuses %s', (_name, path) => {
    const found = problems([...tracked(), path]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m) => m.startsWith(`${path} `))).toBe(true);
    expect(found.join('\n')).toContain('deliberate change the owner approves');
  });
});
