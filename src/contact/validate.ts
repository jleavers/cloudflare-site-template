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
const EMAIL_REFUSES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
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
  else if (NAME_REFUSES.test(name)) errors.name = 'Your name contains characters we can’t accept.';

  // A control, format or separator character gets its own error: the address it hides in can look valid.
  if (email === '') errors.email = 'Please enter your email address.';
  else if (EMAIL_REFUSES.test(email)) errors.email = 'Your email address contains characters we can’t accept.';
  else if (email.length > LIMITS.email || !BARE_ADDRESS.test(email)) errors.email = 'Please enter a valid email address.';

  if (message === '') errors.message = 'Please enter a message.';
  else if (message.length > LIMITS.message) {
    errors.message = `Please keep your message to ${LIMITS.message} characters or fewer.`;
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, email, message } };
}
