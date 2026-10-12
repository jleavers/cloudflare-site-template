import { expect, test } from 'vitest';
import { json } from '../../../src/contact/http';

test('json() sets status, JSON body and no-store headers', async () => {
  const response = json(400, { ok: false, message: 'Nope.', errors: { name: 'Required.' } }, { Allow: 'POST' });
  expect(response.status).toBe(400);
  expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Allow')).toBe('POST');
  expect(await response.json()).toEqual({ ok: false, message: 'Nope.', errors: { name: 'Required.' } });
});
