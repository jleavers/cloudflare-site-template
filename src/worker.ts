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
    return env.ASSETS.fetch(request);
  },
};
