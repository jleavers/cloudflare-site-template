import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { distFile, readDist } from './helpers';

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

test.each(['404.html', 'favicon.svg', 'og-default.png', '_headers', 'robots.txt', 'sitemap-index.xml'])('%s is built', (file) => {
  expect(existsSync(distFile(file))).toBe(true);
});

test('robots.txt allows crawling and names the sitemap by absolute URL', () => {
  const robots = readDist('robots.txt');
  expect(robots).toContain('User-agent: *');
  expect(robots).toContain(`Sitemap: ${site.url}/sitemap-index.xml`);
});

test('the sitemap lists the site origin only, without the 404 page', () => {
  const urls = locs(readDist('sitemap-index.xml')).flatMap((sitemap) => locs(readDist(new URL(sitemap).pathname.slice(1))));
  expect(urls).toContain(`${site.url}/`);
  for (const url of urls) {
    expect(url.startsWith(`${site.url}/`), url).toBe(true);
    expect(url.replace(/^https:\/\//, ''), url).not.toContain('//');
    expect(url, url).not.toMatch(/\/404\/?$/);
  }
});

test('_headers sets a CSP that admits Turnstile and frames nothing', () => {
  const csp = readDist('_headers').match(/Content-Security-Policy: (.+)/)?.[1] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('frame-src https://challenges.cloudflare.com');
  expect(csp).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com[ ;]/);
  if (site.analytics.cloudflareToken) {
    expect(csp).toContain('https://static.cloudflareinsights.com');
    expect(csp).toMatch(/connect-src [^;]*https:\/\/cloudflareinsights\.com/);
  }
});
