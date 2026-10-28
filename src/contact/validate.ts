export interface Submission {
  name: string;
  email: string;
  message: string;
}
export type FieldErrors = Partial<Record<keyof Submission, string>>;

/** In UTF-16 code units, as the browser's maxlength counts. ContactForm uses the same numbers. */
export const LIMITS = { name: 100, email: 254, message: 5000 } as const;

// Whole Unicode categories (spec §7.3 step 5). Cc is C0, DEL and C1 (NEL, CSI); Cf holds the bidi
// controls, zero-width characters, the soft hyphen and the tag characters; Zl and Zp are U+2028
// and U+2029. Any of them can hide text or change how the text around it displays.

/** ZWNJ and ZWJ (U+200C, U+200D) are the Cf characters Persian and Indic names need. */
const NAME_REFUSES = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}/u;
/**
 * Default-ignorable code points render as nothing (U+034F, the Hangul fillers, unassigned ones),
 * but for ZWNJ, ZWJ, the variation selectors (emoji presentation; CJK ideographic variants in
 * Japanese names) and the Mongolian free variation selectors.
 */
const NAME_IGNORABLE = /(?![\u180B-\u180F\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}/u;
/** No script stacks more than 8 combining marks on one letter. */
const MARK_PILE = /\p{M}{9}/u;
const LETTER = /\p{L}/u;
const EMAIL_REFUSES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** "=?" opens an RFC 2047 encoded-word, which a mail client decodes in a header. No name or address needs it. */
const ENCODED_WORD = /=\?/;
/** Stripped, not refused, so a long message is never lost to an invisible character. */
const MESSAGE_STRIPS = /(?![\t\n])\p{Cc}|[\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/gu;

// A bare address: a dot-atom local part, "@", and two or more domain labels. No quoted local part,
// comment, display name, angle brackets, group or list. Letters, marks and digits may be non-ASCII
// in both parts, for internationalised addresses; other non-ASCII characters may not.
const ATEXT = "[\\p{L}\\p{M}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[\\p{L}\\p{M}\\p{N}-]+';
const BARE_ADDRESS = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})+$`, 'u');

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function validate(input: {
  name?: unknown;
  email?: unknown;
  message?: unknown;
}): { ok: true; value: Submission } | { ok: false; errors: FieldErrors } {
  const name = text(input.name).trim();
  const email = text(input.email).trim();
  const message = text(input.message).replace(/\r\n?/g, '\n').replace(MESSAGE_STRIPS, '').trim();
  const errors: FieldErrors = {};

  if (name === '') errors.name = 'Please enter your name.';
  else if (name.length > LIMITS.name) errors.name = `Please keep your name to ${LIMITS.name} characters or fewer.`;
  else if ([NAME_REFUSES, NAME_IGNORABLE, MARK_PILE, ENCODED_WORD].some((rule) => rule.test(name)) || !LETTER.test(name)) {
    errors.name = 'Your name contains characters we can’t accept.';
  }

  // A refused character gets its own error: the address it hides in can look valid.
  if (email === '') errors.email = 'Please enter your email address.';
  else if (EMAIL_REFUSES.test(email) || ENCODED_WORD.test(email)) {
    errors.email = 'Your email address contains characters we can’t accept.';
  } else if (email.length > LIMITS.email || !BARE_ADDRESS.test(email)) errors.email = 'Please enter a valid email address.';

  if (message === '') errors.message = 'Please enter a message.';
  else if (message.length > LIMITS.message) {
    errors.message = `Please keep your message to ${LIMITS.message} characters or fewer.`;
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, email, message } };
}
