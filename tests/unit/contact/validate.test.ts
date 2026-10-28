import { describe, expect, test } from 'vitest';
import { LIMITS, validate } from '../../../src/contact/validate';

const ok = { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello there.' };

function errorsFor(input: Parameters<typeof validate>[0]): string[] {
  const result = validate(input);
  return result.ok ? [] : Object.keys(result.errors).sort();
}

describe('validate', () => {
  test('accepts a well-formed submission, trimmed', () => {
    expect(validate({ name: '  Ada Lovelace ', email: ' ada@example.com ', message: '\n Hello there. \n' })).toEqual({
      ok: true,
      value: ok,
    });
  });

  test('requires every field', () => {
    expect(errorsFor({ name: '', email: '', message: '' })).toEqual(['email', 'message', 'name']);
    expect(errorsFor({ ...ok, name: '   ' })).toEqual(['name']);
  });

  test('treats non-string values as missing', () => {
    expect(errorsFor({ name: new Blob(['x']), email: null, message: undefined })).toEqual(['email', 'message', 'name']);
  });

  test('enforces each limit exactly', () => {
    expect(errorsFor({ ...ok, name: 'x'.repeat(LIMITS.name) })).toEqual([]);
    expect(errorsFor({ ...ok, name: 'x'.repeat(LIMITS.name + 1) })).toEqual(['name']);
    expect(errorsFor({ ...ok, message: 'x'.repeat(LIMITS.message) })).toEqual([]);
    expect(errorsFor({ ...ok, message: 'x'.repeat(LIMITS.message + 1) })).toEqual(['message']);
    expect(errorsFor({ ...ok, email: `${'a'.repeat(LIMITS.email - 12)}@example.com` })).toEqual([]);
    expect(errorsFor({ ...ok, email: `${'a'.repeat(LIMITS.email - 11)}@example.com` })).toEqual(['email']);
  });

  // Review focus 1: the browser's maxlength counts UTF-16 code units, so the server must too,
  // or a form the browser accepted comes back rejected.
  test('counts length in UTF-16 code units, as maxlength does', () => {
    expect(errorsFor({ ...ok, name: '😀'.repeat(LIMITS.name / 2) })).toEqual([]);
    expect(errorsFor({ ...ok, name: `${'😀'.repeat(LIMITS.name / 2)}x` })).toEqual(['name']);
  });

  test.each(['Zoë Ångström', '山田太郎', 'Siân O’Neill', 'José-María', 'مريم'])('accepts the name %s', (name) => {
    expect(errorsFor({ ...ok, name })).toEqual([]);
  });

  test.each(['Ada\r\nBcc: x@example.com', 'Ada\nLovelace', 'Ada\u0000', 'Ada\u007f'])(
    'rejects control characters in the name: %j',
    (name) => {
      expect(errorsFor({ ...ok, name })).toEqual(['name']);
    },
  );

  // Ruling 109: whole Unicode categories, not a list. Cc is C0, DEL and C1 (NEL, CSI); Cf holds the
  // bidi controls, zero-width characters, the soft hyphen and the tag characters; Zl and Zp are
  // U+2028 and U+2029. Each sits mid-name, because trim() would remove some of them at either end.
  test.each([
    ['NEL', 'Ada\u0085Bcc: x@example.com'],
    ['CSI', 'Ada\u009B31m'],
    ['U+2028', 'Ada\u2028Email: boss@example.com'],
    ['U+2029', 'Ada\u2029Lovelace'],
    ['RLO and PDF', 'Ada \u202Egro.elpmaxe\u202C'],
    ['an isolate', 'Ada \u2067x\u2069'],
    ['LRM', 'Ada\u200ELovelace'],
    ['a zero-width space', 'Ada\u200BLovelace'],
    ['a zero-width no-break space', 'Ada\uFEFFLovelace'],
    ['a soft hyphen', 'Ada\u00ADLovelace'],
    ['a tag character', 'Ada\u{E0041}Lovelace'],
  ])('refuses %s in the name', (_label, name) => {
    expect(validate({ ...ok, name })).toEqual({ ok: false, errors: { name: 'Your name contains characters we can’t accept.' } });
  });

  test.each([
    ['ZWNJ, as in a Persian name', 'علی\u200Cرضا'],
    ['ZWJ, as in Sinhala', 'ශ්\u200Dරී'],
    ['a variation selector', 'Ada ❤\uFE0F'],
  ])('accepts %s in the name', (_label, name) => {
    expect(validate({ ...ok, name })).toEqual({ ok: true, value: { ...ok, name } });
  });

  test.each([
    'ada@example.com\r\nBcc: x@example.com',
    'ada lovelace@example.com',
    'ada@example',
    '@example.com',
    'ada@',
    'a@b@example.com',
  ])('rejects the email %j', (email) => {
    expect(errorsFor({ ...ok, email })).toEqual(['email']);
  });

  test.each([
    ['CR and LF', 'ada@example.com\r\nBcc: x@example.com'],
    ['NEL', 'ada\u0085@example.com'],
    ['U+2028', 'ada\u2028x@example.com'],
    ['U+2029', 'ada\u2029x@example.com'],
    ['RLO', 'ada\u202E@example.com'],
    ['a zero-width space', 'ada\u200B@example.com'],
    ['ZWNJ', 'ada\u200C@example.com'],
    ['a soft hyphen', 'ada@exam\u00ADple.com'],
    ['a tag character', 'ada@example.com\u{E0041}'],
  ])('refuses %s in the email, saying so', (_label, email) => {
    expect(validate({ ...ok, email })).toEqual({ ok: false, errors: { email: 'Your email address contains characters we can’t accept.' } });
  });

  test.each([
    ['a display name', '"IT-Support"<attacker@example.net>'],
    ['angle brackets', '<ada@example.com>'],
    ['a group', 'g:ada@example.com;'],
    ['a list', 'ada@example.com,boss@example.com'],
    ['a comma', 'a,boss@example.com'],
    ['a semicolon', 'ada;x@example.com'],
    ['a colon', 'ada:x@example.com'],
    ['a quoted local part', '"ada"@example.com'],
    ['a comment', 'ada(comment)@example.com'],
    ['a leading dot', '.ada@example.com'],
    ['two dots in a row', 'ada..lovelace@example.com'],
    ['a dot before the @', 'ada.@example.com'],
    ['an empty domain label', 'ada@example..com'],
    ['a domain literal', 'ada@[192.0.2.1]'],
    ['a full-width angle bracket', 'ada＜x@example.com'],
  ])('refuses an email that is not a bare address: %s', (_label, email) => {
    expect(validate({ ...ok, email })).toEqual({ ok: false, errors: { email: 'Please enter a valid email address.' } });
  });

  test.each([
    'ada+enquiries@example.com',
    'ada.lovelace@mail.example.co.uk',
    "o'neill@example.com",
    "!#$%&'*+/=?^_`{|}~-@example.com",
    'zoë@bücher.example',
  ])('accepts the bare address %s', (email) => {
    expect(validate({ ...ok, email })).toEqual({ ok: true, value: { ...ok, email } });
  });

  test('normalises CRLF to LF and strips control characters from the message, keeping newlines and tabs', () => {
    expect(validate({ ...ok, message: 'Line one\r\nLine two\tTabbed\u0007' })).toEqual({
      ok: true,
      value: { ...ok, message: 'Line one\nLine two\tTabbed' },
    });
  });

  // The message is stripped, never refused, so a long message is not lost to an invisible character.
  test.each([
    ['C1 controls (NEL, CSI)', 'one\u0085two\u009Bthree'],
    ['U+2028 and U+2029', 'one\u2028two\u2029three'],
    ['the bidi embeddings and overrides', 'one\u202Atwo\u202Bthree\u202C\u202D\u202E'],
    ['the bidi isolates', 'one\u2066two\u2067three\u2068\u2069'],
  ])('strips %s from the message', (_label, message) => {
    expect(validate({ ...ok, message })).toEqual({ ok: true, value: { ...ok, message: 'onetwothree' } });
  });

  test('keeps ZWNJ, ZWJ, variation selectors and emoji tag sequences in the message', () => {
    const message = 'می\u200Cخواهم 👩\u200D💻 ❤\uFE0F 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(validate({ ...ok, message })).toEqual({ ok: true, value: { ...ok, message } });
  });

  test('measures the message after CRLF normalisation', () => {
    // 2,500 × "a\r\n" is 7,500 code units as submitted and 5,000 once normalised (4,999 trimmed).
    expect(errorsFor({ ...ok, message: 'a\r\n'.repeat(LIMITS.message / 2) })).toEqual([]);
  });
});
