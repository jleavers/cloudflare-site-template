import { describe, expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { foreignInCss, foreignInHtml, repeatedAttributes } from './foreign';
import { allFiles, pages, readDist } from './helpers';

const SCRIPT_HOSTS = ['https://challenges.cloudflare.com/', 'https://static.cloudflareinsights.com/'];
const options = { siteUrl: site.url, analyticsToken: site.analytics.cloudflareToken };

describe.each(pages().map((page) => [page.route, page] as const))('page %s', (_route, page) => {
  // C3, and the CSP in public/_headers, which allows no inline script.
  test('runs only bundled scripts, plus Turnstile and the analytics beacon', () => {
    for (const script of page.root.querySelectorAll('script')) {
      // A browser keeps the first of a repeated name, and getAttribute reads the last: refuse a repeat.
      expect(repeatedAttributes(script.rawAttrs), `<script ${script.rawAttrs}>`).toEqual([]);
      const src = script.getAttribute('src');
      if (src) expect(src.startsWith('/_astro/') || SCRIPT_HOSTS.some((host) => src.startsWith(host)), src).toBe(true);
      else expect(script.getAttribute('type'), `inline script: ${script.text.slice(0, 80)}`).toBe('application/ld+json');
    }
  });

  // C3: no framework islands.
  test('has no <astro-island>', () => {
    expect(page.root.querySelectorAll('astro-island')).toHaveLength(0);
  });

  test('has no inline event-handler attributes', () => {
    for (const element of page.root.querySelectorAll('*')) {
      for (const name of Object.keys(element.attributes)) {
        expect(name.toLowerCase().startsWith('on'), `<${element.tagName.toLowerCase()} ${name}>`).toBe(false);
      }
    }
  });

  // C2: every reference that can make a browser fetch or connect stays on the site's origin
  // (the CSP in public/_headers is the backstop; this is the enforcement).
  test('references nothing from another origin', () => {
    expect(foreignInHtml(page.html, { ...options, page: new URL(page.route, site.url).href })).toEqual([]);
  });

  // C2: raster images go through <Image>, which sizes them and puts them under /_astro/.
  test('sizes every image and serves rasters from /_astro/', () => {
    for (const img of page.root.querySelectorAll('img')) {
      expect(repeatedAttributes(img.rawAttrs), `<img ${img.rawAttrs}>`).toEqual([]);
      const src = img.getAttribute('src') ?? '';
      expect(img.getAttribute('width'), src).toMatch(/^\d+$/);
      expect(img.getAttribute('height'), src).toMatch(/^\d+$/);
      expect(img.hasAttribute('alt'), `${src} has no alt attribute`).toBe(true);
      expect(src.startsWith('/_astro/') || src === '/favicon.svg', src).toBe(true);
    }
  });
});

test('no CSS file pulls anything from another origin', () => {
  for (const file of allFiles('.css')) {
    expect(foreignInCss(readDist(file), { ...options, page: new URL(`/${file}`, site.url).href, file }), file).toEqual([]);
  }
});
