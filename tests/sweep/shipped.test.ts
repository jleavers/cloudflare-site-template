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

// One alternative per line, as the skill shows them. A missing, changed or extra line fails.
const AUDIT_PATTERNS = [
  'wrangler (deploy|preview|secret|delete|login)',
  'npm publish',
  'gh [a-z]+ (create|edit|close|comment|merge|delete)',
  '(-X|--method) (POST|PATCH|PUT|DELETE)',
  'git push',
  '\\.dev\\.vars',
  '\\.wrangler',
  '\\.npmrc',
  '\\.config/gh',
  '\\.ssh\\b',
  '\\.env\\b',
  '\\.credentials\\.json',
  'printenv',
  '/proc/[0-9]+/environ',
  'mcp__',
  'api\\.cloudflare\\.com',
  'api\\.resend\\.com',
  'hooks\\.slack\\.com',
  'webhook\\.office',
  'workers\\.dev',
  'WebFetch',
  'curl[[:space:]]',
  'wget[[:space:]]',
  '\\bnc[[:space:]]',
];

test('the sweep skill’s audit-patterns block is exactly this repository’s dangerous-call list', () => {
  expect(auditPatterns().trim().split('\n')).toEqual(AUDIT_PATTERNS);
});

test('the post-run audit extracts tool calls first and reads its patterns from a file', () => {
  const skill = skillText();
  for (const word of ['grep -nEf', 'audit-patterns.txt', 'audit-calls.jsonl', 'tool_use', 'post-run-audit']) {
    expect(skill, word).toContain(word);
  }
  // The patterns are not in the command text, so a hook that refuses a pattern in a command passes it.
  expect(skill).not.toMatch(/grep -nE '/);
});

// The decoded text keeps each call's stage, which the extraction added, and the hit count comes
// before the capped list, so a truncated list shows as one.
test('the post-run audit keeps each call\'s stage and counts its hits before listing them', () => {
  const skill = skillText();
  expect(skill).toContain("jq -r '[.f, .s, .n, ");
  const count = skill.indexOf('grep -cEf "$RD/audit-patterns.txt" "$RD/audit-text.txt"');
  expect(count, 'the count').toBeGreaterThan(-1);
  expect(skill.indexOf('grep -nEf "$RD/audit-patterns.txt" "$RD/audit-text.txt" | head -80'), 'the list, after the count').toBeGreaterThan(count);
});

test('phase 0 drops the credentials the sweep does not need, and phase 8 restores them', () => {
  const skill = skillText();
  const phase0 = section(skill, '## Phase 0', '### The tracker listing');
  for (const word of ['gh auth status', 'gh auth logout', 'ssh-add -D', 'ssh-add -l', 'wrangler logout', '.npmrc']) {
    expect(phase0, word).toContain(word);
  }
  expect(section(skill, '## Phase 8', '## Growing the lanes')).toContain('gh auth login');
});

test('the shared lane rules, inside HANDS_OFF, keep a lane to a free port, an empty npm userconfig and its own packages', () => {
  const source = readFileSync('.claude/workflows/security-sweep.js', 'utf8');
  const start = source.indexOf('const HANDS_OFF = `');
  const handsOff = source.slice(start).split(/[^\\]`\n/)[0];
  expect(handsOff.length).toBeGreaterThan(1000);
  for (const word of ['--userconfig', 'listen(0,', 'node_modules/.bin', '<title>', 'npx --userconfig']) {
    expect(handsOff, word).toContain(word);
  }
});

// The owner may review the run in another session, which starts from the run directory's path.
test('phase 6 names the run directory before it asks, and lets the owner review it in another session', () => {
  const phase6 = section(skillText(), '## Phase 6', '## Phase 7');
  expect(phase6.indexOf('`run_dir`')).toBeGreaterThan(-1);
  expect(phase6.indexOf('`run_dir`')).toBeLessThan(phase6.indexOf('Then ask'));
  expect(phase6).toContain('review it in another session');
  expect(section(skillText(), '## Phase 8', '## Growing the lanes')).toContain('another session');
});

test('phase 7 gets its write credential back before filing, and phase 8 unsets GH_TOKEN before gh auth login', () => {
  const skill = skillText();
  const phase7 = section(skill, '## Phase 7', '## Phase 8');
  expect(phase7.indexOf('GH_TOKEN')).toBeGreaterThan(-1);
  expect(phase7.indexOf('GH_TOKEN')).toBeLessThan(phase7.indexOf('gh auth login'));
  const phase8 = section(skill, '## Phase 8', '## Growing the lanes');
  expect(phase8.indexOf('GH_TOKEN')).toBeGreaterThan(-1);
  expect(phase8.indexOf('GH_TOKEN')).toBeLessThan(phase8.indexOf('gh auth login'));
});

test('the sweep skill never removes recursively', () => {
  expect(readFileSync('.claude/skills/security-sweep/SKILL.md', 'utf8')).not.toMatch(/rm -r/);
});
