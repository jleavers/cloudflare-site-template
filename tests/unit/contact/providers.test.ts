import { describe, expect, test, vi } from 'vitest';
import type { ContactConfig, ProviderName } from '../../../src/contact/config';
import { handleContact } from '../../../src/contact/handler';
import type { Logger } from '../../../src/contact/logger';
import { formatSlack, formatText, redactEmail, slackEscape } from '../../../src/contact/providers/format';
import { providers } from '../../../src/contact/providers/index';
import { RESEND_URL } from '../../../src/contact/providers/resend';
import { DeliveryError, postJson, type DeliveryContext } from '../../../src/contact/providers/types';
import { validate, type Submission } from '../../../src/contact/validate';

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

  test("a thrown error's name never reaches the DeliveryError's text", async () => {
    const odd = new Error('boom');
    odd.name = 'FetchError https://hooks.example.org/secret-path?token=abc123';
    const { ctx } = context(odd);
    const failure = await providers.resend(submission, resendConfig, ctx).then(
      () => undefined,
      (thrown: unknown) => thrown as DeliveryError,
    );
    expect(failure).toBeInstanceOf(DeliveryError);
    expect(failure?.message).toBe('Resend could not be reached (Error)');
    expect(failure?.message).not.toMatch(/secret-path|abc123|hooks\.example\.org/);
  });

  test.each(['TypeError', 'TimeoutError', 'AbortError'])('keeps the allowed name %s', async (name) => {
    const named = new Error('x');
    named.name = name;
    const { ctx } = context(named);
    await expect(providers.resend(submission, resendConfig, ctx)).rejects.toThrow(`Resend could not be reached (${name})`);
  });
});

describe('slack', () => {
  test('escapes &, < and > everywhere and puts every field in code', async () => {
    const { ctx, fetchFn } = context();
    await providers.slack(submission, hookConfig('slack'), ctx);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://hooks.example.org/abc');
    const { text } = JSON.parse(init?.body as string) as { text: string };
    expect(text).toContain('*Name:* `Ada &lt;Lovelace&gt;`');
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
    expect(text.match(/```/g)).toHaveLength(2); // only our own fence survives
  });

  test('slackEscape handles the three control characters', () => {
    expect(slackEscape('a & <b> c')).toBe('a &amp; &lt;b&gt; c');
  });

  test("shows a backtick as U+02CB, so o'neill and o`neill stay distinct", () => {
    const apostrophe = formatSlack({ ...submission, email: "o'neill@example.com" }, host).text;
    const backtick = formatSlack({ ...submission, email: 'o`neill@example.com' }, host).text;
    expect(apostrophe).toContain("*Email:* `o'neill@example.com`");
    expect(backtick).toContain(`*Email:* \`o${String.fromCodePoint(0x2cb)}neill@example.com\``);
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

  test('keeps a Markdown link in visitor text as a TextRun, which parses no Markdown', async () => {
    const { ctx, fetchFn } = context(new Response(null, { status: 202 }));
    await providers.teams({ ...submission, message: 'Pay [Invoice](https://evil.example)' }, hookConfig('teams'), ctx);
    const card = JSON.parse(fetchFn.mock.calls[0][1]?.body as string).attachments[0].content;
    expect(card.body[3]).toEqual({ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Pay [Invoice](https://evil.example)' }] });
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

describe('postJson timeout', () => {
  test('a fetch that never answers becomes a DeliveryError once the timeout passes', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const failure = await postJson(hanging, 'https://api.test/', {}, 'Resend', {}, 10).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeliveryError);
    expect((failure as DeliveryError).message).toMatch(/Resend could not be reached/);
    expect(hanging.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('an unreachable endpoint names the label and the error class, never the error text', async () => {
    const secret = 'https://hooks.example.test/services/T0FAKE/fictional-secret';
    const throwing = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`Failed to parse URL from ${secret}`);
    });
    const failure = await postJson(throwing, secret, {}, 'Slack').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeliveryError);
    expect((failure as DeliveryError).message).toBe('Slack could not be reached (TypeError)');
  });

  test('a timeout is named by its class', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const failure = await postJson(hanging, 'https://api.test/', {}, 'Resend', {}, 10).catch((error: unknown) => error);
    expect((failure as DeliveryError).message).toBe('Resend could not be reached (TimeoutError)');
  });

  test('a thrown value that is not an Error is named without being printed', async () => {
    const throwing = vi.fn<typeof fetch>(async () => {
      throw 'https://hooks.example.test/fictional-secret'; // eslint-disable-line no-throw-literal
    });
    const failure = await postJson(throwing, 'https://api.test/', {}, 'Teams').catch((error: unknown) => error);
    expect((failure as DeliveryError).message).toBe('Teams could not be reached (a non-Error value)');
  });

  test('a non-2xx answer keeps its status and drops its body', async () => {
    const answered = vi.fn<typeof fetch>(async () => new Response('fictional-secret ada@example.com', { status: 422 }));
    const failure = await postJson(answered, 'https://api.test/', {}, 'Resend').catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'Resend answered 422', status: 422 });
  });

  test('defaults to a signal that has not yet aborted', async () => {
    const ok = vi.fn<typeof fetch>(async () => new Response('{}'));
    await postJson(ok, 'https://api.test/', {}, 'Resend');
    expect(ok.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});

// Spec §7.4, Ruling 109: every visitor field reaches the owner, in every channel, as literal text
// that can neither be read as markup nor change how the site's own text around it displays.

/** One value for one field; the other two fields stay ordinary. */
export interface CorpusEntry {
  field: keyof Submission;
  label: string;
  value: string;
  /** Left out: validate() keeps the value as sent. A string: what validate() strips it to. null: refused. */
  after?: string | null;
}

/** A string from code points: an editor or tool cannot turn these into the invisible characters themselves. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

/** How Slack shows a visitor's backtick: U+02CB, visible and distinct from an apostrophe (Ruling 114). */
const SLACK_BACKTICK = cp(0x2cb);

/**
 * One corpus, through validate() and then through every provider in `providers`, every field of
 * every delivery checked by that provider's entry in LITERAL. A provider added later fails the
 * first test below until it has an entry, and is then held to the same corpus.
 */
export const HOSTILE_CORPUS: readonly CorpusEntry[] = [
  // The name keeps markup, which each channel must show literally, and refuses invisible characters.
  { field: 'name', label: 'a triple backtick', value: 'Ada ```' },
  { field: 'name', label: 'a single backtick', value: 'Ada `Lovelace' },
  { field: 'name', label: 'Slack mention syntax', value: '<!channel> <!here> @here' },
  { field: 'name', label: 'a Slack link', value: '<http://x|y>' },
  { field: 'name', label: 'mrkdwn emphasis and strike', value: '*Ada* _Lovelace_ ~x~' },
  { field: 'name', label: 'a Markdown heading, emphasis and link', value: '# **Ada** [Pay](https://example.net/pay)' },
  { field: 'name', label: 'an HTML tag', value: '<b>Ada</b>' },
  { field: 'name', label: 'HTML entities', value: 'Ada &lt;b&gt; &amp;' },
  { field: 'name', label: 'an Adaptive Card date function', value: '{{DATE(2017-02-14T06:00:00Z, SHORT)}}' },
  { field: 'name', label: 'RLO', value: 'Ada \u202Egro.elpmaxe\u202C', after: null },
  { field: 'name', label: 'NEL', value: 'Ada\u0085Bcc: x@example.com', after: null },
  { field: 'name', label: 'CSI', value: 'Ada\u009B31m', after: null },
  { field: 'name', label: 'U+2028', value: 'Ada\u2028Email: boss@example.com', after: null },
  { field: 'name', label: 'a zero-width space', value: 'Ada\u200BLovelace', after: null },
  { field: 'name', label: 'a tag character', value: 'Ada\u{E0041}Lovelace', after: null },
  { field: 'name', label: 'a soft hyphen', value: 'Ada\u00ADLovelace', after: null },
  { field: 'name', label: 'a Persian name with ZWNJ', value: 'علی\u200Cرضا' },
  { field: 'name', label: 'an accented name', value: 'Zoë Ångström' },
  // Ruling 112: an RFC 2047 encoded-word, which a mail client decodes in the subject (this one is an RLO).
  { field: 'name', label: 'an RFC 2047 encoded-word', value: '=?UTF-8?B?4oCu?=', after: null },
  // Ruling 113: default-ignorable code points, a name with no letter, and an impossible stack of marks.
  { field: 'name', label: 'a Hangul filler', value: cp(0x3164), after: null },
  { field: 'name', label: 'a combining grapheme joiner', value: `Ada${cp(0x34f)}Lovelace`, after: null },
  { field: 'name', label: 'an unassigned default-ignorable', value: `Ada${cp(0x2065)}Lovelace`, after: null },
  { field: 'name', label: 'only ZWNJ', value: cp(0x200c), after: null },
  { field: 'name', label: 'a letter with 9 combining marks', value: `Ada${cp(0x301).repeat(9)}`, after: null },
  { field: 'name', label: 'an emoji with a variation selector', value: `Ada ${cp(0x2764, 0xfe0f)}` },
  { field: 'name', label: 'a Japanese name with an ideographic variation selector', value: `葛${cp(0xe0100)}城 花子` },
  { field: 'name', label: 'a Mongolian name with a free variation selector', value: cp(0x182a, 0x180b, 0x1820, 0x1832, 0x1824) },
  { field: 'name', label: 'a Vietnamese name with its marks decomposed', value: 'Nguyễn Thị Ánh'.normalize('NFD') },
  { field: 'name', label: 'a Tibetan name with a stack of marks', value: cp(0xf66, 0xf92, 0xfb2, 0xf7c, 0xf63, 0xf0b, 0xf58) },

  // The email keeps what a dot-atom allows, and refuses invisible characters and anything that is
  // not a bare address.
  { field: 'email', label: 'a triple backtick', value: 'ada```@example.com' },
  { field: 'email', label: 'mrkdwn emphasis and strike', value: '*ada*_x_~y~@example.com' },
  { field: 'email', label: 'an ampersand, a pipe and braces', value: 'ada&co|{{x}}@example.com' },
  { field: 'email', label: 'a display name', value: '"IT-Support"<attacker@example.net>', after: null },
  { field: 'email', label: 'angle brackets', value: '<ada@example.com>', after: null },
  { field: 'email', label: 'Slack mention syntax', value: '<!channel>@example.com', after: null },
  { field: 'email', label: 'a group', value: 'g:attacker@example.net;', after: null },
  { field: 'email', label: 'a list', value: 'a,boss@example.com', after: null },
  { field: 'email', label: 'a comment', value: 'ada(comment)@example.com', after: null },
  { field: 'email', label: 'RLO', value: 'ada\u202E@example.com', after: null },
  { field: 'email', label: 'NEL', value: 'ada\u0085@example.com', after: null },
  { field: 'email', label: 'U+2028', value: 'ada\u2028x@example.com', after: null },
  { field: 'email', label: 'a zero-width space', value: 'ada\u200B@example.com', after: null },
  { field: 'email', label: 'a tag character', value: 'ada\u{E0041}@example.com', after: null },
  { field: 'email', label: 'a soft hyphen', value: 'ada@exam\u00ADple.com', after: null },
  { field: 'email', label: 'a + address', value: 'ada+enquiries@example.com' },
  { field: 'email', label: 'non-ASCII letters', value: 'zoë@bücher.example' },
  { field: 'email', label: 'an RFC 2047 encoded-word', value: '=?UTF-8?B?4oCu?=@example.com', after: null },

  // The message keeps markup and strips invisible controls; it is never refused for a character.
  { field: 'message', label: 'triple backticks', value: 'Hi\n```\n*out of the fence*\n```' },
  { field: 'message', label: 'single backticks', value: '`code` and `more' },
  {
    field: 'message',
    label: 'Slack mention and link syntax',
    value: '<!channel> <!here> @here <@U012AB3CD> <http://x|y> <https://example.net/pay|Your invoice>',
  },
  { field: 'message', label: 'mrkdwn emphasis, strike and a quote', value: '*Overdue* _pay_ ~now~\n> quoted' },
  {
    field: 'message',
    label: 'Markdown headings, emphasis, strike, a link and lists',
    value: '# Heading\n**Bold** _it_ ~~strike~~ [Invoice](https://example.net/pay)\n- item\n1. item',
  },
  { field: 'message', label: 'HTML', value: '<b>bold</b> <a href="https://example.net/pay">x</a> <script>alert(1)</script>' },
  { field: 'message', label: 'HTML entities', value: '&lt;!channel&gt; &amp;' },
  {
    field: 'message',
    label: 'a Teams mention and date functions',
    value: '<at>Owner</at> {{DATE(2017-02-14T06:00:00Z, SHORT)}} {{{TIME(2017-02-14T06:00:00Z)}}}',
  },
  { field: 'message', label: 'RLO', value: 'Pay \u202Egro.elpmaxe\u202C now', after: 'Pay gro.elpmaxe now' },
  {
    field: 'message',
    label: 'every bidi embedding, override and isolate',
    value: 'a\u202Ab\u202Bc\u202Cd\u202De\u202Ef\u2066g\u2067h\u2068i\u2069j',
    after: 'abcdefghij',
  },
  { field: 'message', label: 'NEL and CSI', value: 'one\u0085two\u009Bthree', after: 'onetwothree' },
  { field: 'message', label: 'U+2028 and U+2029', value: 'one\u2028two\u2029three', after: 'onetwothree' },
  { field: 'message', label: 'CRLF, a lone CR and a tab', value: 'one\r\ntwo\rthree\tfour', after: 'one\ntwo\nthree\tfour' },
  { field: 'message', label: 'a zero-width space, a tag character and a soft hyphen', value: 'zero\u200Bwidth tag\u{E0041} soft\u00ADhyphen' },
  {
    field: 'message',
    label: 'an emoji ZWJ sequence, a variation selector and a flag tag sequence',
    value: '👩\u200D💻 ❤\uFE0F 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  },
  { field: 'message', label: 'Persian with ZWNJ', value: 'می\u200Cخواهم' },
];

const ORDINARY: Submission = { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello.' };

const configFor: Record<ProviderName, ContactConfig> = {
  resend: resendConfig,
  slack: hookConfig('slack'),
  teams: hookConfig('teams'),
  log: { provider: 'log', turnstileSecretKey: 's', turnstileFailOpen: false },
};

type Delivery = ReturnType<typeof context>;
const sentBody = ({ fetchFn }: Delivery) => JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);

/** Every object in a JSON value, depth first. */
function objectsIn(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(objectsIn);
  if (node === null || typeof node !== 'object') return [];
  return [node as Record<string, unknown>, ...Object.values(node).flatMap(objectsIn)];
}

/** Slack decodes these three entities for display, and no others. */
const slackDisplays = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const SLACK_LAYOUT = /^New enquiry via www\.example\.org\n\*Name:\* `([^`\n]*)`\n\*Email:\* `([^`\n]*)`\n```([^`]*)```$/;

interface TeamsBlock {
  type: string;
  inlines: { type: string; text: string; weight?: string }[];
}

/** For each provider, the property that makes every visitor field literal where the owner reads it. */
const LITERAL: Record<ProviderName, (sent: Delivery, s: Submission) => void> = {
  resend(sent, s) {
    const email = sentBody(sent);
    // Plain text only: no html part for visitor text to be read as.
    expect(Object.keys(email).sort()).toEqual(['from', 'reply_to', 'subject', 'text', 'to']);
    // Reply-To is a bare address: nothing a mail client could read as a display name, group or list.
    expect(email.reply_to).toBe(s.email);
    expect(email.reply_to).not.toMatch(/[\s"<>(),:;[\]\\]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    // The subject holds no control, separator or format character but ZWNJ and ZWJ.
    expect(email.subject).toBe(`New enquiry from ${s.name} via ${host}`);
    expect(email.subject).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}/u);
    // The body: no control but newline and tab, no separator, and no bidi embedding, override or isolate.
    expect(email.text).toBe(formatText(s, host));
    expect(email.text).not.toMatch(/(?![\t\n])\p{Cc}|[\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u);
  },
  slack(sent, s) {
    const { text, ...options } = sentBody(sent);
    expect(options).toEqual({});
    // Every visitor field sits in code that the payload opens and closes, and holds no backtick
    // that could close it early; inside code, Slack applies no other formatting.
    const fields = SLACK_LAYOUT.exec(text);
    expect(fields, text).not.toBeNull();
    // No unescaped < or >, so no mention or link, and every & begins one of the three entities.
    expect(text).not.toMatch(/[<>]|&(?!amp;|lt;|gt;)/);
    // What Slack displays is the visitor's text, with each backtick shown as U+02CB.
    expect(fields?.slice(1).map(slackDisplays)).toEqual([s.name, s.email, s.message].map((field) => field.replace(/`/g, SLACK_BACKTICK)));
  },
  teams(sent, s) {
    const message = sentBody(sent);
    expect(message.type).toBe('message');
    const card = message.attachments[0].content;
    const objects = objectsIn(card);
    // TextBlock, and a fact's title and value, parse Markdown: only the site's own text may sit there.
    expect(objects.filter((o) => o.type === 'TextBlock').map((o) => o.text)).toEqual([`New enquiry via ${host}`]);
    expect(objects.filter((o) => o.type === 'FactSet' || 'facts' in o)).toEqual([]);
    // Each visitor field is TextRuns in a RichTextBlock, which parses no Markdown, and no run holds
    // the "{{" that starts a DATE() or TIME() function.
    for (const run of objects.filter((o) => o.type === 'TextRun')) expect(run.text).not.toContain('{{');
    expect(card.body).toHaveLength(4);
    const [, name, email, text] = card.body as TeamsBlock[];
    for (const block of [name, email, text]) {
      expect(block.type).toBe('RichTextBlock');
      expect(block.inlines.every((inline) => inline.type === 'TextRun')).toBe(true);
    }
    expect(name.inlines[0]).toEqual({ type: 'TextRun', text: 'Name: ', weight: 'Bolder' });
    expect(email.inlines[0]).toEqual({ type: 'TextRun', text: 'Email: ', weight: 'Bolder' });
    const shown = (inlines: TeamsBlock['inlines']) => inlines.map((inline) => inline.text).join('');
    expect([shown(name.inlines.slice(1)), shown(email.inlines.slice(1)), shown(text.inlines)]).toEqual([s.name, s.email, s.message]);
  },
  log(sent, s) {
    expect(sent.fetchFn).not.toHaveBeenCalled();
    expect(sent.log.mock.calls).toEqual([
      ['info', 'contact: log provider, nothing sent', { email: redactEmail(s.email), nameLength: s.name.length, messageLength: s.message.length }],
    ]);
  },
};

describe('every visitor field reaches the owner as literal text, in every channel', () => {
  test('every provider has a literal check', () => {
    expect(Object.keys(LITERAL).sort()).toEqual(Object.keys(providers).sort());
  });

  const refused = HOSTILE_CORPUS.filter((entry) => entry.after === null).map((entry) => [entry.field, entry.label, entry] as const);
  const kept = HOSTILE_CORPUS.filter((entry) => entry.after !== null).map((entry) => [entry.field, entry.label, entry] as const);
  const input = (entry: CorpusEntry) => ({ ...ORDINARY, [entry.field]: entry.value });

  test.each(refused)('validate() refuses the %s with %s, as an error on that field', (field, _label, entry) => {
    const result = validate(input(entry));
    expect(result.ok ? {} : Object.keys(result.errors)).toEqual([field]);
  });

  test.each(refused)('the visitor sees the %s error for %s, not a 500', async (field, _label, entry) => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    const request = new Request(`https://${host}/api/contact`, {
      method: 'POST',
      headers: { Origin: `https://${host}` },
      body: new URLSearchParams({ ...input(entry), 'cf-turnstile-response': 'token' }),
    });
    const response = await handleContact(request, { DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: 'secret' }, { fetch: fetchFn, log: vi.fn() });
    expect(response.status).toBe(400);
    const { errors } = (await response.json()) as { errors: Record<string, string> };
    expect(Object.keys(errors)).toEqual([field]);
    expect(errors[field]).toMatch(/^(Please|Your) .+\.$/);
  });

  test.each(kept)('validate() keeps the %s with %s, stripped as specified', (field, _label, entry) => {
    expect(validate(input(entry))).toEqual({ ok: true, value: { ...ORDINARY, [field]: entry.after ?? entry.value } });
  });

  const deliveries = kept.flatMap(([field, label, entry]) =>
    (Object.keys(providers) as ProviderName[]).map((provider) => [provider, field, label, entry] as const),
  );

  test.each(deliveries)('%s shows every field literally when the %s holds %s', async (provider, _field, _label, entry) => {
    const result = validate(input(entry));
    if (!result.ok) throw new Error(`validate() refused it: ${JSON.stringify(result.errors)}`);
    const sent = context();
    await providers[provider](result.value, configFor[provider], sent.ctx);
    LITERAL[provider](sent, result.value);
  });
});
