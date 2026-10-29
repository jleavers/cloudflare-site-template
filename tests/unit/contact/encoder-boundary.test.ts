import { beforeEach, expect, test, vi } from 'vitest';
import type { ContactConfig, ProviderName } from '../../../src/contact/config';
import type { Logger } from '../../../src/contact/logger';
import { providers } from '../../../src/contact/providers/index';

// Spec §7.4, Ruling 109: one encoder (providers/format.ts) makes every visitor field literal, and no
// provider formats a field itself. vi.mock is hoisted above the imports, and these stand-ins never
// read the submission, so any read of a field below is the provider's own.
const encoder = vi.hoisted(() => ({
  formatResend: vi.fn((_submission: unknown, _siteHost: string) => ({ reply_to: 'r@example.com', subject: 'subject', text: 'text' })),
  formatSlack: vi.fn((_submission: unknown, _siteHost: string) => ({ text: 'Slack text' })),
  formatTeams: vi.fn((_submission: unknown, _siteHost: string) => ({ type: 'AdaptiveCard', body: [] })),
  formatLog: vi.fn((_submission: unknown) => ({ shape: 'log shape' })),
}));
vi.mock('../../../src/contact/providers/format', () => encoder);

const configs: Record<ProviderName, ContactConfig> = {
  resend: { provider: 'resend', turnstileSecretKey: 's', turnstileFailOpen: false, toEmail: 'owner@example.org', fromEmail: 'website@example.org', resendApiKey: 're_test_key' },
  slack: { provider: 'slack', turnstileSecretKey: 's', turnstileFailOpen: false, webhookUrl: 'https://hooks.example.org/abc' },
  teams: { provider: 'teams', turnstileSecretKey: 's', turnstileFailOpen: false, webhookUrl: 'https://hooks.example.org/abc' },
  log: { provider: 'log', turnstileSecretKey: 's', turnstileFailOpen: false },
};

beforeEach(() => vi.clearAllMocks());

test.each(Object.keys(providers) as ProviderName[])('%s reads no visitor field: it hands the submission to the encoder', async (name) => {
  const reads: string[] = [];
  const fields = { name: 'Ada', email: 'ada@example.com', message: 'Hello.' };
  const submission = new Proxy(fields, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in target) reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}'));
  await providers[name](submission, configs[name], { siteHost: 'www.example.org', fetch: fetchFn, log: vi.fn<Logger>() });

  expect(reads).toEqual([]);
  const handed = Object.values(encoder).flatMap((format) => format.mock.calls.map(([argument]) => argument));
  expect(handed).toContain(submission);
});
