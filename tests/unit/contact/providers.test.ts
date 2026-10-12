import { describe, expect, test, vi } from 'vitest';
import type { ContactConfig } from '../../../src/contact/config';
import type { Logger } from '../../../src/contact/logger';
import { formatText } from '../../../src/contact/providers/format';
import { providers } from '../../../src/contact/providers/index';
import { redactEmail } from '../../../src/contact/providers/log';
import { RESEND_URL } from '../../../src/contact/providers/resend';
import { DeliveryError, type DeliveryContext } from '../../../src/contact/providers/types';
import { slackEscape, teamsEscape } from '../../../src/contact/providers/webhook';

const submission = { name: 'Ada <Lovelace>', email: 'ada@example.com', message: 'Hello & welcome\n<!channel> ```code```' };
const host = 'www.example.org';

function context(response: Response | Error = new Response('{}', { status: 200 })) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const log = vi.fn<Logger>();
  const ctx: DeliveryContext = { siteHost: host, fetch: fetchFn, log };
  return { ctx, fetchFn, log };
}

const resendConfig: ContactConfig = {
  provider: 'resend',
  turnstileSecretKey: 's',
  turnstileFailOpen: false,
  toEmail: 'owner@example.org',
  fromEmail: 'website@example.org',
  resendApiKey: 're_test_key',
};
const hookConfig = (provider: 'slack' | 'teams'): ContactConfig => ({
  provider,
  turnstileSecretKey: 's',
  turnstileFailOpen: false,
  webhookUrl: 'https://hooks.example.org/abc',
});

describe('formatText', () => {
  test('lays out a plain-text message', () => {
    expect(formatText({ name: 'Ada', email: 'ada@example.com', message: 'Hi' }, host)).toBe(
      'New enquiry via www.example.org\n\nName: Ada\nEmail: ada@example.com\n\nHi',
    );
  });
});

describe('resend', () => {
  test('posts one plain-text email with Reply-To set to the visitor', async () => {
    const { ctx, fetchFn } = context();
    await providers.resend(submission, resendConfig, ctx);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(RESEND_URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer re_test_key');
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'website@example.org',
      to: ['owner@example.org'],
      reply_to: 'ada@example.com',
      subject: 'New enquiry from Ada <Lovelace> via www.example.org',
      text: formatText(submission, host),
    });
  });

  test('a non-2xx answer is a DeliveryError carrying the status', async () => {
    const { ctx } = context(new Response('{"message":"invalid"}', { status: 422 }));
    await expect(providers.resend(submission, resendConfig, ctx)).rejects.toMatchObject({ name: 'DeliveryError', status: 422 });
  });

  test('a network error is a DeliveryError', async () => {
    const { ctx } = context(new TypeError('fetch failed'));
    await expect(providers.resend(submission, resendConfig, ctx)).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe('slack', () => {
  test('escapes &, < and > everywhere and fences the message', async () => {
    const { ctx, fetchFn } = context();
    await providers.slack(submission, hookConfig('slack'), ctx);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://hooks.example.org/abc');
    const { text } = JSON.parse(init?.body as string) as { text: string };
    expect(text).toContain('*Name:* Ada &lt;Lovelace&gt;');
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
    expect(text.match(/```/g)).toHaveLength(2); // only our own fence survives
  });

  test('slackEscape handles the three control characters', () => {
    expect(slackEscape('a & <b> c')).toBe('a &amp; &lt;b&gt; c');
  });
});

describe('teams', () => {
  test('posts an Adaptive Card message', async () => {
    const { ctx, fetchFn } = context(new Response(null, { status: 202 }));
    await providers.teams(submission, hookConfig('teams'), ctx);
    const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
    expect(body.type).toBe('message');
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = body.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(JSON.stringify(card)).toContain('Ada <Lovelace>');
    expect(JSON.stringify(card)).toContain('ada@example.com');
  });

  test('breaks masked links in visitor text', async () => {
    const { ctx, fetchFn } = context(new Response(null, { status: 202 }));
    await providers.teams({ ...submission, message: 'Pay [Invoice](https://evil.example)' }, hookConfig('teams'), ctx);
    const json = JSON.stringify(JSON.parse(fetchFn.mock.calls[0][1]?.body as string));
    expect(json).not.toContain('](https://evil.example)');
    expect(json).toContain('[Invoice] (https://evil.example)');
  });

  test('teamsEscape breaks markdown link syntax', () => {
    expect(teamsEscape('see [this](https://evil.example) and [x]  (y)')).toBe('see [this] (https://evil.example) and [x] (y)');
  });

  test('a non-2xx answer is a DeliveryError', async () => {
    const { ctx } = context(new Response('nope', { status: 400 }));
    await expect(providers.teams(submission, hookConfig('teams'), ctx)).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe('log', () => {
  test('sends nothing and logs no message content', async () => {
    const { ctx, fetchFn, log } = context();
    await providers.log(submission, { provider: 'log', turnstileSecretKey: 's', turnstileFailOpen: false }, ctx);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const [level, , data] = log.mock.calls[0];
    expect(level).toBe('info');
    expect(data).toEqual({ email: 'a***@example.com', nameLength: 14, messageLength: submission.message.length });
  });

  test('redactEmail keeps the first character and the domain', () => {
    expect(redactEmail('ada@example.com')).toBe('a***@example.com');
  });
});
