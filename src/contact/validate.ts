export interface Submission {
  name: string;
  email: string;
  message: string;
}
export type FieldErrors = Partial<Record<keyof Submission, string>>;

/** In UTF-16 code units, as the browser's maxlength counts. ContactForm uses the same numbers. */
export const LIMITS = { name: 100, email: 254, message: 5000 } as const;

const ANY_CONTROL = /[\u0000-\u001F\u007F]/;
const CONTROL_EXCEPT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function validate(input: {
  name?: unknown;
  email?: unknown;
  message?: unknown;
}): { ok: true; value: Submission } | { ok: false; errors: FieldErrors } {
  const name = text(input.name).trim();
  const email = text(input.email).trim();
  const message = text(input.message).replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_TAB_AND_NEWLINE, '').trim();
  const errors: FieldErrors = {};

  if (name === '') errors.name = 'Please enter your name.';
  else if (name.length > LIMITS.name) errors.name = `Please keep your name to ${LIMITS.name} characters or fewer.`;
  else if (ANY_CONTROL.test(name)) errors.name = 'Your name contains characters we can’t accept.';

  if (email === '') errors.email = 'Please enter your email address.';
  else if (email.length > LIMITS.email || ANY_CONTROL.test(email) || !EMAIL.test(email)) {
    errors.email = 'Please enter a valid email address.';
  }

  if (message === '') errors.message = 'Please enter a message.';
  else if (message.length > LIMITS.message) {
    errors.message = `Please keep your message to ${LIMITS.message} characters or fewer.`;
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, email, message } };
}
