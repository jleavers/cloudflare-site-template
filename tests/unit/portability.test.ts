import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const CONTACT = fileURLToPath(new URL('../../src/contact/', import.meta.url));
const files = readdirSync(CONTACT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath, entry.name));

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

test('src/contact has files to check', () => {
  expect(files.length).toBeGreaterThan(5);
});

// Contract C6: the handler can be lifted onto any host that speaks Request/Response.
test.each(files.map((file) => [relative(CONTACT, file), file]))('%s imports only from inside src/contact', (_name, file) => {
  for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    expect(specifier, `${specifier} is not a relative import`).toMatch(/^\.\.?\//);
    const target = resolve(dirname(file), specifier);
    expect(relative(CONTACT, target).startsWith('..'), `${specifier} leaves src/contact`).toBe(false);
  }
});
