import { expect, test, type Page } from '@playwright/test';
import { site } from '../../src/config/site';

// Selectors are the C5 contract, not labels or copy, so these tests survive a redesign.
async function fillForm(page: Page, name = 'Ada Lovelace') {
  await page.goto('/');
  const form = page.locator('form[data-contact-form]');
  await form.scrollIntoViewIfNeeded();
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="email"]').fill('ada@example.com');
  await form.locator('[name="message"]').fill('Hello from the end-to-end tests.');
  const submit = form.locator('[data-submit]');
  await expect(submit, 'Turnstile (test key) should enable the button').toBeEnabled({ timeout: 20_000 });
  return { form, submit };
}

test('a visitor can send a message', async ({ page }) => {
  const { form, submit } = await fillForm(page);
  await submit.click();
  await expect(form).toHaveAttribute('data-state', 'sent');
  await expect(form.locator('[data-status]')).toHaveText(site.contact.successMessage.replaceAll('{email}', 'ada@example.com'));
  await expect(form.locator('[name="name"]')).toHaveValue('');
});

// Review focus 2.
test('a double click sends one request', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/contact') posts.push(request.url());
  });
  const { form, submit } = await fillForm(page);
  await submit.dblclick();
  await expect(form).toHaveAttribute('data-state', 'sent');
  expect(posts).toHaveLength(1);
});

test('a server-side validation error is shown on its field', async ({ page }) => {
  const { form, submit } = await fillForm(page);
  const name = form.locator('[name="name"]');
  await name.evaluate((element) => element.removeAttribute('maxlength'));
  await name.fill('x'.repeat(101));
  await submit.click();
  await expect(form).toHaveAttribute('data-state', 'error');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('[data-error-for="name"]')).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the form cannot be submitted and says why', async ({ page }) => {
    await page.goto('/');
    const form = page.locator('form[data-contact-form]');
    await expect(form.locator('[data-submit]')).toBeDisabled();
    await expect(form.locator('noscript')).toBeVisible();
  });
});
