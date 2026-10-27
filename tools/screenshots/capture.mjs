#!/usr/bin/env node
// Regenerates the README's media from the example site, whose content is fabricated
// (tools/screenshots/README.md). Owner's machine only; never run in CI.
//
//   node tools/screenshots/capture.mjs                         hero, GIF, social preview, LinkedIn header
//   node tools/screenshots/capture.mjs --url https://<demo>    the same, from a deployed site
//   node tools/screenshots/capture.mjs --only hero,gif
//   node tools/screenshots/capture.mjs --only design --design <screen.html> [--bundle <dir>] --site <url>
//
// And, for the new-site skill, one design screen to a PNG of its own, with no site and no stack:
//   node tools/screenshots/capture.mjs --only screen --design <screen.html> [--bundle <dir>] --out <png> [--width 1440] [--height 900]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import sharp from 'sharp';
import { shootDesign } from './design.mjs';
import * as layouts from './layouts.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMAGES = resolve(ROOT, 'docs/images');
const LIMIT_KB = { 'hero.png': 600, 'contact-form.gif': 500, 'design-to-site.png': 600, 'social-preview.png': 1024, 'linkedin-header.png': 1024 };

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    only: { type: 'string', default: 'hero,gif,social,linkedin' },
    design: { type: 'string' },
    bundle: { type: 'string' },
    site: { type: 'string' },
    out: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    colours: { type: 'string', default: '64' },
  },
});
const wanted = new Set(args.only.split(','));

/** A --width or --height, in whole pixels. */
function pixels(name, fallback) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 8000) throw new Error(`--${name} must be a whole number of pixels, up to 8000`);
  return value;
}

function save(name, buffer) {
  mkdirSync(IMAGES, { recursive: true });
  writeFileSync(resolve(IMAGES, name), buffer);
  const kb = Math.round(buffer.length / 1024);
  console.log(`${name}: ${kb} KB (limit ${LIMIT_KB[name]} KB)`);
  if (kb > LIMIT_KB[name]) {
    console.error(`  over the limit: lower --width or --colours, or simplify the layout`);
    process.exitCode = 1;
  }
}

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

// Set once the stack is spawned, so an interrupt can end it (its process group is detached).
let stopStack;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    stopStack?.();
    process.exit(code);
  });
}

async function startStack() {
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/dev-stack.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    // Own process group on Unix, so stop() can end wrangler too (dev-stack's grandchild).
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), INSPECTOR_PORT: String(port + 1) },
  });
  const origin = `http://127.0.0.1:${port}`;
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  stopStack = kill;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(origin)).ok) return { origin, stop: kill };
    } catch {
      // not up yet
    }
    await new Promise((wait) => setTimeout(wait, 1000));
  }
  kill();
  throw new Error('the local stack did not start within three minutes');
}

const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;
const compressPng = (png) => sharp(png).png({ palette: true, quality: 90, effort: 10 }).toBuffer();

async function shoot(browser, url, { width, height, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(url, { waitUntil: 'networkidle' });
  const png = await page.screenshot();
  await page.close();
  return png;
}

async function render(browser, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: 'load' });
  const png = await page.screenshot();
  await page.close();
  return png;
}

async function contactGif(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const section = page.locator('#contact');
  const form = page.locator('form[data-contact-form]');
  await section.scrollIntoViewIfNeeded();
  const frames = [];
  const grab = async (delay) => frames.push({ png: await section.screenshot(), delay });

  await page.waitForTimeout(800);
  await grab(1200);
  await form.locator('[name="name"]').pressSequentially('Priya Shah', { delay: 30 });
  await grab(500);
  await form.locator('[name="email"]').pressSequentially('priya@example.com', { delay: 20 });
  await grab(500);
  const message = 'Hello! Our courtyard is about 3 by 8 metres and mostly in shade. Could you suggest planting that looks good all year?';
  for (const part of [message.slice(0, 45), message.slice(45, 90), message.slice(90)]) {
    await form.locator('[name="message"]').pressSequentially(part, { delay: 5 });
    await grab(400);
  }
  await page.waitForFunction(() => !document.querySelector('form[data-contact-form] [data-submit]')?.disabled, null, { timeout: 20000 });
  await grab(900);
  await form.locator('[data-submit]').click();
  await page.waitForSelector('form[data-contact-form][data-state="sent"]', { timeout: 15000 });
  await grab(3000);
  await page.close();

  const width = pixels('width', 800);
  const colours = Number(args.colours);
  const { info } = await sharp(frames[0].png).resize({ width }).toBuffer({ resolveWithObject: true });
  const gif = GIFEncoder();
  for (const frame of frames) {
    const { data } = await sharp(frame.png)
      .resize({ width: info.width, height: info.height, fit: 'contain', position: 'top', background: '#f7f8ef' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.length);
    const palette = quantize(rgba, colours);
    gif.writeFrame(applyPalette(rgba, palette), info.width, info.height, { palette, delay: frame.delay });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// One design screen to its own PNG. The screen is untrusted: design.mjs renders it in a browser of
// its own, confined to its bundle's files with no network.
async function screenOnly() {
  if (wanted.size > 1) throw new Error('--only screen runs on its own');
  if (!args.design || !args.out) throw new Error('--only screen needs --design <screen.html> and --out <file.png>');
  const [width, height] = [pixels('width', 1440), pixels('height', 900)];
  const png = await shootDesign(args.design, { bundle: args.bundle, width, height });
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), png);
  console.log(`${args.out}: ${width}×${height}, ${Math.round(png.length / 1024)} KB`);
}

async function media() {
  let browser;
  let stack;
  try {
    browser = await chromium.launch();
    stack = args.url || wanted.has('design') ? undefined : await startStack();
    const origin = (args.url ?? stack?.origin ?? '').replace(/\/$/, '');
    if (wanted.has('hero') || wanted.has('social') || wanted.has('linkedin')) {
      const desktop = await shoot(browser, `${origin}/`, { width: 1440, height: 900 });
      if (wanted.has('hero')) {
        const mobile = await shoot(browser, `${origin}/`, { width: 390, height: 844, scale: 2 });
        save('hero.png', await compressPng(await render(browser, layouts.hero(dataUrl(desktop), dataUrl(mobile)), 1600, 1000)));
      }
      if (wanted.has('social')) save('social-preview.png', await compressPng(await render(browser, layouts.social(dataUrl(desktop)), 1280, 640)));
      if (wanted.has('linkedin')) save('linkedin-header.png', await compressPng(await render(browser, layouts.linkedin(dataUrl(desktop)), 1920, 1080)));
    }
    if (wanted.has('gif')) save('contact-form.gif', await contactGif(browser, origin));
    if (wanted.has('design')) {
      if (!args.design || !args.site) throw new Error('--only design needs --design <screen.html> and --site <url>');
      if (!['http:', 'https:'].includes(new URL(args.site).protocol)) throw new Error('--site must be an http: or https: URL');
      // The design screen through the same confined renderer as --only screen; the built site, which
      // is ours, in the ordinary browser.
      const design = await shootDesign(args.design, { bundle: args.bundle, width: 1440, height: 900 });
      const built = await shoot(browser, args.site, { width: 1440, height: 900 });
      save('design-to-site.png', await compressPng(await render(browser, layouts.sideBySide(dataUrl(design), dataUrl(built)), 1600, 600)));
    }
  } finally {
    await browser?.close();
    stack?.stop();
  }
}

await (wanted.has('screen') ? screenOnly() : media());
