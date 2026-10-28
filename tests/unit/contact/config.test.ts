import { describe, expect, test } from 'vitest';
import { ConfigError, readConfig } from '../../../src/contact/config';

const base = { TURNSTILE_SECRET_KEY: 'secret' };
const WEBHOOK_MESSAGE =
  'WEBHOOK_URL must be an https URL with a host and no username or password. Fix it as a secret in the ' +
  'Cloudflare dashboard: the Worker → Settings → Variables and Secrets, name WEBHOOK_URL.';

function missingFrom(env: Record<string, string | undefined>): string[] {
  try {
    readConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.missing;
    throw error;
  }
  throw new Error('readConfig did not throw');
}

describe('readConfig', () => {
  test('log needs only the Turnstile secret', () => {
    expect(readConfig({ ...base, DELIVERY_PROVIDER: 'log' })).toEqual({
      provider: 'log',
      turnstileSecretKey: 'secret',
      turnstileFailOpen: false,
    });
  });

  test('resend needs to, from and the API key', () => {
    expect(missingFrom({ ...base, DELIVERY_PROVIDER: 'resend' })).toEqual([
      'CONTACT_TO_EMAIL',
      'CONTACT_FROM_EMAIL',
      'RESEND_API_KEY',
    ]);
    expect(
      readConfig({
        ...base,
        DELIVERY_PROVIDER: 'resend',
        CONTACT_TO_EMAIL: 'to@example.com',
        CONTACT_FROM_EMAIL: 'from@example.com',
        RESEND_API_KEY: 're_test',
      }),
    ).toMatchObject({ provider: 'resend', toEmail: 'to@example.com', fromEmail: 'from@example.com', resendApiKey: 're_test' });
  });

  test.each(['slack', 'teams'])('%s needs an https WEBHOOK_URL', (provider) => {
    expect(missingFrom({ ...base, DELIVERY_PROVIDER: provider })).toEqual(['WEBHOOK_URL']);
    expect(() => readConfig({ ...base, DELIVERY_PROVIDER: provider, WEBHOOK_URL: 'http://hooks.example.com/x' })).toThrow(
      /WEBHOOK_URL must be an https URL/,
    );
    expect(readConfig({ ...base, DELIVERY_PROVIDER: provider, WEBHOOK_URL: 'https://hooks.example.com/x' }).webhookUrl).toBe(
      'https://hooks.example.com/x',
    );
  });

  // Ruling 110: a WEBHOOK_URL that is refused is refused with a fixed message. Slack's and Teams'
  // secrets are the URL's path and query, and a message that quoted any of it would reach the log.
  describe('WEBHOOK_URL is parsed when the config is read', () => {
    const SECRET = 'T0FAKE/B0FAKE/fictional-secret-path';
    const refused: [string, string][] = [
      ['an https prefix and no host', `https://?${SECRET}&sig=fictional-sig`],
      ['a host that does not parse', `https://hooks.example .test/${SECRET}`],
      ['a port that does not parse', `https://hooks.example.test:99999/${SECRET}`],
      ['a username', `https://fictional-user@hooks.example.test/${SECRET}`],
      ['a username and password', `https://fictional-user:fictional-pass@hooks.example.test/${SECRET}`],
      ['a password only', `https://:fictional-pass@hooks.example.test/${SECRET}`],
      ['http', `http://hooks.example.test/${SECRET}`],
      ['no scheme', `hooks.example.test/${SECRET}`],
    ];

    test.each(['slack', 'teams'])('%s refuses each bad value with a message that holds no part of it', (provider) => {
      for (const [label, value] of refused) {
        let error: unknown;
        try {
          readConfig({ ...base, DELIVERY_PROVIDER: provider, WEBHOOK_URL: value });
        } catch (caught) {
          error = caught;
        }
        expect(error, label).toBeInstanceOf(ConfigError);
        const { message } = error as ConfigError;
        expect(message, label).toBe(WEBHOOK_MESSAGE);
        for (const part of ['fictional', 'hooks.example', 'T0FAKE', 'B0FAKE', 'sig=', '99999']) expect(message, label).not.toContain(part);
      }
    });

    test.each([
      ['a Slack shaped URL', 'https://hooks.example.test/services/T0FAKE/B0FAKE/fictionalsecret'],
      ['a Teams shaped URL', 'https://example-tenant.webhook.example.test:443/webhookb2/aaaa@bbbb/IncomingWebhook/cccc/dddd?api-version=1&sig=fictional'],
    ])('accepts %s, unchanged', (_label, value) => {
      expect(readConfig({ ...base, DELIVERY_PROVIDER: 'slack', WEBHOOK_URL: value }).webhookUrl).toBe(value);
    });
  });

  test('reports every missing name at once, provider included', () => {
    expect(missingFrom({})).toEqual(['DELIVERY_PROVIDER', 'TURNSTILE_SECRET_KEY']);
  });

  test('whitespace-only values count as missing', () => {
    expect(missingFrom({ DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: '   ' })).toEqual(['TURNSTILE_SECRET_KEY']);
  });

  test('an unknown provider is an error that names the allowed ones', () => {
    expect(() => readConfig({ ...base, DELIVERY_PROVIDER: 'carrier-pigeon' })).toThrow(/resend, slack, teams, log/);
  });

  test.each([
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    ['yes', false],
    [undefined, false],
  ])('TURNSTILE_FAIL_OPEN=%j reads as %s', (value, expected) => {
    expect(readConfig({ ...base, DELIVERY_PROVIDER: 'log', TURNSTILE_FAIL_OPEN: value }).turnstileFailOpen).toBe(expected);
  });

  describe('the Turnstile test secret', () => {
    const TEST_SECRET = '1x0000000000000000000000000000000AA';
    const extras: Record<string, Record<string, string>> = {
      resend: { CONTACT_TO_EMAIL: 'to@acme.test', CONTACT_FROM_EMAIL: 'from@acme.test', RESEND_API_KEY: 're_live' },
      slack: { WEBHOOK_URL: 'https://hooks.acme.test/x' },
      teams: { WEBHOOK_URL: 'https://hooks.acme.test/x' },
    };

    test.each(['resend', 'slack', 'teams'])('is refused with %s, naming the fix and not echoing the value', (provider) => {
      const env = { DELIVERY_PROVIDER: provider, TURNSTILE_SECRET_KEY: TEST_SECRET, ...extras[provider] };
      let message = '';
      try {
        readConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain('Variables and Secrets, type Secret, name TURNSTILE_SECRET_KEY');
      expect(message).not.toMatch(/wrangler secret/);
      expect(message).not.toContain(TEST_SECRET);
    });

    test.each(['2x0000000000000000000000000000000AA', '3x0000000000000000000000000000000AA'])('the other published test secret %s is refused too', (secret) => {
      expect(() => readConfig({ DELIVERY_PROVIDER: 'slack', TURNSTILE_SECRET_KEY: secret, ...extras.slack })).toThrow(ConfigError);
    });

    test('passes with log: the demo, previews and the e2e suite', () => {
      expect(readConfig({ DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: TEST_SECRET }).provider).toBe('log');
    });

    test('a real-looking secret passes with resend', () => {
      const env = { DELIVERY_PROVIDER: 'resend', TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal_secret_value', ...extras.resend };
      expect(readConfig(env).provider).toBe('resend');
    });
  });
});
