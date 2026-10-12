import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { checkPreflight, type WranglerConfig } from './rules';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

test('this checkout may be deployed', () => {
  const wrangler = parse(readFileSync(root('wrangler.jsonc'), 'utf8')) as WranglerConfig;
  const result = checkPreflight({
    wrangler,
    site,
    designPresent: existsSync(root('design/SOURCE.md')) || existsSync(root('design/bundle')),
  });
  console.info(`preflight: ${result.mode} mode${result.mode === 'demo' ? ' (workers.dev only)' : ''}`);
  for (const note of result.notes) console.info(`  still the template's: ${note}`);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  expect(result.errors, `\n${result.errors.map((error) => `  - ${error}`).join('\n')}\n`).toEqual([]);
});
