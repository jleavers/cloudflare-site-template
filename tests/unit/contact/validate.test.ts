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

  test('normalises CRLF to LF and strips control characters from the message, keeping newlines and tabs', () => {
    expect(validate({ ...ok, message: 'Line one\r\nLine two\tTabbed\u0007' })).toEqual({
      ok: true,
      value: { ...ok, message: 'Line one\nLine two\tTabbed' },
    });
  });

  test('measures the message after CRLF normalisation', () => {
    // 2,500 × "a\r\n" is 7,500 code units as submitted and 5,000 once normalised (4,999 trimmed).
    expect(errorsFor({ ...ok, message: 'a\r\n'.repeat(LIMITS.message / 2) })).toEqual([]);
  });
});
