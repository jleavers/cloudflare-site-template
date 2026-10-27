import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterAll, describe, expect, test } from 'vitest';
import { PREVIEW_SETTINGS, exactVersion, parseJsonc, previewConfig, refuseBuild } from '../../scripts/trusted-config.mjs';
import { WRANGLER_API, removeTree, sandboxEnv } from './wrangler-sandbox';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8');

describe('parseJsonc', () => {
  test('drops line and block comments', () => {
    expect(parseJsonc('{\n  // the name\n  "name": "a", /* inline */ "n": 1\n}')).toEqual({ name: 'a', n: 1 });
  });

  test('keeps comment markers inside strings, and an escaped quote does not end one', () => {
    expect(parseJsonc('{ "url": "https://example.com/a/*b*/", "s": "say \\"hi\\" // still a string" }')).toEqual({
      url: 'https://example.com/a/*b*/',
      s: 'say "hi" // still a string',
    });
  });

  test('drops trailing commas in objects and arrays, also before a comment', () => {
    expect(parseJsonc('{ "a": [1, 2, /* end */ ], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  test.each([
    ['an unclosed object', '{'],
    ['plain text', 'not json'],
    ['text after the value', '{ "a": 1 } trailing'],
    ['an unterminated block comment', '{ "a": 1 } /* never closed'],
    ['single quotes', "{ 'a': 1 }"],
    // wrangler's parser reads a comment as a token break, so this is two numbers, not 12.
    ['two values joined by a comment', '[1/**/2]'],
    ['nothing', ''],
  ])('throws on %s', (_name, text) => expect(() => parseJsonc(text)).toThrow());
});

describe('refuseBuild', () => {
  test('refuses a top-level build', () => {
    expect(() => refuseBuild({ name: 'a', build: { command: 'make' } })).toThrow(/build/);
  });

  test('refuses a build in an environment', () => {
    expect(() => refuseBuild({ name: 'a', env: { staging: { build: { command: 'make' } } } })).toThrow(/env\.staging\.build/);
  });

  test('refuses a build key spelt with a JSON escape', () => {
    expect(() => refuseBuild(parseJsonc('{ "name": "a", "\\u0062uild": { "command": "make" } }'))).toThrow(/build/);
  });

  test('refuses a __proto__ key, which wrangler\'s parser reads as an inherited build', () => {
    const text = '{ "name": "a", "__proto__": { "build": { "command": "make" } } }';
    expect((parse(text) as { build?: unknown }).build).toEqual({ command: 'make' });
    expect(() => refuseBuild(parseJsonc(text))).toThrow(/__proto__/);
  });

  test('accepts a config without a build', () => {
    expect(() => refuseBuild({ name: 'a', env: { staging: { name: 'b' } }, assets: { directory: './dist' } })).not.toThrow();
  });
});

describe('exactVersion', () => {
  test('returns an exact x.y.z version', () => {
    expect(exactVersion({ devDependencies: { wrangler: '4.149.0' } }, 'wrangler')).toBe('4.149.0');
  });

  test.each([
    ['a caret range', '^4.149.0'],
    ['a dist-tag', 'latest'],
    ['a file path', 'file:../x'],
    ['a git URL', 'git+https://github.com/cloudflare/workers-sdk.git'],
    ['a version with a second output line', '4.149.0\nwrangler-version=1.0.0'],
  ])('refuses %s', (_name, version) => {
    expect(() => exactVersion({ devDependencies: { wrangler: version } }, 'wrangler')).toThrow(/exact/);
  });

  test('refuses a missing entry', () => {
    expect(() => exactVersion({ devDependencies: {} }, 'wrangler')).toThrow(/exact/);
    expect(() => exactVersion({}, 'wrangler')).toThrow(/exact/);
  });
});

describe("the repository's own config", () => {
  test('wrangler.jsonc parses as wrangler parses it, and has no build', () => {
    const text = read('wrangler.jsonc');
    expect(parseJsonc(text)).toEqual(parse(text));
    expect(() => refuseBuild(parseJsonc(text))).not.toThrow();
  });
});

// The config the preview job hands wrangler (sweep 20261027T190359Z, cluster 1). What wrangler then
// uploads with it is tests/unit/preview-upload.test.ts.
describe('previewConfig', () => {
  const repo = () => parseJsonc(read('wrangler.jsonc')) as Record<string, unknown>;
  const base = { name: 'a', main: 'src/worker.ts', assets: { directory: './dist' }, previews: { vars: { A: 'b' } } };

  test('turns off bundling, source maps and additional modules', () => {
    expect(PREVIEW_SETTINGS).toEqual({ no_bundle: true, upload_source_maps: false, find_additional_modules: false });
  });

  test("is the repository's wrangler.jsonc with those settings, and nothing else changed", () => {
    expect(previewConfig(repo())).toEqual({ ...repo(), ...PREVIEW_SETTINGS });
  });

  test('sets them over whatever the trusted config says', () => {
    expect(previewConfig({ ...base, no_bundle: false, upload_source_maps: true, find_additional_modules: true })).toEqual({ ...base, ...PREVIEW_SETTINGS });
  });

  // The job targets the top-level Worker. With no environment in the file, one that wrangler were
  // told to target (--env, CLOUDFLARE_ENV) would inherit the settings, not an env.*.no_bundle.
  test('drops env, and tsconfig, which only a format guess would read', () => {
    const config = { ...base, tsconfig: 'tsconfig.json', env: { staging: { no_bundle: false, upload_source_maps: true } } };
    expect(previewConfig(config)).toEqual({ ...base, ...PREVIEW_SETTINGS });
  });

  test.each([
    ['./dist'],
    ['dist'],
    ['dist/'],
  ])('accepts %s as the assets directory', (directory) => {
    expect(() => previewConfig({ ...base, assets: { directory } })).not.toThrow();
  });

  test.each([
    ['a top-level build', { build: { command: 'make' } }, /"build"/],
    ['a build in an environment', { env: { staging: { build: { command: 'make' } } } }, /env\.staging\.build/],
    ['previews.no_bundle', { previews: { no_bundle: false } }, /previews\.no_bundle/],
    ['previews.upload_source_maps', { previews: { upload_source_maps: true } }, /previews\.upload_source_maps/],
    ['previews.find_additional_modules', { previews: { find_additional_modules: true } }, /previews\.find_additional_modules/],
    ['previews.build', { previews: { build: { command: 'make' } } }, /previews\.build.*shell/],
    ['previews.define, which only a bundle would apply', { previews: { define: { DEBUG: 'true' } } }, /previews\.define.*bundles/],
    ['previews.containers, whose image can name a Dockerfile in the site', { previews: { containers: [{ class_name: 'C', image: './dist/Dockerfile' }] } }, /previews\.containers/],
    ['a previews block that is not an object', { previews: [] }, /"previews" is not an object/],
    ['an assets directory above the site', { assets: { directory: '..' } }, /assets\.directory/],
    ['an assets directory inside the artifact', { assets: { directory: './dist/../../artifact' } }, /assets\.directory/],
    ['an absolute assets directory', { assets: { directory: '/home/runner/work' } }, /assets\.directory/],
    ['assets without a directory', { assets: { binding: 'ASSETS' } }, /assets\.directory/],
    ['assets that are not an object', { assets: './dist' }, /assets\.directory/],
  ])('refuses %s', (_name, extra, why) => {
    expect(() => previewConfig({ ...base, ...extra })).toThrow(why);
  });

  // An object literal's __proto__ sets its prototype, so these go through the parser, which keeps the key.
  test.each([
    ['at the top level', '{ "name": "a", "__proto__": { "no_bundle": false } }'],
    ['in previews', '{ "name": "a", "previews": { "__proto__": { "define": { "X": "1" } } } }'],
    ['in an environment', '{ "name": "a", "env": { "staging": { "__proto__": { "no_bundle": false } } } }'],
  ])('refuses a __proto__ key %s, which wrangler would read as inherited settings', (_name, text) => {
    expect(() => previewConfig(parseJsonc(text))).toThrow(/__proto__/);
  });

  test('refuses what is not a JSON object', () => {
    for (const value of [null, [], 'x', 1]) expect(() => previewConfig(value)).toThrow(/not a JSON object/);
  });
});

describe('the command line, as the token jobs run it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'trusted-config-'));
  const made: string[] = [];
  const file = (name: string, content: string) => {
    const path = join(scratch, name);
    writeFileSync(path, content);
    made.push(path);
    return path;
  };
  const run = (dir: string, output: string, script = root('scripts/trusted-config.mjs')) =>
    spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
  const pinned = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }).devDependencies.wrangler;
  // A directory whose wrangler.jsonc has a custom build.
  file('wrangler.jsonc', '{ "name": "a", "build": { "command": "make" } }');
  file('package.json', '{ "devDependencies": { "wrangler": "4.149.0" } }');

  afterAll(() => {
    for (const path of made) unlinkSync(path);
    rmdirSync(scratch);
  });

  test('writes the pinned wrangler version for the repository', () => {
    const output = file('repo.out', '');
    const result = run(root('.'), output);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`wrangler-version=${pinned}\n`);
  });

  test('fails with a one-line reason, and writes nothing, for a config with a build', () => {
    const output = file('build.out', '');
    const result = run(scratch, output);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^trusted-config: wrangler\.jsonc: .*build/);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  // Node resolves a symlinked entry to its real path in import.meta.url, but not in process.argv.
  test('runs, and refuses, when called through a symlink', (context) => {
    const link = join(scratch, 'linked-trusted-config.mjs');
    try {
      symlinkSync(root('scripts/trusted-config.mjs'), link);
    } catch (error) {
      // Windows needs Developer Mode or an elevated shell to make a symlink.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    made.push(link);
    const repoOutput = file('linked-repo.out', '');
    const repo = run(root('.'), repoOutput, link);
    expect(repo.status, repo.stderr).toBe(0);
    expect(readFileSync(repoOutput, 'utf8')).toBe(`wrangler-version=${pinned}\n`);
    const buildOutput = file('linked-build.out', '');
    expect(run(scratch, buildOutput, link).status).toBe(1);
    expect(readFileSync(buildOutput, 'utf8')).toBe('');
  });
});

describe('the command line, as the preview job runs it: --preview-config <trusted dir> <file>', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'trusted-config-preview-'));
  const home = join(scratch, 'home');
  let dirs = 0;
  /** A directory holding a wrangler.jsonc with `text`. */
  const trusted = (text: string) => {
    const dir = join(scratch, `trusted-${++dirs}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'wrangler.jsonc'), text);
    return dir;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [root('scripts/trusted-config.mjs'), '--preview-config', ...args], { encoding: 'utf8' });
  let outputs = 0;
  const output = () => join(scratch, `out-${++outputs}.json`);

  afterAll(() => removeTree(scratch));

  /**
   * wrangler's own reading of each file, in a child process whose home is the scratch directory:
   * its parse of the text (experimental_readRawConfig), and the settings it then builds with
   * (unstable_readConfig), for the top-level Worker and for an environment it is told to target.
   */
  function wranglerReads(files: string[]): { raw: unknown; top: Record<string, unknown>; staging: Record<string, unknown> }[] {
    const script = [
      'const wrangler = require(process.argv[1]);',
      'const settings = (args) => {',
      '  const config = wrangler.unstable_readConfig(args, { hideWarnings: true });',
      '  return Object.fromEntries(["no_bundle", "upload_source_maps", "find_additional_modules", "tsconfig"].map((key) => [key, config[key] ?? null]));',
      '};',
      'process.stdout.write(JSON.stringify(process.argv.slice(2).map((config) => ({',
      '  raw: wrangler.experimental_readRawConfig({ config }).rawConfig,',
      '  top: settings({ config }),',
      '  staging: settings({ config, env: "staging" }),',
      '}))));',
    ].join('\n');
    // It starts no process of its own, so a timeout on this one is enough to end a hang.
    const result = spawnSync(process.execPath, ['-e', script, WRANGLER_API, ...files], { encoding: 'utf8', env: sandboxEnv(home), timeout: 30_000, killSignal: 'SIGKILL' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ReturnType<typeof wranglerReads>;
  }
  const BUILT_WITH = { no_bundle: true, upload_source_maps: false, find_additional_modules: false, tsconfig: null };

  test("writes the repository's config as JSON, which wrangler reads back to the same object, and builds with bundling off", () => {
    const file = output();
    const result = run(root('.'), file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^trusted-config: wrote .*no_bundle true, upload_source_maps false, find_additional_modules false/);
    const written = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    expect(written).toEqual(previewConfig(parseJsonc(read('wrangler.jsonc'))));
    const [reading] = wranglerReads([file]);
    expect(reading!.raw).toEqual(written);
    // Told to target an environment, wrangler finds none in the file, and inherits the same settings.
    expect(reading!.top).toEqual(BUILT_WITH);
    expect(reading!.staging).toEqual(BUILT_WITH);
  });

  // Sweep gap 7: wrangler reads the JSON this script wrote, not the trusted JSONC, so a parser
  // differential in the trusted file's comments, escapes or repeated keys reaches neither reading.
  test('wrangler reads exactly what the script checked, whatever the trusted JSONC spells', () => {
    const texts = [
      // Comments, a trailing comma, and markers inside strings.
      '{ /* "no_bundle": false, */ "name": "a", "url": "https://example.com/*x*/", // "upload_source_maps": true\n "assets": { "directory": "./dist", }, }',
      // A key spelt with an escape, and a repeated key: no_bundle, twice, the second false.
      '{ "name": "a", "no\\u005fbundle": false, "no_bundle": false, "upload_source_maps": true, "upload_source_maps": true }',
      // An environment and a tsconfig, which the file leaves out.
      '{ "name": "a", "tsconfig": "tsconfig.json", "env": { "staging": { "no_bundle": false } } }',
    ];
    const files = texts.map((text) => {
      const file = output();
      const result = run(trusted(text), file);
      expect(result.status, result.stderr).toBe(0);
      return file;
    });
    wranglerReads(files).forEach((reading, i) => {
      expect(reading.raw, texts[i]).toEqual(previewConfig(parseJsonc(texts[i]!)));
      expect(reading.top, texts[i]).toEqual(BUILT_WITH);
      expect(reading.staging, texts[i]).toEqual(BUILT_WITH);
    });
  });

  test.each([
    ['previews overriding no_bundle', '{ "name": "a", "previews": { "no_bundle": false } }', /previews\.no_bundle/],
    ['a custom build', '{ "name": "a", "build": { "command": "make" } }', /"build"/],
    ['a __proto__ key', '{ "name": "a", "previews": { "__proto__": { "define": {} } } }', /__proto__/],
    ['another assets directory', '{ "name": "a", "assets": { "directory": "../artifact" } }', /assets\.directory/],
    ['text that is not JSONC', '{ "name": "a" } trailing', /wrangler\.jsonc/],
  ])('writes nothing, and fails with a one-line reason, for %s', (_name, text, why) => {
    const file = output();
    const result = run(trusted(text), file);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^trusted-config: wrangler\.jsonc: /);
    expect(result.stderr.trim()).toMatch(why);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  test('fails, and leaves it alone, if anything is already at the path', (context) => {
    const file = output();
    writeFileSync(file, '{ "no_bundle": false }\n');
    expect(run(root('.'), file).status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('{ "no_bundle": false }\n');
    const target = output();
    writeFileSync(target, 'not to be written through\n');
    const link = output();
    try {
      symlinkSync(target, link);
    } catch (error) {
      // Windows needs Developer Mode or an elevated shell to make a symlink.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    expect(run(root('.'), link).status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('not to be written through\n');
  });

  test.each([
    ['no file', [root('.')]],
    ['no arguments', []],
    ['an extra argument', [root('.'), 'a.json', 'b.json']],
    ['a file wrangler would read as an empty config', [root('.'), 'wrangler.preview']],
    ['a .jsonc file', [root('.'), 'wrangler.jsonc']],
  ])('fails, and writes nothing, given %s', (_name, args) => {
    const result = spawnSync(process.execPath, [root('scripts/trusted-config.mjs'), '--preview-config', ...args], { encoding: 'utf8', cwd: scratch });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^trusted-config: /);
    for (const name of ['a.json', 'b.json', 'wrangler.preview', 'wrangler.jsonc']) expect(existsSync(join(scratch, name)), name).toBe(false);
  });
});
