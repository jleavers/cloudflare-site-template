import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
// Tolerant of CRLF, which Git for Windows can check out when .gitattributes is overridden.
const SKILL_FRONTMATTER = /^---\r?\nname: new-site\r?\ndescription: .+\r?\n---\r?\n/;
const DOCS = ['AGENTS.md', '.claude/skills/new-site/SKILL.md', 'SITE_BRIEF.md', 'design/README.md', 'README.md'];

describe('agent-facing documents', () => {
  test('CLAUDE.md imports AGENTS.md', () => expect(read('CLAUDE.md')).toMatch(/^@AGENTS\.md$/m));

  test.each(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'])('AGENTS.md states contract %s', (id) => {
    expect(read('AGENTS.md')).toMatch(new RegExp(`\\*\\*${id}\\b`));
  });

  test('AGENTS.md keeps the operational rules', () => {
    const agents = read('AGENTS.md');
    for (const rule of ['git reset --hard', 'git clean -fd', 'rm -rf', 'must never** push directly to `main`', 'trailing-whitespace']) {
      expect(agents).toContain(rule);
    }
  });

  test('the new-site skill has frontmatter naming it', () => {
    expect(read('.claude/skills/new-site/SKILL.md')).toMatch(SKILL_FRONTMATTER);
  });

  test('the frontmatter check tolerates CRLF checkouts', () => {
    expect(read('.claude/skills/new-site/SKILL.md').replaceAll('\n', '\r\n')).toMatch(SKILL_FRONTMATTER);
  });

  test.each(DOCS.filter((doc) => existsSync(fileURLToPath(new URL(`../../${doc}`, import.meta.url)))))(
    'every `npm run <script>` in %s exists',
    (doc) => {
      for (const match of read(doc).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) expect(scripts, `${doc}: npm run ${match[1]}`).toContain(match[1]);
    },
  );

  test.each(['tar -tvzf', 'zipinfo', 'symlink', 'hard link', '--no-same-owner', 'CLAUDE.md', '.untrusted', 'file://', "--proto '=https'", 'max-filesize', "--proto-redir '=https'", '-depth'])(
    'the new-site skill keeps the bundle safeguard %s',
    (safeguard) => expect(read('.claude/skills/new-site/SKILL.md')).toContain(safeguard),
  );

  test('SITE_BRIEF.md has its six sections, in order', () => {
    const headings = [...read('SITE_BRIEF.md').matchAll(/^## (\d)\. /gm)].map((match) => match[1]);
    expect(headings).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  test('the README has no unfilled tokens', () => expect(read('README.md')).not.toMatch(/DEMO_URL/));
});
