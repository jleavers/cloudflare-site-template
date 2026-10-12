import { ConfigError, readConfig, type ContactEnv } from './config';
import { json } from './http';
import { consoleLogger, type Logger } from './logger';
import { providers } from './providers/index';
import { verifyTurnstile } from './turnstile';
import { validate } from './validate';

export const MAX_BODY_BYTES = 32 * 1024;

export interface ContactDeps {
  fetch: typeof fetch;
  log?: Logger;
}

export const MESSAGES = {
  sent: 'Thank you — your message has been sent.',
  forbidden: 'This form can only be sent from its own website.',
  encoding: 'The form arrived in a format we can’t read.',
  tooLarge: 'That message is too large to send.',
  unreadable: 'We couldn’t read the form. Please try again.',
  turnstile: 'We couldn’t confirm you’re not a robot. Please try again.',
  turnstileDown: 'Our spam check is unavailable right now. Please try again in a few minutes.',
  invalid: 'Please check the highlighted fields.',
  delivery: 'Sorry, we couldn’t send your message. Please try again later.',
  internal: 'Sorry, something went wrong on our side. Please try again later.',
} as const;

const FORM_TYPES = new Set(['multipart/form-data', 'application/x-www-form-urlencoded']);

/** Reads at most `limit` bytes; null if the body is longer. Never buffers more than the limit. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * POST /api/contact, as specified in the design spec §7.3. Web-standard APIs only (contract C6):
 * wrap it in any host that can produce a Request and send back a Response.
 */
export async function handleContact(request: Request, env: ContactEnv, deps: ContactDeps): Promise<Response> {
  const log = deps.log ?? consoleLogger;
  const url = new URL(request.url);

  // 1. Same-origin only. Browsers send Origin on every POST.
  if (request.headers.get('Origin') !== url.origin) return json(403, { ok: false, message: MESSAGES.forbidden });

  // 2. A form body, and a small one.
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!FORM_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) {
    return json(400, { ok: false, message: MESSAGES.encoding });
  }
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return json(413, { ok: false, message: MESSAGES.tooLarge });
  }
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) return json(413, { ok: false, message: MESSAGES.tooLarge });
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return json(400, { ok: false, message: MESSAGES.unreadable });
  }

  // 3. Honeypot: a bot that fills it is told it succeeded, and nothing happens.
  const gotcha = form.get('_gotcha');
  if (typeof gotcha === 'string' && gotcha.trim() !== '') {
    log('info', 'contact: honeypot filled, dropped');
    return json(200, { ok: true, message: MESSAGES.sent });
  }

  let config;
  try {
    config = readConfig(env);
  } catch (error) {
    log('error', 'contact: configuration error', { error: error instanceof ConfigError ? error.message : String(error) });
    return json(500, { ok: false, message: MESSAGES.internal });
  }

  // 4. Turnstile.
  const token = form.get('cf-turnstile-response');
  const verdict = await verifyTurnstile(
    typeof token === 'string' ? token : '',
    config.turnstileSecretKey,
    request.headers.get('CF-Connecting-IP'),
    deps.fetch,
  );
  if (verdict.outcome === 'fail') {
    const misconfigured = verdict.codes.some((code) => code.includes('secret'));
    log(misconfigured ? 'error' : 'info', misconfigured ? 'contact: Turnstile rejected our secret key' : 'contact: Turnstile said no', {
      codes: verdict.codes,
    });
    return json(403, { ok: false, message: MESSAGES.turnstile });
  }
  if (verdict.outcome === 'unavailable') {
    if (!config.turnstileFailOpen) {
      log('error', 'contact: Turnstile unavailable, failing closed', { reason: verdict.reason });
      return json(503, { ok: false, message: MESSAGES.turnstileDown });
    }
    log('warn', 'contact: Turnstile unavailable, failing open', { reason: verdict.reason });
  }

  // 5. Validation.
  const result = validate({ name: form.get('name'), email: form.get('email'), message: form.get('message') });
  if (!result.ok) return json(400, { ok: false, message: MESSAGES.invalid, errors: result.errors });

  // 6. Delivery.
  try {
    await providers[config.provider](result.value, config, { siteHost: url.host, fetch: deps.fetch, log });
  } catch (error) {
    log('error', 'contact: delivery failed', { provider: config.provider, error: error instanceof Error ? error.message : String(error) });
    return json(502, { ok: false, message: MESSAGES.delivery });
  }

  // 7. Done.
  return json(200, { ok: true, message: MESSAGES.sent });
}
