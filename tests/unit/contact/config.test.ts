import { describe, expect, test } from 'vitest';
import { ConfigError, readConfig } from '../../../src/contact/config';

const base = { TURNSTILE_SECRET_KEY: 'secret' };

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
      expect(message).toContain('npx wrangler secret put TURNSTILE_SECRET_KEY');
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
