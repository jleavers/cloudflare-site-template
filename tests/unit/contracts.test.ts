import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { codeLoadingDirective } from '../../tools/design-ingest/ingest.mjs';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// C3: no client frameworks or component libraries.
const FORBIDDEN_PACKAGE = /^(?:react|react-dom|vue|svelte|preact|solid-js|alpinejs|@astrojs\/(?:react|vue|svelte|preact|solid-js|alpinejs)|@mui\/.*)$/;
export const forbiddenPackages = (pkg: { dependencies?: object; devDependencies?: object }) =>
  [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter((name) => FORBIDDEN_PACKAGE.test(name));

// C1: colours come from the @theme tokens, never Tailwind's default palette.
export const DEFAULT_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|accent|caret|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/;

function astroFiles(dir: string): string[] {
  return readdirSync(root(dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? astroFiles(`${dir}/${entry.name}`) : entry.name.endsWith('.astro') ? [`${dir}/${entry.name}`] : [],
  );
}

describe('C3: no client frameworks', () => {
  test('package.json depends on none', () => {
    expect(forbiddenPackages(JSON.parse(readFileSync(root('package.json'), 'utf8')))).toEqual([]);
  });

  test('the check bites', () => {
    for (const name of ['react', 'react-dom', 'vue', 'svelte', 'preact', 'solid-js', 'alpinejs', '@astrojs/preact', '@mui/material']) {
      expect(forbiddenPackages({ dependencies: { astro: '1.0.0' }, devDependencies: { [name]: '1.0.0' } }), name).toEqual([name]);
    }
    expect(forbiddenPackages({ dependencies: { astro: '1.0.0', '@astrojs/sitemap': '1.0.0' } })).toEqual([]);
  });
});

describe('C1: colours are tokens', () => {
  test('the pattern recognises default-palette utilities', () => {
    for (const bad of ['bg-white', 'bg-white/60', 'text-red-800', 'border-slate-200', 'hover:bg-black']) expect(bad).toMatch(DEFAULT_PALETTE);
    for (const good of ['bg-surface', 'text-error', 'border-line', 'bg-surface/60', 'text-brand']) expect(good).not.toMatch(DEFAULT_PALETTE);
  });

  test.each([...astroFiles('src/components'), ...astroFiles('src/pages')])('%s uses no default-palette colour', (file) => {
    expect(readFileSync(root(file), 'utf8')).not.toMatch(DEFAULT_PALETTE);
  });
});

// Tailwind 4 scans from the project root unless told otherwise, so class-like strings in design/,
// docs/ and plans would add CSS to every page.
describe('Tailwind source detection', () => {
  test('is limited to src/', () => {
    const css = readFileSync(root('src/styles/global.css'), 'utf8');
    const match = css.match(/@import\s+["']tailwindcss["']\s+source\(\s*["']([^"']+)["']\s*\)/);
    expect(match, '@import "tailwindcss" has no source("…")').not.toBeNull();
    expect(resolve(root('src/styles'), match![1])).toBe(resolve(root('src')));
  });
});

// Tailwind 4 reads its configuration from CSS. `@plugin` and `@config` make every build, CI's
// `verify` included, import and run a JavaScript module (tailwindcss 4.3.3 hands both to
// @tailwindcss/node's loadModule). @tailwindcss/vite 4.3.3 compiles every `.css` module the build
// imports, wherever it lives, and every `<style>` block of an `.astro` file (its
// `?astro&type=style&lang.css` request); a stylesheet's `@import` and `@reference` inline a file of
// any type. A design that uses a Tailwind plugin is no reason to add one (new-site SKILL.md).
//
// The modules a stylesheet may load, each as `@plugin "<name>";` or `@config "<name>";` exactly.
// Empty in the template. The owner adds a name here only after adding its package properly
// (AGENTS.md "No unapproved dependencies"), never because a design names it.
const APPROVED_TAILWIND_MODULES: readonly string[] = [];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** The code-loading directive left in `text` once every approved one, spelled exactly, is taken out (the ingest tool's match). */
export function unapprovedDirective(text: string, stylesheet: boolean, approved: readonly string[] = APPROVED_TAILWIND_MODULES) {
  let rest = text;
  for (const name of approved) rest = rest.replace(new RegExp(String.raw`@(?:plugin|config)[ \t]+(["'])${escapeRegExp(name)}\1[ \t]*;`, 'g'), '');
  return codeLoadingDirective(new TextEncoder().encode(rest), { stylesheet });
}

/** The contents of an `.astro` file's `<style>` blocks. */
export const styleBlocks = (text: string) => [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1] ?? '');
/** The relative paths a stylesheet `@import`s or `@reference`s, quoted or in `url()`. */
export const cssReferences = (text: string) => [...text.matchAll(/@(?:import|reference)\s*(?:url\(\s*)?["']?(\.{1,2}\/[^"'()\s;]+)/gi)].map((match) => match[1] ?? '');
/** The relative `.css` paths a module names in quotes, as `import './x.css'` does. */
export const moduleCss = (text: string) => [...text.matchAll(/["'](\.{1,2}\/[^"'\s]+\.css)(?:\?[^"']*)?["']/g)].map((match) => match[1] ?? '');

function filesUnder(base: string, dir: string): string[] {
  return readdirSync(join(base, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(base, `${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
}

/**
 * What the build reads as CSS: every `.css` file under src/, every `<style>` block of an `.astro`
 * file there, every `.css` file a src/ module imports by a relative path, wherever it is, and every
 * file those stylesheets `@import` or `@reference`, of any type, followed until none is new.
 */
export function buildStylesheets(base = root('')) {
  const found: { label: string; text: string; stylesheet: boolean }[] = [];
  const seen = new Set<string>();
  const queue: { text: string; dir: string }[] = [];
  const follow = (path: string) => {
    if (seen.has(path) || !existsSync(path) || !statSync(path).isFile()) return;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    found.push({ label: relative(base, path).split('\\').join('/'), text, stylesheet: path.endsWith('.css') });
    queue.push({ text, dir: dirname(path) });
  };
  for (const file of filesUnder(base, 'src')) {
    const path = join(base, file);
    if (file.endsWith('.css')) follow(path);
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('.astro')) {
      for (const [index, block] of styleBlocks(text).entries()) {
        found.push({ label: `${file} <style> ${index + 1}`, text: block, stylesheet: true });
        queue.push({ text: block, dir: dirname(path) });
      }
    }
    if (/\.(?:astro|[cm]?[jt]sx?|mdx?)$/.test(file)) for (const css of moduleCss(text)) follow(resolve(dirname(path), css));
  }
  for (let next = queue.shift(); next; next = queue.shift()) for (const css of cssReferences(next.text)) follow(resolve(next.dir, css));
  return found;
}

describe('no CSS directive that loads code reaches the build unless approved', () => {
  const stylesheets = buildStylesheets();

  test('the walk finds the template stylesheet', () => {
    expect(stylesheets.map((sheet) => sheet.label)).toContain('src/styles/global.css');
  });

  test.each(stylesheets.map((sheet) => [sheet.label, sheet] as const))('%s loads no unapproved module', (_label, sheet) => {
    expect(unapprovedDirective(sheet.text, sheet.stylesheet), 'a @plugin or @config the owner has not approved: see APPROVED_TAILWIND_MODULES in this file').toBeNull();
  });

  test('the check bites, with the ingest tool’s match', () => {
    for (const css of ['@plugin "./brand.js";', "@config './theme.js';", '@PLUGIN "./brand.js";', '@/* x */plugin "./brand.js";', '@plu/**/gin "./brand.js";', '/* @config "./theme.js"; */']) {
      expect(unapprovedDirective(css, true), css).not.toBeNull();
    }
    expect(unapprovedDirective('@\\70 lugin "./brand.js";', true)).toBe('an escaped at-keyword');
    expect(unapprovedDirective('@import "tailwindcss" source("..");\n@theme { --color-brand: #2f5d46; }\n', true)).toBeNull();
  });

  test('an approved module passes only as `@plugin "<name>";` or `@config "<name>";`', () => {
    const approved = ['@tailwindcss/typography'];
    expect(unapprovedDirective('@plugin "@tailwindcss/typography";', true, approved)).toBeNull();
    expect(unapprovedDirective("@import 'tailwindcss';\n@plugin '@tailwindcss/typography' ;\n", true, approved)).toBeNull();
    for (const css of ['@plugin "@tailwindcss/forms";', '@PLUGIN "@tailwindcss/typography";', '@plugin "@tailwindcss/typography" { className: x; }', '@plugin "@tailwindcss/typographyx";', '@plugin "@tailwindcss/typography";\n@plugin "./brand.js";']) {
      expect(unapprovedDirective(css, true, approved), css).toBe('@plugin');
    }
  });

  test('the walk follows a <style> block, a stylesheet a module imports from outside src/, and what they @import', () => {
    const base = mkdtempSync(join(tmpdir(), 'contracts-css-'));
    const files: Record<string, string> = {
      'src/pages/index.astro': "---\nimport '../../outside/theme.css';\n---\n<h1>Hi</h1>\n<style>\n  @import './local.css';\n  @config './theme.js';\n</style>\n",
      'src/pages/local.css': 'a { color: red }\n',
      'src/styles/global.css': '@import "tailwindcss";\n@import "../../outside/notes.txt";\n',
      'outside/theme.css': '@reference "./deeper.md";\n',
      'outside/deeper.md': '@plugin "./brand.js";\n',
      'outside/notes.txt': 'nothing here\n',
      'outside/unread.css': '@plugin "./brand.js";\n',
    };
    let sheets: ReturnType<typeof buildStylesheets>;
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(base, path)), { recursive: true });
        writeFileSync(join(base, path), text);
      }
      sheets = buildStylesheets(base);
    } finally {
      for (const path of Object.keys(files)) if (existsSync(join(base, path))) unlinkSync(join(base, path));
      for (const dir of ['src/pages', 'src/styles', 'src', 'outside', '']) if (existsSync(join(base, dir))) rmdirSync(join(base, dir));
    }
    expect(sheets.map((sheet) => sheet.label).sort()).toEqual(['outside/deeper.md', 'outside/notes.txt', 'outside/theme.css', 'src/pages/index.astro <style> 1', 'src/pages/local.css', 'src/styles/global.css']);
    const flagged = sheets.filter((sheet) => unapprovedDirective(sheet.text, sheet.stylesheet)).map((sheet) => sheet.label).sort();
    expect(flagged).toEqual(['outside/deeper.md', 'src/pages/index.astro <style> 1']);
  });

  test('the walk reads <style> blocks, imported stylesheets and what they @import', () => {
    expect(styleBlocks('<div /><style>a { b: c }</style>\n<STYLE is:global lang="css">\n@plugin "x";\n</style >')).toEqual(['a { b: c }', '\n@plugin "x";\n']);
    expect(cssReferences('@import "./a.css";\n@import url(../b.css) layer(x);\n@reference \'./c.txt\';\n@import "tailwindcss";')).toEqual(['./a.css', '../b.css', './c.txt']);
    expect(moduleCss("import '../styles/global.css';\nimport x from \"../../design/bundle/app.css?inline\";\nimport y from './y.js';")).toEqual(['../styles/global.css', '../../design/bundle/app.css']);
  });
});
