import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const tracked = execFileSync('git', ['ls-files', '.claude'], { encoding: 'utf8' }).trim().split('\n').sort();

// Every agent-facing file this template ships, so a new one (or a settings file) is a deliberate change.
test('.claude/ ships exactly these files', () => {
  expect(tracked).toEqual(
    [
      '.claude/README.md',
      '.claude/agents/sweep-lane-web.md',
      '.claude/agents/sweep-lane.md',
      '.claude/agents/sweep-recon.md',
      '.claude/agents/sweep-report.md',
      '.claude/agents/sweep-triage.md',
      '.claude/skills/new-site/SKILL.md',
      '.claude/skills/security-sweep/SKILL.md',
      '.claude/workflows/security-sweep.js',
    ].sort(),
  );
});

const skillText = () => readFileSync('.claude/skills/security-sweep/SKILL.md', 'utf8');
const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

// The audit's pattern list lives in a file the skill shows, so the command text never contains the patterns.
const auditPatterns = () => {
  const skill = skillText();
  const block = skill.slice(skill.indexOf('audit-patterns.txt')).match(/```\n([\s\S]*?)```/);
  return block ? block[1] : '';
};

test('the sweep skill’s post-run audit greps for this repository’s dangerous calls', () => {
  const patterns = auditPatterns();
  for (const pattern of ['wrangler (deploy|preview|secret|delete|login)', 'npm publish', 'git push', '\\.dev\\.vars', '\\.credentials\\.json', 'api\\.cloudflare\\.com', 'api\\.resend\\.com']) {
    expect(patterns, pattern).toContain(pattern);
  }
});

test('the post-run audit extracts tool calls first and reads its patterns from a file', () => {
  const skill = skillText();
  for (const word of ['grep -nEf', 'audit-patterns.txt', 'audit-calls.jsonl', 'tool_use', 'post-run-audit']) {
    expect(skill, word).toContain(word);
  }
  // The patterns are not in the command text, so a hook that refuses a pattern in a command passes it.
  expect(skill).not.toMatch(/grep -nE '/);
});

test('phase 0 drops the credentials the sweep does not need, and phase 8 restores them', () => {
  const skill = skillText();
  const phase0 = section(skill, '## Phase 0', '### The tracker listing');
  for (const word of ['gh auth status', 'gh auth logout', 'ssh-add -D', 'ssh-add -l', 'wrangler logout', '.npmrc']) {
    expect(phase0, word).toContain(word);
  }
  expect(section(skill, '## Phase 8', '## Growing the lanes')).toContain('gh auth login');
});

test('the shared lane rules keep a lane to a free port, an empty npm userconfig and its own packages', () => {
  const source = readFileSync('.claude/workflows/security-sweep.js', 'utf8');
  for (const word of ['--userconfig', 'listen(0,', 'node_modules/.bin', '<title>']) {
    expect(source, word).toContain(word);
  }
});

test('the sweep skill never removes recursively', () => {
  expect(readFileSync('.claude/skills/security-sweep/SKILL.md', 'utf8')).not.toMatch(/rm -r/);
});
