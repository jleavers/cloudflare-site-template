import { describe, expect, test } from 'vitest';
import { successText } from '../../src/scripts/success-message';

describe('successText', () => {
  test('leaves a message without the token unchanged', () => {
    expect(successText('Thanks.', 'ada@example.com')).toBe('Thanks.');
  });

  test('fills one token', () => {
    expect(successText('We’ll reply to {email} soon.', 'ada@example.com')).toBe('We’ll reply to ada@example.com soon.');
  });

  test('fills every token', () => {
    expect(successText('{email}, yes {email}.', 'a@b.test')).toBe('a@b.test, yes a@b.test.');
  });

  test.each(['a$&b@example.com', 'a$1@example.com', "a$'b$`c@example.com", 'a$$b@example.com'])('inserts %s literally', (address) => {
    expect(successText('To {email}.', address)).toBe(`To ${address}.`);
  });
});
