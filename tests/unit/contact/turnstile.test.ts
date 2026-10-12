import { describe, expect, test, vi } from 'vitest';
import { SITEVERIFY_URL, verifyTurnstile } from '../../../src/contact/turnstile';

const answering = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('verifyTurnstile', () => {
  test('passes when siteverify says success, sending secret, token and IP as a form', async () => {
    const fetchFn = answering({ success: true });
    expect(await verifyTurnstile('token', 'secret', '203.0.113.7', fetchFn)).toEqual({ outcome: 'pass' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect([form.get('secret'), form.get('response'), form.get('remoteip')]).toEqual(['secret', 'token', '203.0.113.7']);
  });

  test('leaves remoteip out when it is unknown', async () => {
    const fetchFn = answering({ success: true });
    await verifyTurnstile('token', 'secret', null, fetchFn);
    expect((fetchFn.mock.calls[0][1]?.body as FormData).has('remoteip')).toBe(false);
  });

  test('fails without a network call when the token is empty', async () => {
    const fetchFn = answering({ success: true });
    expect(await verifyTurnstile('', 'secret', null, fetchFn)).toEqual({ outcome: 'fail', codes: ['missing-input-response'] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('fails with the error codes when siteverify says no', async () => {
    expect(await verifyTurnstile('t', 's', null, answering({ success: false, 'error-codes': ['invalid-input-response'] }))).toEqual({
      outcome: 'fail',
      codes: ['invalid-input-response'],
    });
  });

  test('treats a 4xx JSON answer as a verdict, not an outage', async () => {
    expect(await verifyTurnstile('t', 's', null, answering({ success: false, 'error-codes': ['bad-request'] }, 400))).toEqual({
      outcome: 'fail',
      codes: ['bad-request'],
    });
  });

  test.each([
    ['a 5xx', answering({ success: true }, 503)],
    ['a non-JSON body', vi.fn<typeof fetch>(async () => new Response('<html>oops</html>', { status: 200 }))],
    [
      'a network error',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    ],
  ])('treats %s as unavailable', async (_label, fetchFn) => {
    expect((await verifyTurnstile('t', 's', null, fetchFn)).outcome).toBe('unavailable');
  });

  test('gives up after the timeout', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const result = await verifyTurnstile('t', 's', null, hanging, 10);
    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect(result.outcome === 'unavailable' && result.reason).toMatch(/Timeout/);
  });
});
