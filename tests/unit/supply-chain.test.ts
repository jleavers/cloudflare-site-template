import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const exists = (path: string) => existsSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

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

/** The package a key names: the part after its last `node_modules/`, which may be `@scope/pkg`. */
function keyName(key: string): string {
  const marker = 'node_modules/';
  return key.slice(key.lastIndexOf(marker) + marker.length);
}

// An npm alias (key-derived name -> real name). Empty: an alias needs the owner's approval like any dependency.
const ALIASES: Record<string, string> = {};

/** A `name` field that differs from the key's name would let an entry carry another package's tarball. */
function entryName(key: string, entry: LockEntry, aliases: Record<string, string> = ALIASES): string {
  const derived = keyName(key);
  if (entry.name && entry.name !== derived && aliases[derived] !== entry.name) return `\0${entry.name}`;
  return entry.name ?? derived;
}

/** Problems with the lockfile's entries; empty when every entry is bound to its own registry tarball. */
function lockfileProblems(packages: Record<string, LockEntry>, aliases: Record<string, string> = ALIASES): string[] {
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
    if (!entry.version) {
      problems.push(`${key}: no version`);
      continue;
    }
    const name = entryName(key, entry, aliases);
    if (name.startsWith('\0')) {
      problems.push(`${key}: name ${name.slice(1)} differs from the key and is not an allowed alias`);
      continue;
    }
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
  test('accepts plain, nested, scoped and allow-listed aliased entries', () => {
    expect(
      lockfileProblems({
        '': { name: 'site', version: '1.0.0' },
        'node_modules/astro': good('astro', '7.3.8'),
        'node_modules/@astrojs/sitemap': good('@astrojs/sitemap', '3.7.4'),
        'node_modules/a/node_modules/@s/p': good('@s/p', '1.0.0'),
        'node_modules/alias': { ...good('real-pkg', '2.0.0'), name: 'real-pkg' },
      }, { alias: 'real-pkg' }),
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

  test('checks an allow-listed alias against its real name, not its key', () => {
    const aliased = { ...good('real-pkg', '2.0.0'), name: 'real-pkg' };
    const allowed = { alias: 'real-pkg' };
    expect(lockfileProblems({ 'node_modules/alias': aliased }, allowed)).toEqual([]);
    expect(lockfileProblems({ 'node_modules/alias': { ...aliased, resolved: good('alias', '2.0.0').resolved } }, allowed)).toHaveLength(1);
  });

  test("refuses a name field that rewrites an entry to another package's tarball (is-number -> kind-of)", () => {
    const rewritten = { ...good('kind-of', '6.0.3'), name: 'kind-of' };
    expect(lockfileProblems({ 'node_modules/is-number': rewritten })).toHaveLength(1);
    expect(lockfileProblems({ 'node_modules/is-number': rewritten }, { 'is-number': 'other' })).toHaveLength(1);
  });

  test('refuses an entry with no version', () => {
    expect(lockfileProblems({ 'node_modules/a': { ...good('a', '1.0.0'), version: undefined } })).toEqual(['node_modules/a: no version']);
  });
});

const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, LockEntry> };

describe('a. every lockfile entry is bound to its own registry tarball', () => {
  test('package-lock.json has no problems', () => {
    expect(lockfileProblems(lock.packages)).toEqual([]);
  });
});

describe('b. npm runs no install scripts in this repository', () => {
  // .npmrc's `ignore-scripts=true` is the enforcement. With it, every `npm ci` and `npm install`
  // this repository prescribes (CI's verify, e2e and preview-build, and the owner's machine) runs
  // no package's lifecycle scripts, nor the `node-gyp rebuild` npm infers from a root binding.gyp.
  // The lockfile cannot be the gate: npm writes no hasInstallScript for a package that ships a
  // binding.gyp and declares "gypfile": false, and `npm ci` builds it anyway (sweep cluster 3).
  // A command-line flag or an npm_config_ environment variable outranks .npmrc, so no command the
  // repository prescribes may turn scripts back on.

  /** Problems unless .npmrc's last `ignore-scripts` setting, outside any [section], is exactly `true`. */
  function npmrcProblems(npmrc: string): string[] {
    const lines = npmrc.split(/\r?\n/);
    const problems: string[] = [];
    if (lines.some((line) => /^\s*\[/.test(line))) problems.push('.npmrc has a [section], which would scope the settings under it');
    const values = lines.flatMap((line) => /^\s*ignore-scripts\s*=\s*(.*?)\s*$/.exec(line)?.[1] ?? []);
    if (values.length === 0) problems.push('.npmrc does not set ignore-scripts');
    else if (values.at(-1) !== 'true') problems.push(`.npmrc sets ignore-scripts=${values.at(-1)}`);
    return problems;
  }

  // A package that truly needs its install script would be rebuilt by name where it is installed,
  // with scripts on for that package only, and named here with the owner's approval. None does.
  const REBUILDS: string[] = [];

  const unquote = (value: string) => value.replace(/^['"]+|['"]+$/g, '');

  /** Problems with prescribed commands: anything that turns install scripts back on, or rebuilds every package. */
  function overrideProblems(where: string, text: string, rebuilds: string[] = REBUILDS): string[] {
    const problems: string[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const at = `${where}:${i + 1}`;
      // One command at a time: an allow-listed rebuild excuses its own flag, never the next command's.
      for (const segment of line.split(/&&|\|\||;|\|/)) {
        const command = `\`${segment.trim()}\``;
        let rebuildByName = false;
        for (const match of segment.matchAll(/\bnpm\s+(?:rebuild|rb)\b([^`)]*)/g)) {
          const names = match[1]!.trim().split(/\s+/).filter((word) => word && !word.startsWith('-'));
          const others = names.filter((name) => !rebuilds.includes(name));
          if (names.length === 0) problems.push(`${at}: a rebuild with no package list rebuilds every package, in ${command}`);
          else if (others.length > 0) problems.push(`${at}: a rebuild of ${others.join(', ')}, which is not on the allow-list, in ${command}`);
          else rebuildByName = true;
        }
        for (const match of segment.matchAll(/--(no-)?ignore-scripts\b(?:=([^\s`,)]*)|\s+(true|false)\b)?/g)) {
          const value = match[1] ? 'false' : unquote(match[2] ?? match[3] ?? 'true');
          if (value !== 'true' && !rebuildByName) problems.push(`${at}: ${match[0]} in ${command}`);
        }
        for (const match of segment.matchAll(/npm_config_ignore[-_]scripts\b['"]?\s*[:=]\s*([^\s`,)]*)/gi)) {
          if (unquote(match[1]!) !== 'true') problems.push(`${at}: ${match[0]} in ${command}`);
        }
        for (const match of segment.matchAll(/\bnpm\s+(?:config\s+)?set\b[^`]*?\bignore-scripts(?:\s*=\s*|\s+)([^\s`,)]*)/g)) {
          if (unquote(match[1]!) !== 'true') problems.push(`${at}: ${match[0]} in ${command}`);
        }
      }
    });
    return problems;
  }

  // npm's own events: a script named pre<event> or post<event> runs around one.
  const EVENTS = ['install', 'uninstall', 'prepare', 'pack', 'publish', 'publishOnly', 'version', 'shrinkwrap', 'dependencies', 'test', 'start', 'stop', 'restart'];
  // What npm runs of the project's own scripts when it installs the project.
  const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];

  /**
   * Problems with package.json's scripts: a hook that ignore-scripts would silently skip, since
   * `npm run x` still runs `x` but no `prex` or `postx`. `preview` and `preflight` are not hooks:
   * there is no `view` or `flight`.
   */
  function hookProblems(scripts: Record<string, string>): string[] {
    const problems: string[] = [];
    for (const name of Object.keys(scripts)) {
      const hook = /^(pre|post)(.+)$/.exec(name);
      if (INSTALL_SCRIPTS.includes(name)) problems.push(`${name}: npm runs it on install, and ignore-scripts skips it`);
      else if (hook && (Object.hasOwn(scripts, hook[2]!) || EVENTS.includes(hook[2]!))) problems.push(`${name}: a ${hook[1]} hook of ${hook[2]}, which ignore-scripts skips`);
    }
    return problems;
  }

  const workflows = readdirSync(fileURLToPath(new URL('../../.github/workflows/', import.meta.url))).filter((file) => /\.ya?ml$/.test(file));
  const DOCS = ['README.md', 'AGENTS.md', '.claude/skills/new-site/SKILL.md', '.claude/skills/security-sweep/SKILL.md'];
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  test('.npmrc sets ignore-scripts=true', () => {
    expect(npmrcProblems(read('.npmrc'))).toEqual([]);
  });

  test('no workflow, package.json script or doc turns install scripts back on, or rebuilds every package', () => {
    expect(workflows).toContain('ci.yml');
    const problems = [
      ...workflows.flatMap((file) => overrideProblems(`.github/workflows/${file}`, read(`.github/workflows/${file}`))),
      ...Object.entries(scripts).flatMap(([name, command]) => overrideProblems(`package.json scripts.${name}`, command)),
      ...DOCS.filter(exists).flatMap((doc) => overrideProblems(doc, read(doc))),
    ];
    expect(problems).toEqual([]);
  });

  test('package.json has no install, pre or post script for ignore-scripts to skip', () => {
    expect(hookProblems(scripts)).toEqual([]);
  });

  test('refuses an .npmrc without the setting, with it off, overridden later, commented out or under a section', () => {
    expect(npmrcProblems('save-exact=true\nignore-scripts=true\n')).toEqual([]);
    expect(npmrcProblems('save-exact=true\n')).toEqual(['.npmrc does not set ignore-scripts']);
    expect(npmrcProblems('ignore-scripts=false\n')).toEqual(['.npmrc sets ignore-scripts=false']);
    expect(npmrcProblems('ignore-scripts=true\nignore-scripts = false\n')).toEqual(['.npmrc sets ignore-scripts=false']);
    expect(npmrcProblems('# ignore-scripts=true\n')).toEqual(['.npmrc does not set ignore-scripts']);
    expect(npmrcProblems('[x]\nignore-scripts=true\n')).toHaveLength(1);
  });

  test('refuses every way a command turns install scripts back on', () => {
    for (const ok of [
      'npm ci',
      'npm ci --ignore-scripts --userconfig <empty file>',
      'npm ci --ignore-scripts=true',
      "          npm_config_ignore_scripts: 'true'",
      'turn them on with `npm_config_ignore_scripts`, and they run',
      'npm config set save-exact true',
    ]) {
      expect(overrideProblems('x', ok), ok).toEqual([]);
    }
    for (const bad of [
      'npm ci --ignore-scripts=false',
      "npm install --ignore-scripts='false'",
      'npm ci --ignore-scripts false',
      'npm install --no-ignore-scripts',
      "          npm_config_ignore_scripts: 'false'",
      '          NPM_CONFIG_IGNORE_SCRIPTS: 0',
      'npm_config_ignore_scripts= npm ci',
      "$env:npm_config_ignore_scripts = 'false'",
      'echo "npm_config_ignore-scripts=false" >> "$GITHUB_ENV"',
      'npm config set ignore-scripts false',
      'npm set ignore-scripts=false --location=project',
      'npm rebuild',
      'npm ci && npm rb && npm test',
      'npm rebuild esbuild --ignore-scripts=false',
    ]) {
      expect(overrideProblems('x', bad), bad).not.toEqual([]);
    }
    // The one allowed shape: by name, for packages on the allow-list.
    expect(overrideProblems('x', 'npm rebuild esbuild --ignore-scripts=false', ['esbuild'])).toEqual([]);
    expect(overrideProblems('x', 'npm rebuild esbuild sharp --ignore-scripts=false', ['esbuild'])).not.toEqual([]);
    expect(overrideProblems('x', 'npm ci --ignore-scripts=false', ['esbuild'])).toHaveLength(1);
    // The exemption covers the rebuild's own command, never the rest of its line.
    expect(overrideProblems('x', 'npm rebuild esbuild --ignore-scripts=false && npm ci --ignore-scripts=false', ['esbuild'])).toEqual([
      'x:1: --ignore-scripts=false in `npm ci --ignore-scripts=false`',
    ]);
    for (const separator of ['||', ';', '|']) {
      expect(overrideProblems('x', `npm rebuild esbuild --ignore-scripts=false ${separator} npm install --no-ignore-scripts`, ['esbuild']), separator).toHaveLength(1);
    }
  });

  test('refuses a pre or post hook of a script or an npm event, and a script npm runs on install', () => {
    expect(hookProblems({ preview: 'x', preflight: 'x', verify: 'x', 'test:e2e': 'x' })).toEqual([]);
    for (const name of ['preverify', 'postverify', 'pretest', 'postpack', 'prepublishOnly', 'preinstall', 'install', 'postinstall', 'prepare', 'dependencies']) {
      expect(hookProblems({ verify: 'x', [name]: 'x' }), name).toHaveLength(1);
    }
  });
});

describe('b2. install scripts are on an allow-list (an early warning)', () => {
  // Under ignore-scripts none of these runs. The list still flags a new package that declares
  // install-time code, so a dependency update that adds one is looked at, and needs the owner's
  // approval (AGENTS.md "No unapproved dependencies"). It cannot see a binding.gyp package whose
  // manifest says "gypfile": false, which is why b, not this, is the gate.
  const ALLOWED = ['esbuild', 'fsevents', 'workerd'];

  /** Problems when the packages with install scripts are not exactly the allow-list. */
  function installScriptProblems(packages: Record<string, LockEntry>, allowed: string[]): string[] {
    const found = new Set(
      Object.entries(packages)
        .filter(([, entry]) => entry.hasInstallScript)
        .map(([key]) => keyName(key)),
    );
    return [
      ...[...found].filter((n) => !allowed.includes(n)).map((n) => `${n}: install script not allowed`),
      ...allowed.filter((n) => !found.has(n)).map((n) => `${n}: allowed but has no install script`),
    ];
  }

  test('the packages with install scripts are exactly the allow-list', () => {
    expect(installScriptProblems(lock.packages, ALLOWED)).toEqual([]);
  });

  test('refuses a new install-script package, and a stale allow-list entry', () => {
    const packages = { 'node_modules/esbuild': { hasInstallScript: true }, 'node_modules/x/node_modules/sneaky': { hasInstallScript: true } };
    expect(installScriptProblems(packages, ['esbuild'])).toEqual(['sneaky: install script not allowed']);
    expect(installScriptProblems(packages, ['esbuild', 'sneaky', 'gone'])).toEqual(['gone: allowed but has no install script']);
  });
});

describe('c. pre-commit revs are commit SHAs', () => {
  // That a SHA is the commit its tag comment names can't be checked offline: Dependabot's pre-commit
  // updates write both together, and review carries the rest.
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
  /** Problems with the cooldown's ecosystems, or a floor in .npmrc that differs from any cooldown. */
  function floorProblems(npmrc: string, dependabot: string): string[] {
    const days = [...dependabot.matchAll(/^\s*default-days:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    const ecosystems = [...dependabot.matchAll(/package-ecosystem:\s*(\S+)/g)].map((m) => m[1]).sort();
    const problems: string[] = [];
    if (ecosystems.join() !== 'github-actions,npm,pre-commit') problems.push(`ecosystems: ${ecosystems.join()}`);
    if (days.length !== ecosystems.length) problems.push('an ecosystem has no cooldown');
    const floor = /^min-release-age=(\d+)$/m.exec(npmrc);
    if (!floor) problems.push('.npmrc has no min-release-age');
    for (const d of days) if (floor && Number(floor[1]) !== d) problems.push(`min-release-age ${floor[1]} differs from default-days ${d}`);
    return problems;
  }

  const dep = (npm: number, actions: number, hooks: number) =>
    [['npm', npm], ['github-actions', actions], ['pre-commit', hooks]]
      .map(([e, d]) => `  - package-ecosystem: ${e}\n    cooldown:\n      default-days: ${d}\n`)
      .join('');

  test('.npmrc min-release-age equals every default-days, for all three ecosystems', () => {
    expect(floorProblems(read('.npmrc'), read('.github/dependabot.yml'))).toEqual([]);
  });

  test('refuses a mismatched floor, a mismatched cooldown, a missing floor and a missing ecosystem', () => {
    expect(floorProblems('min-release-age=7\n', dep(7, 7, 7))).toEqual([]);
    expect(floorProblems('min-release-age=3\n', dep(7, 7, 7))).toHaveLength(3);
    expect(floorProblems('min-release-age=7\n', dep(7, 7, 14))).toHaveLength(1);
    expect(floorProblems('save-exact=true\n', dep(7, 7, 7))).toEqual(['.npmrc has no min-release-age']);
    expect(floorProblems('min-release-age=7\n', dep(7, 7, 7).split('  - package-ecosystem: pre-commit')[0])).not.toEqual([]);
  });
});
