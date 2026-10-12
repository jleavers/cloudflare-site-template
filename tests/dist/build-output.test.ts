import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('npm run build produced dist/index.html', () => {
  const index = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
  expect(existsSync(index), 'run `npm run build` before `npm run test:dist`').toBe(true);
});
