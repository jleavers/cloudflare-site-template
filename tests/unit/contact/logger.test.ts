import { afterEach, expect, test, vi } from 'vitest';
import { consoleLogger } from '../../../src/contact/logger';

afterEach(() => vi.restoreAllMocks());

test.each([
  ['info', 'log'],
  ['warn', 'warn'],
  ['error', 'error'],
] as const)('%s goes to console.%s as one JSON line', (level, method) => {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  consoleLogger(level, 'hello', { n: 1 });
  expect(spy).toHaveBeenCalledOnce();
  expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ level, message: 'hello', n: 1 });
});
