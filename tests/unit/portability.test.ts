import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { moduleReferences, portabilityProblems } from './module-references';

const CONTACT = fileURLToPath(new URL('../../src/contact/', import.meta.url));
const entries = readdirSync(CONTACT, { recursive: true, withFileTypes: true });
// Every extension TypeScript and the bundlers load as a module, not only .ts.
const files = entries.filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));

// Strings and comments in one pass, so a `//` inside a string (a URL) is not mistaken for a comment.
const STRINGS_AND_COMMENTS = /(['"`])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const stripComments = (source: string) => source.replace(STRINGS_AND_COMMENTS, (m, quote) => (quote ? m : ''));
const blankStrings = (source: string) => stripComments(source).replace(STRINGS_AND_COMMENTS, (m) => m[0] + m[0]);

// Identifiers only: not `a.Buffer`, not `preprocess`, not text inside strings or comments.
const NODE_GLOBALS = /(?<![\w$.])(Buffer\b|process\.|__dirname\b|__filename\b|require\()/g;

function nodeGlobalsIn(source: string): string[] {
  return [...blankStrings(source).matchAll(NODE_GLOBALS)].map((match) => match[1]);
}

const specifiersOf = (source: string, fileName = 'fixture.ts') => moduleReferences(source, fileName).map((reference) => reference.specifier);
const FIXTURE = join(CONTACT, 'fixture.ts');
const problemsIn = (source: string, file = FIXTURE) => portabilityProblems(source, file, CONTACT);

test('src/contact has files to check', () => {
  expect(files.length).toBeGreaterThan(5);
});

// A symbolic link would put a file from anywhere behind a path inside src/contact.
test('src/contact has no symbolic links', () => {
  expect(entries.filter((entry) => entry.isSymbolicLink()).map((entry) => join(entry.parentPath, entry.name))).toEqual([]);
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

  // The forms the regex missed, and the rest of what the compiler reads as a module reference.
  test.each([
    ['a backtick import()', 'const { env } = await import(`cloudflare:workers`);', 'cloudflare:workers'],
    ['a backtick require()', 'const x = require(`x`);', 'x'],
    ['a type-only import() type', "type T = import('node:fs').Stats;", 'node:fs'],
    ['a typeof import() type', "type T = typeof import('node:fs');", 'node:fs'],
    ['an import() with a space before its parenthesis', "const m = await import ('m-pkg');", 'm-pkg'],
    ['import = require()', "import fs = require('node:fs');", 'node:fs'],
    ['export * as', "export * as fs from 'node:fs';", 'node:fs'],
    ['export type', "export type { T } from 't-pkg';", 't-pkg'],
    ['a triple-slash types reference', '/// <reference types="node" />\nexport {};', 'node'],
    ['a triple-slash path reference', '/// <reference path="../worker.ts" />\nexport {};', '../worker.ts'],
    ['import.meta.glob()', "const all = import.meta.glob('../config/*.ts');", '../config/*.ts'],
    ['an escaped string', String.raw`import x from '.\x2e/config/site';`, '../config/site'],
  ])('find %s', (_name, source, specifier) => {
    expect(specifiersOf(source)).toEqual([specifier]);
  });

  test.each([
    ['a JSDoc import() type', "/** @type {import('node:fs').Stats} */\nlet s;", 'node:fs'],
    ['a JSDoc @import', "/** @import { Stats } from 'node:fs' */\nlet s;", 'node:fs'],
  ])('find %s in a .js file', (_name, source, specifier) => {
    expect(specifiersOf(source, 'fixture.js')).toEqual([specifier]);
  });

  test.each([
    ['an identifier', 'const m = await import(name);'],
    ['a template with a substitution', 'const m = await import(`./providers/${name}`);'],
    ['a concatenation', "const m = await import('./a' + '.ts');"],
    ['a require() of an identifier', 'const r = require(name);'],
    ['import() with nothing', 'const m = await import();'],
  ])('find %s as a module named by no string literal', (_name, source) => {
    expect(specifiersOf(source)).toEqual([undefined]);
  });

  test('ignore specifiers that only appear in comments or strings', () => {
    expect(specifiersOf("// import x from 'y'\n/* import 'z'; require('w') */\nconst ok = 1;")).toEqual([]);
    expect(specifiersOf("const s = \"import('node:fs')\"; const t = `require('x')`; o.require('y');")).toEqual([]);
  });

  test('flag Node-only globals, but not words that merely contain them', () => {
    expect(nodeGlobalsIn("const b = Buffer.from('x');")).toEqual(['Buffer']);
    expect(nodeGlobalsIn("const r = require('x');")).toEqual(['require(']);
    expect(nodeGlobalsIn('const p = process.env.X; __dirname; __filename')).toEqual(['process.', '__dirname', '__filename']);
    expect(nodeGlobalsIn('// Buffer.from and process.env are fine in prose\nconst preprocess = 1; const x = a.Buffer;')).toEqual([]);
  });
});

describe('portabilityProblems refuses', () => {
  test.each([
    // The rows the sweep found passing (run 20261028T185449Z, cluster 2).
    ['a backtick import() of cloudflare:workers', 'const { env } = await import(`cloudflare:workers`);'],
    ['a backtick require()', 'const x = require(`x`);'],
    ['import() of an identifier', 'const m = await import(name);'],
    ['a template with a substitution', 'const m = await import(`./providers/${name}`);'],
    ['a type-only import() of node:fs', "type T = import('node:fs').Stats;"],
    ['a backtick import() that leaves src/contact', 'export const loadSite = () => import(`../config/site`);'],
    ['a concatenation', "const m = await import('./a' + '.ts');"],
    ['an import() with a space before its parenthesis', "const m = await import ('node:fs');"],
    ['import = require()', "import fs = require('node:fs');"],
    ['export * as from a package', "export * as fs from 'node:fs';"],
    ['a triple-slash types reference', '/// <reference types="node" />\nexport {};'],
    ['a triple-slash path out of src/contact', '/// <reference path="../worker.ts" />\nexport {};'],
    ['import.meta.glob() out of src/contact', "const all = import.meta.glob('../config/*.ts');"],
    ['a quoted import out of src/contact', "import { site } from '../config/site';"],
    // A file the compiler cannot parse hides what follows the error (20r round 1).
    ['an unterminated template literal before an import()', "const s = `abc\nconst m = await import('node:fs');"],
    ['an unterminated comment before an import()', "/* abc\nconst m = await import('node:fs');"],
    ['a syntax error before an import()', "const x = ;\nconst m = await import('./ok');"],
  ])('%s', (_name, source) => {
    expect(problemsIn(source)).not.toEqual([]);
  });

  test('names the file, the line and what it found', () => {
    expect(problemsIn('const ok = 1;\nconst m = await import(name);')).toEqual(['fixture.ts:2: import() names its module with name, not a string literal']);
    expect(problemsIn("const ok = 1;\n\nimport { site } from '../config/site';")).toEqual(['fixture.ts:3: ../config/site leaves src/contact']);
    expect(problemsIn('const ok = 1;\nconst x = require(`x`);')).toEqual(['fixture.ts:2: x is not a relative import']);
    expect(problemsIn('const ok = 1;\nconst s = `abc;')).toEqual(['fixture.ts:2: the compiler cannot parse this file: Unterminated template literal.']);
  });
});

describe('portabilityProblems allows', () => {
  test.each([
    ['relative imports of every form', "import { a } from './a';\nimport type { B } from './providers/types';\nexport * from './b';\nconst c = await import('./c');\ntype D = import('./d').D;", FIXTURE],
    ['a backtick import() inside src/contact', 'const e = await import(`./providers/log`);', FIXTURE],
    ['a path that leaves and comes back', "import { x } from '../contact/x';", FIXTURE],
    ['a nested file importing its parent', "import { y } from '../http';", join(CONTACT, 'providers', 'fixture.ts')],
  ])('%s', (_name, source, file) => {
    expect(problemsIn(source, file)).toEqual([]);
  });
});

// Contract C6: the handler can be lifted onto any host that speaks Request/Response.
describe('C6 portability', () => {
  test.each(files.map((file) => [relative(CONTACT, file), file]))('%s imports only from inside src/contact', (_name, file) => {
    expect(portabilityProblems(readFileSync(file, 'utf8'), file, CONTACT)).toEqual([]);
  });

  test.each(files.map((file) => [relative(CONTACT, file), file]))('%s uses no Node-only globals', (_name, file) => {
    expect(nodeGlobalsIn(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
