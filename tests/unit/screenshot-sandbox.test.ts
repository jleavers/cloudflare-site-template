import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

// The design renderer's boundary is Chromium's OS sandbox (tools/screenshots/design.mjs), so it
// asks for it, and where the sandbox cannot start it refuses rather than render without it. The
// launch is a stub here; tests/e2e/design-fence.spec.ts reads a real launch's processes on Linux.
const launch = vi.hoisted(() => vi.fn());
vi.mock('@playwright/test', () => ({ chromium: { launch } }));
const { shootDesign } = await import('../../tools/screenshots/design.mjs');

const root = mkdtempSync(join(tmpdir(), 'screenshot-sandbox-'));
const screen = join(root, 'screen.html');
writeFileSync(screen, '<!doctype html><title>screen</title>');
afterAll(() => {
  unlinkSync(screen);
  rmdirSync(root);
});
beforeEach(() => {
  launch.mockReset();
});

/** The error Playwright 1.64.0 throws on a host where the sandbox cannot start, trimmed (Ubuntu 24.04, user namespaces restricted). */
const PLAYWRIGHT_SANDBOX_FAILURE = [
  'browserType.launch: Target page, context or browser has been closed',
  'Browser logs:',
  'Chromium sandboxing failed!',
  '================================',
  'To avoid the sandboxing issue, do either of the following:',
  '  - (preferred): Configure your environment to support sandboxing',
  "  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option",
  '================================',
].join('\n');
/** Chromium's own line, which Playwright rewrites into the text above. */
const CHROMIUM_SANDBOX_FAILURE = 'browserType.launch: Target page, context or browser has been closed\n  - [pid=1][err] [FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+';

test('asks for Chromium\'s sandbox, and passes nothing that turns it off', async () => {
  launch.mockRejectedValue(new Error('stop here'));
  await expect(shootDesign(screen)).rejects.toThrow('stop here');
  expect(launch).toHaveBeenCalledTimes(1);
  const [options] = launch.mock.calls[0]!;
  expect(options.chromiumSandbox).toBe(true);
  expect(options.ignoreDefaultArgs).toBeUndefined();
  expect(options.args.filter((arg: string) => /sandbox|zygote/i.test(arg))).toEqual([]);
});

test.each([
  ["Playwright's words", PLAYWRIGHT_SANDBOX_FAILURE],
  ["Chromium's words", CHROMIUM_SANDBOX_FAILURE],
])('refuses where the sandbox cannot start (%s), naming both ways forward, and launches nothing else', async (_words, message) => {
  const failure = new Error(message);
  launch.mockRejectedValue(failure);
  const error = await shootDesign(screen).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error?.message).toMatch(/^Chromium's OS sandbox could not start on this machine, so the design screen was not rendered/);
  for (const part of ['tools/screenshots/playwright-chromium.apparmor', 'tools/screenshots/README.md', "read the screen's source as text instead", 'never without it']) {
    expect(error?.message).toContain(part);
  }
  expect(error?.cause).toBe(failure);
  // No second launch: not without the sandbox, and not with JavaScript off.
  expect(launch).toHaveBeenCalledTimes(1);
});

test('rethrows any other launch error unchanged', async () => {
  const failure = new Error("browserType.launch: Executable doesn't exist at /home/someone/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell");
  launch.mockRejectedValue(failure);
  await expect(shootDesign(screen)).rejects.toBe(failure);
  expect(launch).toHaveBeenCalledTimes(1);
});
