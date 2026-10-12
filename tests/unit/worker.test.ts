import { describe, expect, test, vi } from 'vitest';
import worker, { type Env } from '../../src/worker';

function env(extra: Record<string, string> = {}) {
  const assets = vi.fn(async (_request: Request) => new Response('asset', { status: 200 }));
  const value: Env = { ASSETS: { fetch: assets }, DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: 's', ...extra };
  return { value, assets };
}

const at = (path: string, init?: RequestInit) => new Request(`https://www.example.org${path}`, init);

describe('worker routing', () => {
  test.each(['/', '/privacy/', '/no-such-page', '/apiary'])('%s goes to the static assets', async (path) => {
    const { value, assets } = env();
    const response = await worker.fetch(at(path), value);
    expect(await response.text()).toBe('asset');
    expect(assets).toHaveBeenCalledOnce();
  });

  // A POST with no Origin is answered 403 by the handler before any network call, which is how
  // these tests prove the request reached the handler without stubbing the global fetch.
  test.each(['/api/contact', '/api/contact/'])('POST %s reaches the handler', async (path) => {
    const { value, assets } = env();
    const response = await worker.fetch(at(path, { method: 'POST', body: new FormData() }), value);
    expect(response.status).toBe(403);
    expect(assets).not.toHaveBeenCalled();
  });

  test.each(['GET', 'PUT', 'DELETE'])('%s /api/contact is 405 with Allow: POST', async (method) => {
    const { value } = env();
    const response = await worker.fetch(at('/api/contact', { method }), value);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  test.each(['/api', '/api/', '/api/other'])('%s is a JSON 404, not the asset 404 page', async (path) => {
    const { value, assets } = env();
    const response = await worker.fetch(at(path, { method: 'POST' }), value);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(assets).not.toHaveBeenCalled();
  });
});
