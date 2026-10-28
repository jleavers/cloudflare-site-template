import type { ContactConfig } from '../config';
import type { Logger } from '../logger';
import type { Submission } from '../validate';

export interface DeliveryContext {
  /** The host the form was posted to, e.g. "www.example.org", for subjects and headings. */
  siteHost: string;
  fetch: typeof fetch;
  log: Logger;
}

/** The only error names a "could not be reached" message repeats. */
const REACH_ERRORS = new Set(['TypeError', 'TimeoutError', 'AbortError']);

export class DeliveryError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
  }
}

export type Provider = (submission: Submission, config: ContactConfig, context: DeliveryContext) => Promise<void>;

/** POSTs JSON and turns a network error, a timeout or a non-2xx answer into a DeliveryError. */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  label: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // One of three class names, or Error: a runtime error's text, and its name too, can quote the URL, whose
    // path or query is the secret, and this message reaches the log.
    const name = !(error instanceof Error) ? 'a non-Error value' : REACH_ERRORS.has(error.name) ? error.name : 'Error';
    throw new DeliveryError(`${label} could not be reached (${name})`);
  }
  if (!response.ok) {
    // The status only: an error body can echo the request, which holds the visitor's text and the owner's address.
    throw new DeliveryError(`${label} answered ${response.status}`, response.status);
  }
}
