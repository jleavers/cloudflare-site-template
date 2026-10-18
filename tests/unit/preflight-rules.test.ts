import { describe, expect, test } from 'vitest';
import { checkPreflight, findPlaceholders, EXAMPLE_SITE_NAME, STALE_URL_WARNING, TEMPLATE_WORKER_NAME, type PreflightInput, type WranglerConfig } from '../preflight/rules';

const template: PreflightInput = {
  wrangler: {
    name: TEMPLATE_WORKER_NAME,
    workers_dev: true,
    vars: { DELIVERY_PROVIDER: 'log', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
  },
  site: { name: EXAMPLE_SITE_NAME, url: 'https://example.com', contact: { turnstileSiteKey: '1x00000000000000000000AA', successMessage: 'Thanks.' } },
  designPresent: false,
  placeholders: [],
};

const real: PreflightInput = {
  wrangler: {
    name: 'acme-site',
    routes: [{ pattern: 'www.acme.test', custom_domain: true }],
    vars: { DELIVERY_PROVIDER: 'resend', CONTACT_TO_EMAIL: 'hi@acme.test', CONTACT_FROM_EMAIL: 'web@acme.test' },
  },
  site: { name: 'Acme', url: 'https://www.acme.test', contact: { turnstileSiteKey: '0x4AAAAAAAreal', successMessage: 'Thanks.' } },
  designPresent: true,
  placeholders: [],
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

  test('warns, without failing, when site.url is example.com but the site is no longer the template', () => {
    const renamed = { ...template, site: { ...template.site, name: 'Acme' } };
    const result = checkPreflight(renamed);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([STALE_URL_WARNING]);
    const renamedWorker = checkPreflight({ ...template, wrangler: { ...template.wrangler, name: 'acme-site' } });
    expect(renamedWorker.warnings).toEqual([STALE_URL_WARNING]);
  });

  test('does not warn about site.url on the untouched template', () => {
    expect(checkPreflight(template).warnings).toEqual([]);
  });

  test('does not warn once site.url is the site\'s own workers.dev address', () => {
    const own = { ...template, site: { ...template.site, name: 'Acme', url: 'https://acme.sub.workers.dev' } };
    expect(checkPreflight(own).warnings).toEqual([]);
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

  describe.each<[string, WranglerConfig]>([
    ['a zone route string', { routes: ['www.acme.test/*'] }],
    ['a { pattern, zone_name } route', { routes: [{ pattern: 'www.acme.test/*', zone_name: 'acme.test' }] }],
    ['the singular route key', { route: 'www.acme.test/*' }],
    ['a route only under env.production', { env: { production: { routes: [{ pattern: 'www.acme.test', custom_domain: true }] } } }],
    ['a singular route only under env.production', { env: { production: { route: { pattern: 'www.acme.test/*', zone_name: 'acme.test' } } } }],
  ])('any route is production mode: %s', (_name, routing) => {
    test('is production mode and names every template value', () => {
      const result = checkPreflight({ ...template, wrangler: { ...template.wrangler, ...routing } });
      expect(result.mode).toBe('production');
      expect(result.errors.join('\n')).toContain('DELIVERY_PROVIDER');
    });

    test('passes for a finished site', () => {
      const result = checkPreflight({ ...real, wrangler: { ...real.wrangler, routes: undefined, ...routing } });
      expect(result).toEqual({ mode: 'production', errors: [], warnings: [], notes: [] });
    });
  });

  test('an empty routes array is still demo mode', () => {
    expect(checkPreflight({ ...template, wrangler: { ...template.wrangler, routes: [] } }).mode).toBe('demo');
  });

  test('matches an uppercase route pattern to a lowercase site.url, and uppercase email domains', () => {
    const wrangler = {
      ...real.wrangler,
      routes: [{ pattern: 'WWW.Acme.Test', custom_domain: true }],
      vars: { ...real.wrangler.vars, CONTACT_TO_EMAIL: 'hi@ACME.test', CONTACT_FROM_EMAIL: 'web@Example.COM' },
    };
    const result = checkPreflight({ ...real, wrangler });
    expect(result.errors.join('\n')).not.toMatch(/custom domains/);
    expect(result.errors.join('\n')).toMatch(/CONTACT_FROM_EMAIL/);
  });

  test('rejects a subdomain of example.com for the site URL and addresses', () => {
    const wrangler = {
      ...real.wrangler,
      routes: [{ pattern: 'www.example.com', custom_domain: true }],
      vars: { ...real.wrangler.vars, CONTACT_TO_EMAIL: 'hi@mail.example.com' },
    };
    const result = checkPreflight({ ...real, wrangler, site: { ...real.site, url: 'https://www.example.com' } });
    expect(result.errors.join('\n')).toMatch(/example\.com \(https:\/\/www\.example\.com\)/);
    expect(result.errors.join('\n')).toMatch(/CONTACT_TO_EMAIL/);
  });

  test('takes the host from a zone route string', () => {
    const wrangler = { ...real.wrangler, routes: ['www.acme.test/*'] };
    expect(checkPreflight({ ...real, wrangler }).errors).toEqual([]);
  });

  test('only warns when the design is missing', () => {
    const result = checkPreflight({ ...real, designPresent: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('production mode (real delivery, no route)', () => {
  const live: PreflightInput = {
    wrangler: {
      name: 'acme-site',
      workers_dev: true,
      vars: { DELIVERY_PROVIDER: 'resend', CONTACT_TO_EMAIL: 'hi@acme.test', CONTACT_FROM_EMAIL: 'web@acme.test' },
    },
    site: { name: 'Acme', url: 'https://acme.sub.workers.dev', contact: { turnstileSiteKey: '0x4AAAAAAAreal', successMessage: 'Thanks.' } },
    designPresent: true,
    placeholders: [],
  };

  test('workers.dev with resend and real values passes, in production mode', () => {
    expect(checkPreflight(live)).toEqual({ mode: 'production', errors: [], warnings: [], notes: [] });
  });

  test.each(['resend', 'slack', 'teams'])('%s starts production mode', (provider) => {
    const result = checkPreflight({ ...live, wrangler: { ...live.wrangler, vars: { ...live.wrangler.vars, DELIVERY_PROVIDER: provider } } });
    expect(result.mode).toBe('production');
  });

  // readConfig trims the provider, so " resend " delivers for real: preflight must read it the same way.
  test.each([' resend ', '\tslack', 'teams\n'])('%j, padded, starts production mode too', (provider) => {
    const result = checkPreflight({ ...template, wrangler: { ...template.wrangler, vars: { ...template.wrangler.vars, DELIVERY_PROVIDER: provider } } });
    expect(result.mode).toBe('production');
    expect(result.errors.join('\n')).toContain('TURNSTILE_SECRET_KEY');
  });

  test('the test secret left in vars is an error', () => {
    const vars = { ...live.wrangler.vars, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
    const result = checkPreflight({ ...live, wrangler: { ...live.wrangler, vars } });
    expect(result.mode).toBe('production');
    expect(result.errors.join('\n')).toContain('TURNSTILE_SECRET_KEY');
  });

  test('a placeholder is an error naming the page', () => {
    const result = checkPreflight({ ...live, placeholders: [{ page: 'about/index.html', text: '[Your address]' }] });
    expect(result.errors).toEqual(['about/index.html has the placeholder [Your address]']);
  });

  test('template values are errors too', () => {
    const result = checkPreflight({ ...live, site: { ...live.site, name: EXAMPLE_SITE_NAME, url: 'https://example.com' } });
    const all = result.errors.join('\n');
    expect(all).toContain(EXAMPLE_SITE_NAME);
    expect(all).toContain('example.com');
    expect(all).not.toMatch(/custom domains/);
  });

  test('workers_dev false with no route still has no URL', () => {
    const result = checkPreflight({ ...live, wrangler: { ...live.wrangler, workers_dev: false } });
    expect(result.errors).toContain('workers_dev is false and no route is set, so the deploy would have no URL');
  });

  test('still warns when design/ is missing', () => {
    expect(checkPreflight({ ...live, designPresent: false }).warnings).toHaveLength(1);
  });

  test('log on workers.dev stays demo mode with notes only; log with a route is production', () => {
    const demo = checkPreflight(template);
    expect(demo.mode).toBe('demo');
    expect(demo.errors).toEqual([]);
    expect(demo.notes.length).toBeGreaterThan(0);
    const routed = checkPreflight({ ...template, wrangler: { ...template.wrangler, routes: [{ pattern: 'www.acme.test', custom_domain: true }] } });
    expect(routed.mode).toBe('production');
  });
});

describe('findPlaceholders', () => {
  const found = (text: string) => findPlaceholders(`<p>${text}</p>`);

  test.each([
    ['[Phone number]', ['[Phone number]']],
    ['[hello@your-domain]', ['[hello@your-domain]']],
    ['[Number] Harbour Lane', ['[Number]']],
    ['[Town] [POSTCODE]', ['[Town]', '[POSTCODE]']],
    ['[Closed]', ['[Closed]']],
    ['Within [one working day], with the total', ['[one working day]']],
    ['[Customer name], local', ['[Customer name]']],
    ['about [5 minutes’] walk', ['[5 minutes’]']],
    ['by [lunchtime].', ['[lunchtime]']],
    ['Tom &amp; [Jerry&#39;s]', ['[Jerry\'s]']],
  ])('finds %s', (text, expected) => expect(found(text)).toEqual(expected));

  test('finds a placeholder across element boundaries without joining them', () => {
    expect(findPlaceholders('<p>[Town]</p><p>[POSTCODE]</p>')).toEqual(['[Town]', '[POSTCODE]']);
  });

  test.each([
    ['a bare number', '<p>[1]</p>'],
    ['an attribute', '<a aria-label="[Phone number]" href="#">x</a>'],
    ['a script', '<script type="application/ld+json">{"a":["[Town]"]}</script>'],
    ['a style', '<style>[data-state="sent"]{}</style>'],
    ['a comment', '<!-- [note] -->'],
    ['text over 60 characters', `<p>[${'a'.repeat(61)}]</p>`],
  ])('finds nothing in %s', (_name, html) => expect(findPlaceholders(html)).toEqual([]));
});

describe('placeholders (C7)', () => {
  const placeholders = [{ page: 'contact/index.html', text: '[Phone number]' }];

  test('are an error in production mode, naming the page and the text', () => {
    const result = checkPreflight({ ...real, placeholders });
    expect(result.mode).toBe('production');
    expect(result.errors.some((error) => error.includes('contact/index.html') && error.includes('[Phone number]'))).toBe(true);
  });

  test('are a note, not an error, in demo mode', () => {
    const result = checkPreflight({ ...template, placeholders });
    expect(result.errors).toEqual([]);
    expect(result.notes.some((note) => note.includes('contact/index.html') && note.includes('[Phone number]'))).toBe(true);
  });

  test('add nothing when there are none', () => {
    expect(checkPreflight(real).errors).toEqual([]);
  });
});

describe('a display name in CONTACT_FROM_EMAIL', () => {
  const withFrom = (from: string): PreflightInput => ({ ...real, wrangler: { ...real.wrangler, vars: { ...real.wrangler.vars, CONTACT_FROM_EMAIL: from } } });

  test('does not hide an example.com address', () => {
    const result = checkPreflight(withFrom('Example Co. <hello@example.com>'));
    expect(result.errors).toContain('CONTACT_TO_EMAIL and CONTACT_FROM_EMAIL must be real addresses for Resend');
  });

  test('passes with a real address', () => {
    expect(checkPreflight(withFrom('Acme <web@acme.test>')).errors).toEqual([]);
  });
});
