import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
// Tolerant of CRLF, which Git for Windows can check out when .gitattributes is overridden.
const SKILL_FRONTMATTER = /^---\r?\nname: new-site\r?\ndescription: .+\r?\n---\r?\n/;
const DOCS = ['AGENTS.md', '.claude/skills/new-site/SKILL.md', 'SITE_BRIEF.md', 'design/README.md', 'README.md'];
const SPEC = 'docs/superpowers/specs/2026-10-12-cloudflare-site-template-design.md';

/** A line's code spans: each opens with a run of backticks and closes at the next run of the same length. */
function codeSpans(line: string): string[] {
  const runs = [...line.matchAll(/`+/g)];
  const spans: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
    if (close === -1) continue;
    spans.push(line.slice(open.index + open[0].length, runs[close]!.index));
    i = close;
  }
  return spans;
}

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

  test('C7 covers a live site, not only a custom domain', () => {
    expect(read('AGENTS.md')).toMatch(/\*\*C7 — Example values never reach a live site/);
    for (const doc of ['AGENTS.md', 'README.md', SPEC]) expect(read(doc), doc).toContain('`DELIVERY_PROVIDER`');
  });

  test('a custom domain needs Always Use HTTPS, which preflight cannot check', () => {
    expect(read('README.md')).toContain('Always Use HTTPS');
    expect(read('.claude/skills/new-site/SKILL.md')).toContain('Always Use HTTPS');
    expect(read('README.md')).toContain('preload');
  });

  test('the archive cap counts the bytes extraction writes, not the sizes the archive lists', () => {
    const skill = read('.claude/skills/new-site/SKILL.md');
    expect(skill).toContain('unzip -p <file> | head -c 52428801 | wc -c');
    expect(skill).toContain('tar -xzOf <file> | head -c 52428801 | wc -c');
    expect(skill).not.toMatch(/listed sizes total/);
    expect(read('design/README.md')).toMatch(/50 MB/);
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

  test('the README warns that a new repository\'s first CI run starts at once', () => {
    expect(read('README.md')).toMatch(/first CI run starts straight away/);
    expect(read('README.md')).toMatch(/Dependabot/);
  });

  test('wrangler.jsonc explains the preview warning about missing addresses', () => {
    expect(read('wrangler.jsonc')).toContain('not for Previews');
    expect(read('README.md')).toMatch(/`wrangler preview` warns that\s+`CONTACT_TO_EMAIL`.*not for\s+Previews/s);
  });

  test('the README shows the design-to-site image, and it exists', () => {
    expect(read('README.md')).toContain('](docs/images/design-to-site.png)');
    expect(existsSync(fileURLToPath(new URL('../../docs/images/design-to-site.png', import.meta.url)))).toBe(true);
  });

  test('the README has no unfilled tokens', () => expect(read('README.md')).not.toMatch(/DEMO_URL/));

  test.each(['README.md', '.claude/skills/new-site/SKILL.md'])('%s puts the CI token in an environment and keeps previews opt-in', (doc) => {
    const text = read(doc);
    for (const fragment of ['--env production', 'CI_PREVIEWS']) expect(text, `${doc}: ${fragment}`).toContain(fragment);
    expect(text).not.toMatch(/(every|each) pull request gets a preview|previews each pull request|a preview for every pull request/i);
  });

  // A pull-request rule alone requires no approval, so an agent holding the owner's credential, or
  // any Contents-and-Pull-requests token, can open a pull request and merge it.
  test.each(['README.md', '.claude/skills/new-site/SKILL.md'])('%s keeps agents out of main with their own identity and a required approval, and deploys by hand without hosted minutes', (doc) => {
    const text = read(doc).replace(/\s+/g, ' '); // as rendered: line breaks are spaces
    for (const fragment of ['merge into `main`', 'separate GitHub identity', 'own credential', 'one approval', 'bypass list', 'GitHub-hosted', 'npm run deploy']) {
      expect(text, `${doc}: ${fragment}`).toContain(fragment);
    }
    expect(text).not.toMatch(/ruleset that requires a pull request|unless a ruleset requires a pull request/);
  });

  test('the README gives coding agents a token without workflow permission, never an SSH key', () => {
    for (const fragment of ['workflow permission', 'SSH key']) expect(read('README.md').replace(/\s+/g, ' ')).toContain(fragment);
  });

  // GitHub splits a table row at every unescaped |, inside a code span too: `a || b` there needs \|\|.
  test.each([...DOCS, SPEC].filter((doc) => existsSync(fileURLToPath(new URL(`../../${doc}`, import.meta.url)))))(
    '%s escapes every | in a table row\'s code spans',
    (doc) => {
      read(doc)
        .split('\n')
        .forEach((line, i) => {
          if (line.startsWith('|')) for (const span of codeSpans(line)) expect(span, `${doc}:${i + 1}`).not.toMatch(/(?<!\\)\|/);
        });
    },
  );

  test('the code-span reader finds spans of any backtick length', () => {
    expect(codeSpans('| `` ` `` (backtick) | `\\` (backslash) | `a \\|\\| b` |')).toEqual([' ` ', '\\', 'a \\|\\| b']);
  });
});
