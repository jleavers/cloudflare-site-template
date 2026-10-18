import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterAll, describe, expect, test } from 'vitest';
import { exactVersion, parseJsonc, refuseBuild } from '../../scripts/trusted-config.mjs';

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

describe('the command line, as the token jobs run it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'trusted-config-'));
  const made: string[] = [];
  const file = (name: string, content: string) => {
    const path = join(scratch, name);
    writeFileSync(path, content);
    made.push(path);
    return path;
  };
  const run = (dir: string, output: string) =>
    spawnSync(process.execPath, [root('scripts/trusted-config.mjs'), dir], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });

  afterAll(() => {
    for (const path of made) unlinkSync(path);
    rmdirSync(scratch);
  });

  test('writes the pinned wrangler version for the repository', () => {
    const output = file('repo.out', '');
    const result = run(root('.'), output);
    expect(result.status, result.stderr).toBe(0);
    const pinned = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }).devDependencies.wrangler;
    expect(readFileSync(output, 'utf8')).toBe(`wrangler-version=${pinned}\n`);
  });

  test('fails with a one-line reason, and writes nothing, for a config with a build', () => {
    file('wrangler.jsonc', '{ "name": "a", "build": { "command": "make" } }');
    file('package.json', '{ "devDependencies": { "wrangler": "4.149.0" } }');
    const output = file('build.out', '');
    const result = run(scratch, output);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^trusted-config: wrangler\.jsonc: .*build/);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
});
