import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CONTACT = fileURLToPath(new URL('../../src/contact/', import.meta.url));
const files = readdirSync(CONTACT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

// Strings and comments in one pass, so a `//` inside a string (a URL) is not mistaken for a comment.
const STRINGS_AND_COMMENTS = /(['"`])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const stripComments = (source: string) => source.replace(STRINGS_AND_COMMENTS, (m, quote) => (quote ? m : ''));
const blankStrings = (source: string) => stripComments(source).replace(STRINGS_AND_COMMENTS, (m) => m[0] + m[0]);

const SPECIFIER =
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source: string): string[] {
  return [...stripComments(source).matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
}

// Identifiers only: not `a.Buffer`, not `preprocess`, not text inside strings or comments.
const NODE_GLOBALS = /(?<![\w$.])(Buffer\b|process\.|__dirname\b|__filename\b|require\()/g;

function nodeGlobalsIn(source: string): string[] {
  return [...blankStrings(source).matchAll(NODE_GLOBALS)].map((match) => match[1]);
}

test('src/contact has files to check', () => {
  expect(files.length).toBeGreaterThan(5);
});

describe('the matchers themselves', () => {
  test('find every import form', () => {
    const source = [
      "import a from 'a-pkg';",
      "import { b } from './b';",
      "import type { C } from '../c';",
      "export { d } from 'd-pkg';",
      "export * from './e';",
      "import 'node:fs';",
      "const f = await import('f-pkg');",
      "const g = require('g-pkg');",
    ].join('\n');
    expect(specifiersOf(source).sort()).toEqual(['../c', './b', './e', 'a-pkg', 'd-pkg', 'f-pkg', 'g-pkg', 'node:fs']);
  });

  test('ignore specifiers that only appear in comments', () => {
    expect(specifiersOf("// import x from 'y'\n/* import 'z'; require('w') */\nconst ok = 1;")).toEqual([]);
  });

  test('flag Node-only globals, but not words that merely contain them', () => {
    expect(nodeGlobalsIn("const b = Buffer.from('x');")).toEqual(['Buffer']);
    expect(nodeGlobalsIn("const r = require('x');")).toEqual(['require(']);
    expect(nodeGlobalsIn('const p = process.env.X; __dirname; __filename')).toEqual(['process.', '__dirname', '__filename']);
    expect(nodeGlobalsIn('// Buffer.from and process.env are fine in prose\nconst preprocess = 1; const x = a.Buffer;')).toEqual([]);
  });
});

// Contract C6: the handler can be lifted onto any host that speaks Request/Response.
describe('C6 portability', () => {
  test.each(files.map((file) => [relative(CONTACT, file), file]))('%s imports only from inside src/contact', (_name, file) => {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      expect(specifier, `${specifier} is not a relative import`).toMatch(/^\.\.?\//);
      const target = resolve(dirname(file), specifier);
      expect(relative(CONTACT, target).startsWith('..'), `${specifier} leaves src/contact`).toBe(false);
    }
  });

  test.each(files.map((file) => [relative(CONTACT, file), file]))('%s uses no Node-only globals', (_name, file) => {
    expect(nodeGlobalsIn(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
