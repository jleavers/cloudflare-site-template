import { describe, expect, test } from 'vitest';
import { allFiles, pages, readDist } from './helpers';

const SCRIPT_HOSTS = ['https://challenges.cloudflare.com/', 'https://static.cloudflareinsights.com/'];
const FOREIGN_URL = /url\(\s*['"]?(https?:)?\/\//;

describe.each(pages().map((page) => [page.route, page] as const))('page %s', (_route, page) => {
  // C3, and the CSP in public/_headers, which allows no inline script.
  test('runs only bundled scripts, plus Turnstile and the analytics beacon', () => {
    for (const script of page.root.querySelectorAll('script')) {
      const src = script.getAttribute('src');
      if (src) expect(src.startsWith('/_astro/') || SCRIPT_HOSTS.some((host) => src.startsWith(host)), src).toBe(true);
      else expect(script.getAttribute('type'), `inline script: ${script.text.slice(0, 80)}`).toBe('application/ld+json');
    }
  });

  test('has no inline event-handler attributes', () => {
    for (const element of page.root.querySelectorAll('*')) {
      for (const name of Object.keys(element.attributes)) {
        expect(name.toLowerCase().startsWith('on'), `<${element.tagName.toLowerCase()} ${name}>`).toBe(false);
      }
    }
  });

  // C2: fonts and styles are self-hosted.
  test('loads no stylesheet, font or connection from another host', () => {
    for (const link of page.root.querySelectorAll('link')) {
      const rel = link.getAttribute('rel') ?? '';
      if (['stylesheet', 'preload', 'preconnect', 'dns-prefetch', 'modulepreload'].includes(rel)) {
        expect(link.getAttribute('href') ?? '', rel).toMatch(/^\/(?!\/)/);
      }
    }
    for (const style of page.root.querySelectorAll('style')) expect(style.text).not.toMatch(FOREIGN_URL);
  });

  // C2: raster images go through <Image>, which sizes them and puts them under /_astro/.
  test('sizes every image and serves rasters from /_astro/', () => {
    for (const img of page.root.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      expect(img.getAttribute('width'), src).toMatch(/^\d+$/);
      expect(img.getAttribute('height'), src).toMatch(/^\d+$/);
      expect(img.hasAttribute('alt'), `${src} has no alt attribute`).toBe(true);
      expect(src.startsWith('/_astro/') || src.endsWith('.svg'), src).toBe(true);
    }
  });
});

test('no CSS file pulls anything from another host', () => {
  for (const file of allFiles('.css')) expect(readDist(file), file).not.toMatch(FOREIGN_URL);
});
