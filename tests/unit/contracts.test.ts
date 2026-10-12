import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

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
