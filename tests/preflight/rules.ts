import type { SiteConfig } from '../../src/config/site';

export const TEMPLATE_WORKER_NAME = 'cloudflare-site-template';
export const EXAMPLE_SITE_NAME = 'Example Co.';
const TURNSTILE_TEST_KEY = /^[123]x0{20}[A-Z]{2}$/;

type Route = string | { pattern: string; custom_domain?: boolean; zone_name?: string };
export interface WranglerConfig {
  name?: string;
  workers_dev?: boolean;
  routes?: Route[];
  vars?: Record<string, string>;
}
export interface PreflightInput {
  wrangler: WranglerConfig;
  site: Pick<SiteConfig, 'name' | 'url' | 'contact'>;
  designPresent: boolean;
}
export interface PreflightResult {
  mode: 'demo' | 'production';
  errors: string[];
  warnings: string[];
  /** Demo mode only: template values still present, which a production deploy would refuse. */
  notes: string[];
}

const isExampleHost = (host: string) => host === 'example.com' || host.endsWith('.example.com');
const domainOf = (email: string | undefined) => email?.split('@')[1] ?? '';

/**
 * Contract C7. Example values may go to workers.dev (the demo, the Deploy button, a first
 * experiment) but never to a custom domain.
 */
export function checkPreflight({ wrangler, site, designPresent }: PreflightInput): PreflightResult {
  const customDomains = (wrangler.routes ?? [])
    .filter((route): route is Exclude<Route, string> => typeof route === 'object' && route.custom_domain === true)
    .map((route) => route.pattern);
  const vars = wrangler.vars ?? {};
  const siteHost = new URL(site.url).hostname;
  const provider = vars.DELIVERY_PROVIDER;

  const templateValues = [
    [wrangler.name === TEMPLATE_WORKER_NAME, `wrangler.jsonc "name" is still "${TEMPLATE_WORKER_NAME}"`],
    [isExampleHost(siteHost), `site.url is still on example.com (${site.url})`],
    [TURNSTILE_TEST_KEY.test(site.contact.turnstileSiteKey), 'site.contact.turnstileSiteKey is a Turnstile test key'],
    ['TURNSTILE_SECRET_KEY' in vars, 'TURNSTILE_SECRET_KEY is in wrangler.jsonc "vars": delete it there and run `npx wrangler secret put TURNSTILE_SECRET_KEY`'],
    [!provider || provider === 'log', `DELIVERY_PROVIDER is ${provider ? `"${provider}"` : 'missing'}: set resend, slack or teams`],
    [
      provider === 'resend' && [vars.CONTACT_TO_EMAIL, vars.CONTACT_FROM_EMAIL].some((email) => !email || isExampleHost(domainOf(email))),
      'CONTACT_TO_EMAIL and CONTACT_FROM_EMAIL must be real addresses for Resend',
    ],
    [site.name === EXAMPLE_SITE_NAME, `site.name is still "${EXAMPLE_SITE_NAME}"`],
  ] as const;
  const present: string[] = templateValues.filter(([found]) => found).map(([, message]) => message);

  if (customDomains.length === 0) {
    const errors =
      wrangler.workers_dev === false ? ['workers_dev is false and no custom domain is set, so the deploy would have no URL'] : [];
    return { mode: 'demo', errors, warnings: [], notes: present };
  }

  const errors = [...present];
  if (!customDomains.includes(siteHost)) {
    errors.push(`site.url's host (${siteHost}) is not one of the custom domains (${customDomains.join(', ')})`);
  }
  const warnings = designPresent ? [] : ['design/ has neither SOURCE.md nor bundle/: was this site built from a design?'];
  return { mode: 'production', errors, warnings, notes: [] };
}
