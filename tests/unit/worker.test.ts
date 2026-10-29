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

describe('worker fallback: a miss is a 404 that is never cached', () => {
  const PAGE = '<h1>Not found</h1>';
  const CSP = "default-src 'self'";
  // With not_found_handling "none" a miss comes back from the asset layer as a bare 404, and the
  // 404 page is a separate asset request. The page carries the _headers rules for its own path.
  function assetsEnv(page: { status: number } = { status: 200 }) {
    const assets = vi.fn(async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/404' && page.status !== 200) return new Response(null, { status: page.status, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
      if (pathname === '/404') {
        return new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'public, max-age=0, must-revalidate' } });
      }
      if (pathname === '/') return new Response('home', { status: 200, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
      if (pathname === '/privacy') return new Response(null, { status: 307, headers: { Location: '/privacy/' } });
      return new Response(null, { status: 404 });
    });
    const value: Env = { ASSETS: { fetch: assets } };
    return { value, assets };
  }

  test.each(['/_astro/does-not-exist.js', '/no-such-page'])('%s is the 404 page, status 404, no-store, headers intact', async (path) => {
    const { value } = assetsEnv();
    const response = await worker.fetch(at(path), value);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });

  test('the visitor\'s conditional and range headers never reach the 404 page fetch', async () => {
    const { value, assets } = assetsEnv();
    const headers = { 'If-None-Match': '"abc"', 'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT', Range: 'bytes=0-9', 'Accept-Encoding': 'gzip' };
    const response = await worker.fetch(at('/_astro/x.js', { headers }), value);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const pageFetch = assets.mock.calls.map(([r]) => r).find((r) => new URL(r.url).pathname === '/404')!;
    expect(pageFetch.method).toBe('GET');
    for (const name of ['If-None-Match', 'If-Modified-Since', 'Range']) expect(pageFetch.headers.has(name)).toBe(false);
    expect(pageFetch.headers.get('Accept-Encoding')).toBe('gzip');
  });

  test.each([404, 304])('when the 404 page fetch is a %i the miss is still a no-store 404', async (status) => {
    const { value } = assetsEnv({ status });
    const response = await worker.fetch(at('/_astro/x.js'), value);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('Content-Length is left to the runtime', async () => {
    const { value } = assetsEnv();
    const response = await worker.fetch(at('/nope'), value);
    expect(response.headers.has('Content-Length')).toBe(false);
  });

  test('a HEAD for a miss is a 404 with no body and no-store', async () => {
    const { value } = assetsEnv();
    const response = await worker.fetch(at('/_astro/x.js', { method: 'HEAD' }), value);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('a response that is not a 404 passes through untouched', async () => {
    const { value } = assetsEnv();
    const ok = await worker.fetch(at('/'), value);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('home');
    expect(ok.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const redirect = await worker.fetch(at('/privacy'), value);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('Location')).toBe('/privacy/');
  });
});
