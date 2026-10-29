import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('unknown paths get the 404 page with status 404', async ({ page }) => {
  const response = await page.goto('/this-page-does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toBeVisible();
});

test('a missing hashed asset is a 404 that is never cached as immutable', async ({ request }) => {
  const response = await request.get('/_astro/does-not-exist.js');
  expect(response.status()).toBe(404);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.text()).toBe(readFileSync('dist/404.html', 'utf8'));
  expect(response.headers()['content-security-policy']).toBeTruthy();
});

test('the mobile menu opens and its links are reachable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const menu = page.locator('details[data-mobile-nav]');
  await menu.locator('summary').click();
  await expect(menu).toHaveAttribute('open', '');
  await expect(menu.locator('a').first()).toBeVisible();
});
