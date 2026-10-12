import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8787);
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: external ?? `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: 'node scripts/dev-stack.mjs',
        url: `http://127.0.0.1:${port}/`,
        env: { PORT: String(port), INSPECTOR_PORT: String(port + 1) },
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
      },
});
