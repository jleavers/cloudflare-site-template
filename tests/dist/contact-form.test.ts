import { describe, expect, test } from 'vitest';
import { LIMITS } from '../../src/contact/validate';
import { pages } from './helpers';

const home = pages().find((page) => page.route === '/');
const forms = home?.root.querySelectorAll('form[data-contact-form]') ?? [];

// Contract C5: the markup may be restyled; this structure may not change.
describe('the contact form', () => {
  test('appears exactly once on the home page', () => expect(forms).toHaveLength(1));
  const theForm = () => {
    expect(forms, 'the home page has no form[data-contact-form]').toHaveLength(1);
    return forms[0];
  };

  test('posts to /api/contact', () => {
    const form = theForm();
    expect(form.getAttribute('action')).toBe('/api/contact');
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.getAttribute('data-state')).toBe('idle');
  });

  test.each(['name', 'email', 'message', '_gotcha'])('has the %s field', (name) => {
    const form = theForm();
    expect(form.querySelector(`[name="${name}"]`)).not.toBeNull();
  });

  test("its limits match the server's", () => {
    const form = theForm();
    expect(form.querySelector('[name="name"]')?.getAttribute('maxlength')).toBe(String(LIMITS.name));
    expect(form.querySelector('[name="email"]')?.getAttribute('maxlength')).toBe(String(LIMITS.email));
    expect(form.querySelector('[name="message"]')?.getAttribute('maxlength')).toBe(String(LIMITS.message));
  });

  test('keeps the honeypot out of the tab order and autofill', () => {
    const form = theForm();
    const gotcha = form.querySelector('[name="_gotcha"]');
    expect(gotcha?.getAttribute('tabindex')).toBe('-1');
    expect(gotcha?.getAttribute('autocomplete')).toBe('off');
  });

  test('has a Turnstile container with a site key, a disabled submit and a live status region', () => {
    const form = theForm();
    expect(form.querySelector('[data-turnstile]')?.getAttribute('data-sitekey')).toBeTruthy();
    expect(form.querySelector('[data-submit]')?.hasAttribute('disabled')).toBe(true);
    const status = form.querySelector('[data-status]');
    expect(status?.getAttribute('role') === 'status' || status?.getAttribute('aria-live') === 'polite').toBe(true);
  });

  test('explains itself without JavaScript', () => expect(theForm().querySelector('noscript')).not.toBeNull());

  test('keeps a space between the noscript sentences', () => {
    const text = (theForm().querySelector('noscript')?.innerHTML ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('JavaScript. Please');
    expect(text).not.toContain('JavaScript.Please');
  });

  test.each(['name', 'email', 'message'])('has an error slot for %s', (field) => {
    expect(theForm().querySelector(`[data-error-for="${field}"]`), `missing [data-error-for="${field}"]`).not.toBeNull();
  });

  test.each(['name', 'email', 'message'])('wires %s to ids that exist in the form via aria-describedby', (field) => {
    const form = theForm();
    const ids = (form.querySelector(`[name="${field}"]`)?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length, `${field} has no aria-describedby`).toBeGreaterThan(0);
    for (const id of ids) expect(form.querySelector(`[id="${id}"]`), `no #${id} in the form`).not.toBeNull();
  });

  test('hides the honeypot from assistive technology', () => {
    const form = theForm();
    let node = form.querySelector('[name="_gotcha"]')?.parentNode;
    let hidden = false;
    while (node && node !== form) {
      if ((node as unknown as { getAttribute?: (n: string) => string | undefined }).getAttribute?.('aria-hidden') === 'true') hidden = true;
      node = node.parentNode;
    }
    expect(hidden, 'the _gotcha field has no aria-hidden="true" ancestor inside the form').toBe(true);
  });

  test('loads its script as a bundled module', () => {
    expect(home?.root.querySelectorAll('script[type="module"]').some((s) => s.getAttribute('src')?.startsWith('/_astro/'))).toBe(true);
  });
});
