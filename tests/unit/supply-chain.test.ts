import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------------------------
// Admission: upstream code is installed or run only on an immutable pin that this file verifies,
// under the release-age floor Dependabot applies. That holds whichever path introduced it:
// Dependabot, a hand `npm install`, a lockfile edit in a PR, or a pre-commit hook.
// ---------------------------------------------------------------------------------------------

type LockEntry = {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
};

const REGISTRY = 'https://registry.npmjs.org';

/** The package an entry installs: its `name` field (an npm alias), else the key after the last `node_modules/`. */
function entryName(key: string, entry: LockEntry): string {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  return key.slice(key.lastIndexOf(marker) + marker.length);
}

/** Problems with the lockfile's entries; empty when every entry is bound to its own registry tarball. */
function lockfileProblems(packages: Record<string, LockEntry>): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue; // the root project, which is not fetched
    if (entry.link) {
      problems.push(`${key}: a link`);
      continue;
    }
    if (!entry.resolved) {
      problems.push(`${key}: no resolved`);
      continue;
    }
    if (/^(git\+|file:|http:)/.test(entry.resolved)) problems.push(`${key}: source ${entry.resolved}`);
    const name = entryName(key, entry);
    const unscoped = name.slice(name.lastIndexOf('/') + 1);
    const expected = `${REGISTRY}/${name}/-/${unscoped}-${entry.version}.tgz`;
    if (entry.resolved !== expected) problems.push(`${key}: resolved ${entry.resolved}, expected ${expected}`);
    if (!entry.integrity?.startsWith('sha512-')) problems.push(`${key}: integrity is not sha512`);
  }
  return problems;
}

const sha512 = 'sha512-AAAA';
const good = (name: string, version: string, extra: LockEntry = {}): LockEntry => ({
  version,
  resolved: `${REGISTRY}/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`,
  integrity: sha512,
  ...extra,
});

describe('the lockfile checker', () => {
  test('accepts plain, nested, scoped and aliased entries', () => {
    expect(
      lockfileProblems({
        '': { name: 'site', version: '1.0.0' },
        'node_modules/astro': good('astro', '7.3.8'),
        'node_modules/@astrojs/sitemap': good('@astrojs/sitemap', '3.7.4'),
        'node_modules/a/node_modules/@s/p': good('@s/p', '1.0.0'),
        'node_modules/alias': { ...good('real-pkg', '2.0.0'), name: 'real-pkg' },
      }),
    ).toEqual([]);
  });

  test('refuses a scoped name whose tarball path is wrong', () => {
    const entry = { ...good('@astrojs/sitemap', '3.7.4'), resolved: `${REGISTRY}/@astrojs/sitemap/-/@astrojs/sitemap-3.7.4.tgz` };
    expect(lockfileProblems({ 'node_modules/@astrojs/sitemap': entry })).toHaveLength(1);
  });

  test("refuses an entry that points at another package's tarball", () => {
    expect(lockfileProblems({ 'node_modules/left-pad': good('evil-pkg', '1.0.0') })).toHaveLength(1);
  });

  test("refuses an entry that points at another version's tarball", () => {
    expect(
      lockfileProblems({ 'node_modules/astro': { ...good('astro', '7.3.8'), resolved: good('astro', '7.3.7').resolved } }),
    ).toHaveLength(1);
  });

  test('refuses a non-registry host', () => {
    const resolved = 'https://evil.example/astro/-/astro-7.3.8.tgz';
    expect(lockfileProblems({ 'node_modules/astro': { ...good('astro', '7.3.8'), resolved } })).toHaveLength(1);
  });

  test('refuses sha1 and missing integrity', () => {
    expect(lockfileProblems({ 'node_modules/a': { ...good('a', '1.0.0'), integrity: 'sha1-AAAA' } })).toHaveLength(1);
    expect(lockfileProblems({ 'node_modules/a': { ...good('a', '1.0.0'), integrity: undefined } })).toHaveLength(1);
  });

  test('refuses a link, a missing resolved and git, file and http sources', () => {
    expect(lockfileProblems({ 'node_modules/a': { link: true, resolved: 'packages/a' } })).toHaveLength(1);
    expect(lockfileProblems({ 'node_modules/a': { version: '1.0.0', integrity: sha512 } })).toHaveLength(1);
    for (const resolved of ['git+ssh://git@github.com/x/a.git#abc', 'file:../a', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz']) {
      expect(lockfileProblems({ 'node_modules/a': { ...good('a', '1.0.0'), resolved } }).length).toBeGreaterThan(0);
    }
  });

  test('checks an alias against its real name, not its key', () => {
    const aliased = { ...good('real-pkg', '2.0.0'), name: 'real-pkg' };
    expect(lockfileProblems({ 'node_modules/alias': aliased })).toEqual([]);
    expect(lockfileProblems({ 'node_modules/alias': { ...aliased, resolved: good('alias', '2.0.0').resolved } })).toHaveLength(1);
  });
});

const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, LockEntry> };

describe('a. every lockfile entry is bound to its own registry tarball', () => {
  test('package-lock.json has no problems', () => {
    expect(lockfileProblems(lock.packages)).toEqual([]);
  });
});

describe('b. install scripts are on an allow-list', () => {
  // A new entry needs the owner's approval (AGENTS.md "No unapproved dependencies").
  const ALLOWED = ['esbuild', 'fsevents', 'workerd'];

  test('the packages with install scripts are exactly the allow-list', () => {
    const found = Object.entries(lock.packages)
      .filter(([, entry]) => entry.hasInstallScript)
      .map(([key, entry]) => entryName(key, entry));
    expect([...new Set(found)].sort()).toEqual(ALLOWED);
  });
});

describe('c. pre-commit revs are commit SHAs', () => {
  const lines = read('.pre-commit-config.yaml')
    .split('\n')
    .filter((line) => /^\s*-?\s*rev:/.test(line));

  test('there are revs to check', () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  test.each(lines)('%s', (line) => {
    expect(line).toMatch(/^\s*rev: [0-9a-f]{40}  # v\d+(\.\d+)+$/);
  });
});

describe('d. the release-age floor matches the cooldown', () => {
  const days = [...read('.github/dependabot.yml').matchAll(/^\s*default-days:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
  const ecosystems = [...read('.github/dependabot.yml').matchAll(/package-ecosystem:\s*(\S+)/g)].map((m) => m[1]);

  test('Dependabot covers npm, GitHub Actions and pre-commit hooks, each with a cooldown', () => {
    expect(ecosystems.sort()).toEqual(['github-actions', 'npm', 'pre-commit']);
    expect(days).toHaveLength(ecosystems.length);
  });

  test('.npmrc min-release-age equals every default-days', () => {
    const floor = /^min-release-age=(\d+)$/m.exec(read('.npmrc'));
    expect(floor).not.toBeNull();
    for (const d of days) expect(Number(floor?.[1])).toBe(d);
  });
});
