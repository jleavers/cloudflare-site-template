import type { ContactConfig } from '../config';
import type { Logger } from '../logger';
import type { Submission } from '../validate';

export interface DeliveryContext {
  /** The host the form was posted to, e.g. "www.example.org", for subjects and headings. */
  siteHost: string;
  fetch: typeof fetch;
  log: Logger;
}

export class DeliveryError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
  }
}

export type Provider = (submission: Submission, config: ContactConfig, context: DeliveryContext) => Promise<void>;

/** POSTs JSON and turns a network error or a non-2xx answer into a DeliveryError. */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  label: string,
  headers: Record<string, string> = {},
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new DeliveryError(`${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new DeliveryError(`${label} answered ${response.status}: ${detail}`, response.status);
  }
}
