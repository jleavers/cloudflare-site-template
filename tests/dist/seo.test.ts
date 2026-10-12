import { describe, expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { pages } from './helpers';

const afterScheme = (url: string) => url.replace(/^[a-z]+:\/\//i, '');

// Contract C4: every page renders through BaseLayout.
describe.each(pages().map((page) => [page.route, page] as const))('page %s', (_route, page) => {
  const head = page.root.querySelector('head');
  const meta = (selector: string) => head?.querySelector(selector)?.getAttribute('content') ?? '';

  test('has a title, a description and the site language', () => {
    expect(head?.querySelector('title')?.text.trim()).toBeTruthy();
    expect(meta('meta[name="description"]')).not.toBe('');
    expect(page.root.querySelector('html')?.getAttribute('lang')).toBe(site.locale);
  });

  // Review focus 5: a trailing slash or path on site.url must not produce "//" in a URL.
  test('has a canonical URL on the site origin', () => {
    const canonical = head?.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
    expect(canonical.startsWith(`${site.url}/`), canonical).toBe(true);
    expect(afterScheme(canonical)).not.toContain('//');
  });

  test('has OpenGraph tags with absolute URLs', () => {
    for (const property of ['og:title', 'og:description', 'og:url', 'og:image']) {
      expect(meta(`meta[property="${property}"]`), property).not.toBe('');
    }
    for (const property of ['og:url', 'og:image']) {
      const url = meta(`meta[property="${property}"]`);
      expect(url, property).toMatch(/^https:\/\//);
      expect(afterScheme(url), property).not.toContain('//');
    }
  });

  test('has exactly one h1', () => {
    expect(page.root.querySelectorAll('h1')).toHaveLength(1);
  });
});
