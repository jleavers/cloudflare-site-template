import type { SiteConfig } from '../../src/config/site';

export const TEMPLATE_WORKER_NAME = 'cloudflare-site-template';
export const EXAMPLE_SITE_NAME = 'Example Co.';
const TURNSTILE_TEST_KEY = /^[123]x0{20}[A-Z]{2}$/;

export interface RouteObject {
  pattern: string;
  custom_domain?: boolean;
  zone_name?: string;
}
type Route = string | RouteObject;
export interface WranglerConfig {
  name?: string;
  workers_dev?: boolean;
  route?: Route;
  routes?: Route[];
  vars?: Record<string, string>;
  env?: Record<string, WranglerConfig>;
}
export interface PreflightInput {
  wrangler: WranglerConfig;
  site: Pick<SiteConfig, 'name' | 'url' | 'contact'>;
  designPresent: boolean;
  /** Placeholders found in the built pages (see findPlaceholders), with the page each is on. */
  placeholders: { page: string; text: string }[];
}
export interface PreflightResult {
  mode: 'demo' | 'production';
  errors: string[];
  warnings: string[];
  /** Demo mode only: template values still present, which a production deploy would refuse. */
  notes: string[];
}

export const STALE_URL_WARNING =
  'site.url is still example.com, but this is no longer the template: set site.url to this site\'s address (custom domain or workers.dev)';

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const TAG = /<\/?[a-zA-Z][^\s>/]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
const PLACEHOLDER = /\[[^[\]<>"\n]{1,60}\]/g;

/**
 * The `[Bracketed placeholders]` a design leaves for facts it did not know, found in a built
 * page's visible text: not in scripts, styles, comments or attributes.
 */
export function findPlaceholders(html: string): string[] {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(TAG, '\n')
    .replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity]);
  return (text.match(PLACEHOLDER) ?? []).filter((candidate) => /\p{L}/u.test(candidate));
}

const isExampleHost = (host: string) => host === 'example.com' || host.endsWith('.example.com');
/** The address inside <…> when there is one ("Name <a@b.test>"), otherwise the whole value. */
const domainOf = (email: string | undefined) => ((email?.match(/<([^<>]*)>/)?.[1] ?? email)?.split('@')[1] ?? '').trim().toLowerCase();

/** The host of every route, at the top level and in every env.* block. A route string's host is the part before the first "/". */
function routeHosts(config: WranglerConfig): string[] {
  const routes = [...(config.route === undefined ? [] : [config.route]), ...(config.routes ?? [])];
  const own = routes.map((route) => (typeof route === 'string' ? route : route.pattern).split('/')[0].toLowerCase());
  return [...own, ...Object.values(config.env ?? {}).flatMap(routeHosts)];
}

/**
 * Contract C7. Example values, and a design's [bracketed] placeholders, may go to a workers.dev
 * demo that delivers only to `log`, never to a live site. A site is live, and preflight is in
 * production mode, when wrangler.jsonc has any route or sets DELIVERY_PROVIDER to resend, slack
 * or teams. Without a route, production mode skips only the "site.url is one of the custom
 * domains" check.
 */
export function checkPreflight({ wrangler, site, designPresent, placeholders }: PreflightInput): PreflightResult {
  const routeHostList = routeHosts(wrangler);
  const vars = wrangler.vars ?? {};
  const siteHost = new URL(site.url).hostname.toLowerCase();
  // Trimmed, as readConfig (src/contact/config.ts) reads it: " resend " delivers for real.
  const provider = vars.DELIVERY_PROVIDER?.trim();

  const templateValues = [
    [wrangler.name === TEMPLATE_WORKER_NAME, `wrangler.jsonc "name" is still "${TEMPLATE_WORKER_NAME}"`],
    [isExampleHost(siteHost), `site.url is still on example.com (${site.url})`],
    [TURNSTILE_TEST_KEY.test(site.contact.turnstileSiteKey), 'site.contact.turnstileSiteKey is a Turnstile test key'],
    ['TURNSTILE_SECRET_KEY' in vars, 'TURNSTILE_SECRET_KEY is in wrangler.jsonc "vars": delete it there, and once CI has deployed, add it as a secret in the Cloudflare dashboard (the Worker → Settings → Variables and Secrets)'],
    [!provider || provider === 'log', `DELIVERY_PROVIDER is ${provider ? `"${provider}"` : 'missing'}: set resend, slack or teams`],
    [
      provider === 'resend' && [vars.CONTACT_TO_EMAIL, vars.CONTACT_FROM_EMAIL].some((email) => !email || isExampleHost(domainOf(email))),
      'CONTACT_TO_EMAIL and CONTACT_FROM_EMAIL must be real addresses for Resend',
    ],
    [site.name === EXAMPLE_SITE_NAME, `site.name is still "${EXAMPLE_SITE_NAME}"`],
  ] as const;
  const present: string[] = [
    ...templateValues.filter(([found]) => found).map(([, message]) => message),
    ...placeholders.map(({ page, text }) => `${page} has the placeholder ${text}`),
  ];

  // Demo mode only when nothing routes anywhere (any route of any kind, in any env, means
  // production) and delivery cannot reach a real recipient.
  const realDelivery = provider === 'resend' || provider === 'slack' || provider === 'teams';
  if (routeHostList.length === 0 && !realDelivery) {
    const errors =
      wrangler.workers_dev === false ? ['workers_dev is false and no route is set, so the deploy would have no URL'] : [];
    const isTemplate = wrangler.name === TEMPLATE_WORKER_NAME && site.name === EXAMPLE_SITE_NAME;
    const warnings = isExampleHost(siteHost) && !isTemplate ? [STALE_URL_WARNING] : [];
    return { mode: 'demo', errors, warnings, notes: present };
  }

  const errors = [...present];
  if (routeHostList.length === 0 && wrangler.workers_dev === false) {
    errors.unshift('workers_dev is false and no route is set, so the deploy would have no URL');
  }
  if (routeHostList.length > 0 && !routeHostList.includes(siteHost)) {
    errors.push(`site.url's host (${siteHost}) is not one of the custom domains (${routeHostList.join(', ')})`);
  }
  const warnings = designPresent ? [] : ['design/ has neither SOURCE.md nor bundle/: was this site built from a design?'];
  return { mode: 'production', errors, warnings, notes: [] };
}
