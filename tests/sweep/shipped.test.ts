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

test('the sweep skill’s post-run audit greps for this repository’s dangerous calls', () => {
  const skill = readFileSync('.claude/skills/security-sweep/SKILL.md', 'utf8');
  for (const pattern of ['wrangler (deploy|preview|secret|delete|login)', 'npm publish', 'git push', '\\.dev\\.vars', 'api\\.cloudflare\\.com', 'api\\.resend\\.com']) {
    expect(skill, pattern).toContain(pattern);
  }
});

test('the sweep skill never removes recursively', () => {
  expect(readFileSync('.claude/skills/security-sweep/SKILL.md', 'utf8')).not.toMatch(/rm -r/);
});
