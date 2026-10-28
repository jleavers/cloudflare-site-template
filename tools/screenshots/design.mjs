// The one sanctioned way to run an untrusted design screen's JavaScript: capture.mjs's
// `--only screen` and `--only design` use it, and tests/e2e/design-fence.spec.ts attacks it. The
// boundary is Chromium's OS sandbox, which the launch requires: where it cannot start, nothing is
// rendered. The fences below live inside Chromium's own network stack, and are defence in depth.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { allowedForDesign } from './fence.mjs';

// Playwright sends loopback through the proxy unless this is set; with it set, a screen's requests
// to this machine would skip the proxy.
const LOOPBACK_BYPASS = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';
/** What a launch error says when Chromium's sandbox cannot start: Playwright 1.64.0's words, or Chromium's own. */
const SANDBOX_FAILED = /Chromium sandboxing failed!|No usable sandbox!/;
const SANDBOX_REFUSAL =
  "Chromium's OS sandbox could not start on this machine, so the design screen was not rendered: design.mjs runs a screen's JavaScript only inside that sandbox, and never without it. On Ubuntu 23.10 and later, which restrict unprivileged user namespaces, the person can install the AppArmor profile tools/screenshots/playwright-chromium.apparmor, as tools/screenshots/README.md says (\"Chromium's sandbox\"); until then, read the screen's source as text instead.";

/**
 * Photographs a design screen with its JavaScript on, confined to the files of its own bundle.
 *
 * JavaScript stays on because some screens draw themselves in script, so the screen runs only inside
 * Chromium's OS sandbox (chromiumSandbox): a renderer bug then still has the sandbox to escape. A
 * host where the sandbox cannot start gets a refusal that says how to fix it, never a render without
 * it. Inside the browser, what the script can reach is the bundle and nothing else:
 * - route() lets a request through only when fence.mjs finds its resolved path inside the bundle,
 *   so no other file and no URL on any network loads;
 * - some channels never pass through route(): speculation-rules prefetch and prerender,
 *   WebTransport, an ICE-TCP connection, a worker's WebSocket. Two things stop those. The
 *   browser's host resolver maps every name and address to "not found", so nothing it would
 *   connect to resolves, the proxy included. And its only proxy is a dead one, should the rule
 *   ever miss. WebRTC may send no UDP outside that proxy;
 * - the page's own WebSockets are closed before they connect.
 * Also, not under test: service workers are blocked (a file: page cannot register one
 * anyway), downloads are refused, and the browser is its own, with no storage state.
 * A Claude artifact's `.dc.html` artboard renders fully this way. A handoff prototype that loads
 * React or Babel from a CDN renders without them, so it may draw little or nothing: read its source.
 *
 * @param {string} screen the screen's path
 * @param {object} [options]
 * @param {string} [options.bundle] the bundle directory, which must hold the screen; by default the screen's own directory
 * @param {number} [options.width] the viewport width, 1440 by default
 * @param {number} [options.height] the viewport height, 900 by default
 * @param {string} [options.proxy] the proxy server, a dead one by default (for tests: a live one must reach nothing either)
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [options.inspect] runs once the screen has loaded, before the screenshot (for tests)
 * @returns {Promise<Buffer>} the screenshot, as PNG
 */
export async function shootDesign(screen, { bundle, width = 1440, height = 900, proxy = 'http://127.0.0.1:9', inspect } = {}) {
  if (process.env[LOOPBACK_BYPASS] !== undefined) {
    throw new Error(`${LOOPBACK_BYPASS} is set, so Playwright would let a design screen's requests to this machine skip the renderer's proxy. Unset it to render a design screen.`);
  }
  const file = resolve(screen);
  const bundleDir = resolve(bundle ?? dirname(file));
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`no screen at ${screen}`);
  if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the bundle ${bundleDir} is not a folder`);
  const url = pathToFileURL(file).href;
  if (!allowedForDesign(url, bundleDir)) throw new Error(`the screen ${screen} is not inside the bundle ${bundleDir}`);

  let browser;
  try {
    browser = await chromium.launch({
      chromiumSandbox: true,
      proxy: { server: proxy },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
  } catch (error) {
    if (SANDBOX_FAILED.test(String(error?.message))) throw new Error(SANDBOX_REFUSAL, { cause: error });
    throw error;
  }
  try {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**', (route) => (allowedForDesign(route.request().url(), bundleDir) ? route.continue() : route.abort()));
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    // A screen that keeps making requests never goes idle: give it five seconds, then shoot.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await inspect?.(page);
    return await page.screenshot();
  } finally {
    await browser.close();
  }
}
