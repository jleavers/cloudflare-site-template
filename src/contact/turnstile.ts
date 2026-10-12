export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult =
  | { outcome: 'pass' }
  | { outcome: 'fail'; codes: string[] }
  | { outcome: 'unavailable'; reason: string };

/**
 * Asks Cloudflare whether a Turnstile token is good. "fail" is Cloudflare's verdict; "unavailable"
 * means no verdict could be had (network error, timeout, 5xx, garbage), which the handler
 * treats according to TURNSTILE_FAIL_OPEN.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null,
  fetchFn: typeof fetch,
  timeoutMs = 5000,
): Promise<TurnstileResult> {
  if (token === '') return { outcome: 'fail', codes: ['missing-input-response'] };

  const body = new FormData();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);

  let response: Response;
  try {
    response = await fetchFn(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  if (response.status >= 500) return { outcome: 'unavailable', reason: `siteverify answered ${response.status}` };

  let data: { success?: unknown; 'error-codes'?: unknown };
  try {
    data = await response.json();
  } catch {
    return { outcome: 'unavailable', reason: 'siteverify answered with something other than JSON' };
  }
  if (data.success === true) return { outcome: 'pass' };
  const codes = Array.isArray(data['error-codes']) ? data['error-codes'].map(String) : [];
  return { outcome: 'fail', codes };
}
