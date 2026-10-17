import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { checkPreflight, findPlaceholders, type WranglerConfig } from './rules';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Every [placeholder] in the built pages under dist/. With no dist/, production mode must be told to build; demo mode gets a note. */
function collectPlaceholders(): { placeholders: { page: string; text: string }[]; missingDist: boolean } {
  const dist = root('dist');
  if (!existsSync(dist)) return { placeholders: [], missingDist: true };
  const pages = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.html'));
  const placeholders = pages.flatMap((entry) => {
    const file = join(entry.parentPath, entry.name);
    return findPlaceholders(readFileSync(file, 'utf8')).map((text) => ({ page: relative(dist, file).split(sep).join('/'), text }));
  });
  return { placeholders, missingDist: false };
}

test('this checkout may be deployed', () => {
  const wrangler = parse(readFileSync(root('wrangler.jsonc'), 'utf8')) as WranglerConfig;
  const { placeholders, missingDist } = collectPlaceholders();
  const result = checkPreflight({
    wrangler,
    site,
    placeholders,
    designPresent: existsSync(root('design/SOURCE.md')) || existsSync(root('design/bundle')),
  });
  if (missingDist) {
    if (result.mode === 'production') result.errors.push('dist/ is missing: run `npm run build` first, so preflight can check the built pages for placeholders');
    else result.notes.push('dist/ is missing, so the built pages were not checked for [placeholders]: run `npm run build` first');
  }
  console.info(`preflight: ${result.mode} mode${result.mode === 'demo' ? ' (workers.dev only)' : ''}`);
  for (const note of result.notes) console.info(`  still the template's: ${note}`);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  expect(result.errors, `\n${result.errors.map((error) => `  - ${error}`).join('\n')}\n`).toEqual([]);
});
