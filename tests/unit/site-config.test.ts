import { describe, expect, test } from 'vitest';
import { site } from '../../src/config/site';

describe('site config', () => {
  test('url is an https origin with no trailing slash or path', () => {
    const url = new URL(site.url);
    expect(url.protocol).toBe('https:');
    expect(site.url).toBe(url.origin);
  });

  test('locale is a BCP 47 tag', () => {
    expect(site.locale).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
  });

  test('every nav link is site-relative or absolute https', () => {
    for (const link of [...site.nav.header, ...site.nav.footer, ...site.socials]) {
      expect(link.href, link.label).toMatch(/^(\/|https:\/\/)/);
    }
  });

  test('privacy has a contact address and names at least one processor', () => {
    expect(site.legal.privacyEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(site.privacy.processors.length).toBeGreaterThan(0);
  });
});
