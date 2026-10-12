import { describe, expect, test } from 'vitest';
import { checkPreflight, EXAMPLE_SITE_NAME, TEMPLATE_WORKER_NAME, type PreflightInput } from '../preflight/rules';

const template: PreflightInput = {
  wrangler: {
    name: TEMPLATE_WORKER_NAME,
    workers_dev: true,
    vars: { DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
  },
  site: { name: EXAMPLE_SITE_NAME, url: 'https://example.com', contact: { turnstileSiteKey: '1x00000000000000000000AA', successMessage: 'Thanks.' } },
  designPresent: false,
};

const real: PreflightInput = {
  wrangler: {
    name: 'acme-site',
    routes: [{ pattern: 'www.acme.test', custom_domain: true }],
    vars: { DELIVERY_PROVIDER: 'resend', CONTACT_TO_EMAIL: 'hi@acme.test', CONTACT_FROM_EMAIL: 'web@acme.test' },
  },
  site: { name: 'Acme', url: 'https://www.acme.test', contact: { turnstileSiteKey: '0x4AAAAAAAreal', successMessage: 'Thanks.' } },
  designPresent: true,
};

describe('demo mode (no custom domain)', () => {
  test('passes with every template value, and lists them as notes', () => {
    const result = checkPreflight(template);
    expect(result.mode).toBe('demo');
    expect(result.errors).toEqual([]);
    expect(result.notes.length).toBeGreaterThanOrEqual(5);
  });

  test('fails when workers.dev is off, because the deploy would have no URL', () => {
    expect(checkPreflight({ ...template, wrangler: { ...template.wrangler, workers_dev: false } }).errors).toHaveLength(1);
  });

  test('ignores plain route strings (zone routes are not custom domains)', () => {
    expect(checkPreflight({ ...template, wrangler: { ...template.wrangler, routes: ['example.org/*'] } }).mode).toBe('demo');
  });
});

describe('production mode (a custom domain)', () => {
  test('passes for a finished site', () => {
    expect(checkPreflight(real)).toEqual({ mode: 'production', errors: [], warnings: [], notes: [] });
  });

  test('names every template value still present', () => {
    const result = checkPreflight({ ...template, wrangler: { ...template.wrangler, routes: [{ pattern: 'example.com', custom_domain: true }] } });
    expect(result.mode).toBe('production');
    const all = result.errors.join('\n');
    for (const fragment of ['"name"', 'example.com', 'test key', 'TURNSTILE_SECRET_KEY', 'DELIVERY_PROVIDER', EXAMPLE_SITE_NAME]) {
      expect(all).toContain(fragment);
    }
  });

  test('requires site.url to be one of the custom domains', () => {
    const result = checkPreflight({ ...real, site: { ...real.site, url: 'https://acme.test' } });
    expect(result.errors.join('\n')).toMatch(/not one of the custom domains/);
  });

  test('rejects example.com addresses for Resend', () => {
    const vars = { ...real.wrangler.vars, CONTACT_TO_EMAIL: 'hello@example.com' };
    expect(checkPreflight({ ...real, wrangler: { ...real.wrangler, vars } }).errors.join('\n')).toMatch(/CONTACT_TO_EMAIL/);
  });

  test('only warns when the design is missing', () => {
    const result = checkPreflight({ ...real, designPresent: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});
