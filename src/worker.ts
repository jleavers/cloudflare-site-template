import type { ContactEnv } from './contact/config';
import { handleContact } from './contact/handler';
import { json } from './contact/http';

/**
 * The only Cloudflare-specific code in the repository. It routes /api/* to the portable handler
 * in src/contact/ and everything else to the static assets in dist/ (wrangler.jsonc). Its Env
 * type is written out by hand so that no Workers type package is needed.
 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  [name: string]: unknown;
}

/** Worker vars and secrets are strings; bindings such as ASSETS are not, and stay behind. */
function stringSettings(env: Env): ContactEnv {
  const settings: ContactEnv = {};
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string') settings[name] = value;
  return settings;
}

/**
 * wrangler.jsonc sets not_found_handling "none", so a miss reaches this Worker as a bare 404. It
 * answers with the built 404 page, still a 404, and `no-store`: _headers matches by path, so
 * left to the asset layer a missing /_astro/ file would be cached as immutable for a year.
 */
async function notFound(request: Request, env: Env): Promise<Response> {
  // A fresh GET: the visitor's conditional and Range headers must not turn the page into a 304 or 206.
  const forwarded = new Headers();
  const encoding = request.headers.get('Accept-Encoding');
  if (encoding) forwarded.set('Accept-Encoding', encoding);
  const page = await env.ASSETS.fetch(new Request(new URL('/404', request.url), { headers: forwarded }));
  // Whatever happens, a miss is a 404 that is never stored.
  if (page.status !== 200) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const headers = new Headers(page.headers);
  headers.set('Cache-Control', 'no-store'); // never the asset layer's rule for this path
  headers.delete('Content-Length'); // the runtime sets it for the new body
  return new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (pathname.replace(/\/+$/, '') === '/api/contact') {
        if (request.method !== 'POST') return json(405, { ok: false, message: 'Method not allowed.' }, { Allow: 'POST' });
        // A wrapper, not the bare global: some runtimes reject fetch called without its global as `this`.
        return handleContact(request, stringSettings(env), { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) });
      }
      return json(404, { ok: false, message: 'Not found.' });
    }
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    return notFound(request, env);
  },
};
