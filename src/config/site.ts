/**
 * Site-wide facts: the one home of a site's name, URL, navigation, contact settings and legal
 * details (contract C1). Page copy lives in the page files and design tokens in
 * src/styles/global.css. astro.config.mjs imports this file, so it must stay plain TypeScript:
 * no import.meta.env, no Astro or Vite APIs.
 */
export interface NavLink {
  label: string;
  href: string;
}

/** A third party that handles visitors' data, named on the privacy page. */
export interface Processor {
  name: string;
  purpose: string;
  url: string;
}

export interface SiteConfig {
  /** The organisation's name, as shown in the header and footer. */
  name: string;
  /** The default <title>; pages may set their own. */
  title: string;
  /** The default meta description. */
  description: string;
  /** Canonical origin: https, no trailing slash, no path. */
  url: string;
  /** BCP 47 language tag, e.g. "en-GB". */
  locale: string;
  nav: { header: NavLink[]; footer: NavLink[] };
  contact: {
    /** Public Turnstile site key. PR preview and local builds override it with the test key. */
    turnstileSiteKey: string;
    successMessage: string;
    /** Shown when the form cannot work: no JavaScript, or a network failure. */
    fallbackEmail?: string;
  };
  socials: NavLink[];
  legal: {
    companyName: string;
    registration?: string;
    address?: string;
    privacyEmail: string;
  };
  privacy: {
    processors: Processor[];
    /** One or two sentences: how long messages are kept, and where. */
    retention: string;
  };
  analytics: {
    /** Cloudflare Web Analytics beacon token. Leave unset for no analytics. */
    cloudflareToken?: string;
  };
}

export const site: SiteConfig = {
  name: 'Example Co.',
  title: 'Example Co. — garden design for small spaces',
  description:
    'Example Co. is a fictional garden-design studio. It shows what cloudflare-site-template builds: a fast static site with a working contact form on Cloudflare.',
  url: 'https://example.com',
  locale: 'en-GB',
  nav: {
    header: [
      { label: 'Services', href: '/#services' },
      { label: 'Stories', href: '/#stories' },
      { label: 'Questions', href: '/#faq' },
      { label: 'Contact', href: '/#contact' },
    ],
    footer: [{ label: 'Privacy', href: '/privacy/' }],
  },
  contact: {
    turnstileSiteKey: '1x00000000000000000000AA',
    successMessage: 'Thank you — your message is on its way. We reply within two working days.',
    fallbackEmail: 'hello@example.com',
  },
  socials: [{ label: 'Source on GitHub', href: 'https://github.com/jleavers/cloudflare-site-template' }],
  legal: {
    companyName: 'Example Co. Ltd',
    registration: 'A fictional company, used to demonstrate this template.',
    privacyEmail: 'privacy@example.com',
  },
  privacy: {
    processors: [
      {
        name: 'Cloudflare, Inc.',
        purpose:
          'hosts this website, and runs Turnstile, which checks that contact-form messages come from a person',
        url: 'https://www.cloudflare.com/privacypolicy/',
      },
    ],
    retention:
      'This demonstration site keeps nothing: a message is discarded as soon as it arrives, and nobody reads it.',
  },
  analytics: {},
};
