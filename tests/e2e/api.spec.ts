import { expect, test } from '@playwright/test';

test('GET /api/contact is 405 with Allow: POST', async ({ request }) => {
  const response = await request.get('/api/contact');
  expect(response.status()).toBe(405);
  expect(response.headers()['allow']).toBe('POST');
});

test('a cross-site POST is refused and never cached', async ({ request }) => {
  const response = await request.post('/api/contact', { headers: { Origin: 'https://attacker.example' }, form: { name: 'x' } });
  expect(response.status()).toBe(403);
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('/api/contact/ with a trailing slash reaches the handler', async ({ request }) => {
  const response = await request.post('/api/contact/', { form: { name: 'x' } });
  expect(response.status()).toBe(403);
  expect(response.headers()['content-type']).toContain('application/json');
});
