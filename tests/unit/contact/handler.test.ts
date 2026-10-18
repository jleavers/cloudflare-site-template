import { describe, expect, test, vi } from 'vitest';
import { handleContact, MAX_BODY_BYTES } from '../../../src/contact/handler';
import type { Logger } from '../../../src/contact/logger';
import { RESEND_URL } from '../../../src/contact/providers/resend';
import { SITEVERIFY_URL } from '../../../src/contact/turnstile';

const ORIGIN = 'https://www.example.org';
const LOG_ENV = { DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: 'secret' };
const RESEND_ENV = {
  DELIVERY_PROVIDER: 'resend',
  TURNSTILE_SECRET_KEY: 'secret',
  CONTACT_TO_EMAIL: 'owner@example.org',
  CONTACT_FROM_EMAIL: 'website@example.org',
  RESEND_API_KEY: 're_test',
};
const GOOD = { name: 'Ada', email: 'ada@example.com', message: 'Hello.', 'cf-turnstile-response': 'token' };

function post(fields: Record<string, string>, origin: string | null = ORIGIN, headers: Record<string, string> = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const h = new Headers(headers);
  if (origin !== null) h.set('Origin', origin);
  return new Request(`${ORIGIN}/api/contact`, { method: 'POST', body, headers: h });
}

function fakeFetch(answers: { siteverify?: () => Response | Promise<Response>; delivery?: () => Response | Promise<Response> } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SITEVERIFY_URL) return answers.siteverify ? answers.siteverify() : Response.json({ success: true });
    return answers.delivery ? answers.delivery() : new Response('{}', { status: 200 });
  });
}

const urlsCalled = (fetchFn: ReturnType<typeof fakeFetch>) =>
  fetchFn.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

async function run(request: Request, env: Record<string, string> = LOG_ENV, fetchFn = fakeFetch()) {
  const log = vi.fn<Logger>();
  const response = await handleContact(request, env, { fetch: fetchFn, log });
  return { response, body: await response.json(), fetchFn, log };
}

describe('step 1: origin', () => {
  test.each([
    ['missing', null],
    ['another site', 'https://attacker.example'],
    ['"null"', 'null'],
    ['http instead of https', 'http://www.example.org'],
  ])('403 when Origin is %s, before any network call', async (_label, origin) => {
    const { response, fetchFn } = await run(post(GOOD, origin));
    expect(response.status).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('step 1: only an https origin, or a loopback one', () => {
  test.each([
    ['https', 'https://www.example.org'],
    ['loopback IPv4', 'http://127.0.0.1:8787'],
    ['localhost', 'http://localhost:4321'],
    ['loopback IPv6', 'http://[::1]:8787'],
  ])('accepts a post from %s to itself', async (_label, origin) => {
    const request = new Request(`${origin}/api/contact`, { method: 'POST', body: new URLSearchParams(GOOD), headers: { Origin: origin } });
    expect((await run(request)).response.status).toBe(200);
  });

  test('refuses a cleartext site posting to itself, before any network call', async () => {
    const origin = 'http://www.example.org';
    const request = new Request(`${origin}/api/contact`, { method: 'POST', body: new URLSearchParams(GOOD), headers: { Origin: origin } });
    const { response, fetchFn } = await run(request);
    expect(response.status).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('step 2: body', () => {
  test.each(['application/json', 'text/plain'])('400 for %s', async (type) => {
    const request = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: '{"name":"Ada"}',
      headers: { Origin: ORIGIN, 'Content-Type': type },
    });
    expect((await run(request)).response.status).toBe(400);
  });

  test('413 when Content-Length says too much', async () => {
    const request = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: 'x=1',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(MAX_BODY_BYTES + 1) },
    });
    expect((await run(request)).response.status).toBe(413);
  });

  // Review focus 4: no Content-Length at all, and a body that never ends. Reading it whole
  // would hang this test; the handler must stop at the limit.
  test('413 for an endless chunked body, without reading it all', async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('a='.padEnd(1024, 'a')));
      },
    });
    const request = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: endless,
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      duplex: 'half',
    } as RequestInit);
    expect((await run(request)).response.status).toBe(413);
    expect(pulls).toBeLessThan(MAX_BODY_BYTES / 1024 + 4);
  });

  test('400 for a multipart body that does not parse', async () => {
    const request = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: 'not multipart at all',
      headers: { Origin: ORIGIN, 'Content-Type': 'multipart/form-data; boundary=xyz' },
    });
    expect((await run(request)).response.status).toBe(400);
  });

  test('accepts a urlencoded body', async () => {
    const request = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: new URLSearchParams(GOOD).toString(),
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect((await run(request)).response.status).toBe(200);
  });
});

describe('step 3: honeypot', () => {
  test('a filled _gotcha gets a silent 200 and no network call at all', async () => {
    const { response, body, fetchFn } = await run(post({ ...GOOD, _gotcha: 'http://spam.example' }));
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  test('500 with a generic message, and the detail only in the log', async () => {
    const { response, body, fetchFn, log } = await run(post(GOOD), {});
    expect(response.status).toBe(500);
    expect(body.message).not.toMatch(/DELIVERY_PROVIDER|TURNSTILE/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ error: expect.stringMatching(/DELIVERY_PROVIDER/) }));
  });
});

describe('step 4: Turnstile', () => {
  test('403 when Cloudflare says the token is bad; nothing delivered', async () => {
    const fetchFn = fakeFetch({ siteverify: () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) });
    const { response } = await run(post(GOOD), RESEND_ENV, fetchFn);
    expect(response.status).toBe(403);
    expect(urlsCalled(fetchFn)).toEqual([SITEVERIFY_URL]);
  });

  test('403 when the token is missing', async () => {
    const { 'cf-turnstile-response': _omit, ...noToken } = GOOD;
    expect((await run(post(noToken))).response.status).toBe(403);
  });

  test('a bad secret is logged as an error, because it breaks every submission', async () => {
    const fetchFn = fakeFetch({ siteverify: () => Response.json({ success: false, 'error-codes': ['invalid-input-secret'] }) });
    const { log } = await run(post(GOOD), LOG_ENV, fetchFn);
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/secret/i), expect.anything());
  });

  test('503 when siteverify is unavailable and the flag is closed', async () => {
    const fetchFn = fakeFetch({ siteverify: () => new Response('down', { status: 502 }) });
    const { response } = await run(post(GOOD), RESEND_ENV, fetchFn);
    expect(response.status).toBe(503);
    expect(urlsCalled(fetchFn)).toEqual([SITEVERIFY_URL]);
  });

  test('carries on, with a warning, when unavailable and TURNSTILE_FAIL_OPEN=true', async () => {
    const fetchFn = fakeFetch({ siteverify: () => new Response('down', { status: 502 }) });
    const { response, log } = await run(post(GOOD), { ...RESEND_ENV, TURNSTILE_FAIL_OPEN: 'true' }, fetchFn);
    expect(response.status).toBe(200);
    expect(urlsCalled(fetchFn)).toEqual([SITEVERIFY_URL, RESEND_URL]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/fail(ing)? open/i), expect.anything());
  });

  test('passes CF-Connecting-IP to siteverify', async () => {
    const fetchFn = fakeFetch();
    await run(post(GOOD, ORIGIN, { 'CF-Connecting-IP': '198.51.100.4' }), LOG_ENV, fetchFn);
    expect((fetchFn.mock.calls[0][1]?.body as FormData).get('remoteip')).toBe('198.51.100.4');
  });
});

describe('step 5: validation', () => {
  test('400 with per-field errors; nothing delivered', async () => {
    const fetchFn = fakeFetch();
    const { response, body } = await run(post({ ...GOOD, email: 'not-an-email', message: '' }), RESEND_ENV, fetchFn);
    expect(response.status).toBe(400);
    expect(Object.keys(body.errors).sort()).toEqual(['email', 'message']);
    expect(urlsCalled(fetchFn)).toEqual([SITEVERIFY_URL]);
  });
});

describe('step 6: delivery', () => {
  test('502 when the provider refuses', async () => {
    const fetchFn = fakeFetch({ delivery: () => new Response('nope', { status: 500 }) });
    const { response, log } = await run(post(GOOD), RESEND_ENV, fetchFn);
    expect(response.status).toBe(502);
    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ provider: 'resend' }));
  });

  test('502 when the provider is unreachable', async () => {
    const fetchFn = fakeFetch({
      delivery: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await run(post(GOOD), RESEND_ENV, fetchFn)).response.status).toBe(502);
  });
});

describe('step 7: success', () => {
  test('200, JSON, no-store; Resend called with the host in the subject', async () => {
    const fetchFn = fakeFetch();
    const { response, body } = await run(post(GOOD), RESEND_ENV, fetchFn);
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, message: expect.any(String) });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const resendCall = fetchFn.mock.calls.find(([input]) => String(input) === RESEND_URL);
    expect(JSON.parse(resendCall?.[1]?.body as string).subject).toContain('www.example.org');
  });
});
