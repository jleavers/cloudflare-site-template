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

  test('SITE_BRIEF.md has its seven sections, in order', () => {
    const headings = [...read('SITE_BRIEF.md').matchAll(/^## (\d)\. /gm)].map((match) => match[1]);
    expect(headings).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  test('SITE_BRIEF.md asks for business details and shows the success message the site ships', () => {
    const brief = read('SITE_BRIEF.md');
    expect(brief).toMatch(/^## 4\. Business details \(optional\)/m);
    for (const line of ['Phone', 'Public address', 'Opening hours']) expect(brief).toContain(`**${line}`);
    expect(brief).toContain('{email}');
    const message = /successMessage: '(.+)',/.exec(read('src/config/site.ts'))![1];
    expect(brief).toContain(`**Message shown after sending** (optional \`{email}\` is replaced with the visitor's address): ${message}`);
  });

  test('the new-site skill handles placeholders, testimonials and business details', () => {
    const skill = read('.claude/skills/new-site/SKILL.md');
    for (const fragment of ['placeholder', 'Fill a placeholder whenever the brief answers it', 'only testimonials the brief supplies', 'Digital Markets, Competition and Consumers Act 2024', 'file:line', 'Business details']) {
      expect(skill).toContain(fragment);
    }
  });

  test('a site without a domain has a source for site.url', () => {
    expect(read('SITE_BRIEF.md')).toMatch(/^- \*\*workers\.dev subdomain\*\*/m);
    expect(read('.claude/skills/new-site/SKILL.md')).toContain('https://<slug>.<subdomain>.workers.dev');
  });

  test('the new-site skill removes the template identity and notes the POSIX shell', () => {
    const skill = read('.claude/skills/new-site/SKILL.md');
    for (const fragment of ['## 9a.', '`repository`, `bugs` and `homepage`', 'SECURITY.md', 'Git Bash']) expect(skill).toContain(fragment);
  });

  test('the skill saves only a canvas design and neutralises SKILL.md', () => {
    const skill = read('.claude/skills/new-site/SKILL.md');
    for (const fragment of ['canvas.json', '.dc.html', 'SKILL.md', '-name SKILL.md', '/_blob/']) expect(skill).toContain(fragment);
  });

  test('design/README.md says Claude artifacts have no handoff option', () => {
    expect(read('design/README.md')).toMatch(/artifacts? (have|has) no .*handoff/i);
  });

  test('design/BRIEFING.md exists, is linked, and carries the run\'s lessons', () => {
    expect(existsSync(fileURLToPath(new URL('../../design/BRIEFING.md', import.meta.url)))).toBe(true);
    expect(read('README.md')).toContain('design/BRIEFING.md');
    expect(read('design/README.md')).toContain('BRIEFING.md');
    const briefing = read('design/BRIEFING.md');
    expect(briefing).toContain('[Bracketed');
    expect(briefing).toContain('design/SOURCE.md');
  });

  test.each(['README.md', '.claude/skills/new-site/SKILL.md'])('%s covers a first deploy without a browser', (doc) => {
    const text = read(doc);
    for (const fragment of ['8976', 'CLOUDFLARE_API_TOKEN', 'Read-Host -MaskInput']) expect(text, `${doc}: ${fragment}`).toContain(fragment);
  });

  test.each(['SITE_BRIEF.md', 'README.md', '.claude/skills/new-site/SKILL.md'])('%s says CONTACT_FROM_EMAIL may carry a display name', (doc) => {
    expect(read(doc)).toMatch(/display name/i);
  });

  test('the README has no unfilled tokens', () => expect(read('README.md')).not.toMatch(/DEMO_URL/));
});
