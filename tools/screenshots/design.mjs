// The one sanctioned way to run an untrusted design screen's JavaScript: capture.mjs's
// `--only screen` and `--only design` use it, and tests/e2e/design-fence.spec.ts attacks it.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { allowedForDesign } from './fence.mjs';

/**
 * Photographs a design screen with its JavaScript on, confined to the files of its own bundle.
 *
 * JavaScript stays on because some screens draw themselves in script. What the script can reach is
 * the bundle and nothing else:
 * - route() lets a request through only when fence.mjs finds its resolved path inside the bundle,
 *   so no other file and no URL on any network loads;
 * - WebSockets, which route() never sees, are closed;
 * - the browser's only proxy is a dead one, so whatever route() misses (a preconnect, a worker's
 *   socket) fails, and WebRTC may not send UDP outside that proxy;
 * - its own browser, with service workers blocked and no storage state.
 * A Claude artifact's `.dc.html` artboard renders fully this way. A handoff prototype that loads
 * React or Babel from a CDN renders without them, so it may draw little or nothing: read its source.
 *
 * @param {string} screen the screen's path
 * @param {object} [options]
 * @param {string} [options.bundle] the bundle directory, which must hold the screen; by default the screen's own directory
 * @param {number} [options.width] the viewport width, 1440 by default
 * @param {number} [options.height] the viewport height, 900 by default
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [options.inspect] runs once the screen has loaded, before the screenshot (for tests)
 * @returns {Promise<Buffer>} the screenshot, as PNG
 */
export async function shootDesign(screen, { bundle, width = 1440, height = 900, inspect } = {}) {
  const file = resolve(screen);
  const bundleDir = resolve(bundle ?? dirname(file));
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`no screen at ${screen}`);
  if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the bundle ${bundleDir} is not a folder`);
  const url = pathToFileURL(file).href;
  if (!allowedForDesign(url, bundleDir)) throw new Error(`the screen ${screen} is not inside the bundle ${bundleDir}`);

  const browser = await chromium.launch({
    proxy: { server: 'http://127.0.0.1:9' },
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  try {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**', (route) => (allowedForDesign(route.request().url(), bundleDir) ? route.continue() : route.abort()));
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await inspect?.(page);
    return await page.screenshot();
  } finally {
    await browser.close();
  }
}
