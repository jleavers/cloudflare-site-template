#!/usr/bin/env node
// Lighthouse budgets (spec §11.4) against scripts/dev-stack.mjs, using Playwright's Chromium.
//   node scripts/lighthouse.mjs        local: performance must score 1
//   node scripts/lighthouse.mjs --ci   CI: noisy category scores warn; deterministic audits fail
// Budgets live in lighthouse-budgets.json. Each path is run `runs` times; the median run by
// performance score is kept, written to .lighthouse/<slug>.json, and asserted.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ci = process.argv.includes('--ci');
const budgets = JSON.parse(readFileSync(new URL('../lighthouse-budgets.json', import.meta.url), 'utf8'));
const assertions = { ...budgets.assertions.base, ...budgets.assertions[ci ? 'ci' : 'local'] };

const portInUse = (port) =>
  new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(true));
    server.listen(port, '127.0.0.1', () => server.close(() => done(false)));
  });

// Set once spawned, so an interrupt can end them (the stack's process group is detached).
let stopStack;
let stopChrome;
const cleanup = async () => {
  try {
    await stopChrome?.();
  } catch {
    // already gone
  }
  stopStack?.();
};
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(code);
  });
}

async function startStack(port) {
  if (await portInUse(port)) throw new Error(`port ${port} is already in use; stop whatever is listening (a running wrangler dev serves 404s after a rebuild)`);
  const child = spawn(process.execPath, ['scripts/dev-stack.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    // Own process group on Unix, so the kill can end wrangler too (dev-stack's grandchild).
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), INSPECTOR_PORT: String(port + 1) },
  });
  let killed = false;
  stopStack = () => {
    if (killed) return;
    killed = true;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error('the local stack exited before it was ready');
    try {
      if ((await fetch(origin)).status === 200) return origin;
    } catch {
      // not up yet
    }
    await new Promise((wait) => setTimeout(wait, 1000));
  }
  throw new Error('the local stack did not answer 200 within three minutes');
}

const slug = (path) => (path === '/' ? 'index' : path.replace(/^\/|\/$/g, '').replace(/\//g, '-'));

function check(name, rule, lhr) {
  const { level } = rule;
  if (name.startsWith('categories:')) {
    const category = lhr.categories[name.slice('categories:'.length)];
    if (!category) return { level, ok: false, text: 'unknown category' };
    return { level, ok: category.score >= rule.minScore, text: `${category.score} (min ${rule.minScore})` };
  }
  const audit = lhr.audits[name];
  if (!audit) return { level: 'error', ok: false, text: 'unknown audit id (not in this Lighthouse report)' };
  if (rule.minScore !== undefined) {
    const passNull = audit.score === null && ['notApplicable', 'informative'].includes(audit.scoreDisplayMode);
    return { level, ok: passNull || (audit.score !== null && audit.score >= rule.minScore), text: `score ${audit.score} (min ${rule.minScore})` };
  }
  if (rule.maxNumericValue !== undefined) {
    return { level, ok: audit.numericValue <= rule.maxNumericValue, text: `${audit.numericValue} (max ${rule.maxNumericValue})` };
  }
  if (rule.maxLength !== undefined) {
    const length = (audit.details?.items ?? []).length;
    return { level, ok: length <= rule.maxLength, text: `${length} items (max ${rule.maxLength})` };
  }
  return { level: 'error', ok: false, text: 'assertion has no minScore, maxNumericValue or maxLength' };
}

async function main() {
  const port = Number(process.env.E2E_PORT || process.env.PORT || '8787');
  const origin = await startStack(port);
  const chrome = await launch({ chromePath: chromium.executablePath(), chromeFlags: budgets.chromeFlags });
  stopChrome = () => chrome.kill();
  mkdirSync(`${ROOT}.lighthouse`, { recursive: true });
  let failed = false;
  for (const path of budgets.paths) {
    const runs = [];
    for (let i = 0; i < budgets.runs; i += 1) {
      const result = await lighthouse(origin + path, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      });
      runs.push(result.lhr);
    }
    runs.sort((a, b) => a.categories.performance.score - b.categories.performance.score);
    const median = runs[Math.floor(runs.length / 2)];
    writeFileSync(`${ROOT}.lighthouse/${slug(path)}.json`, JSON.stringify(median, null, 2));
    console.log(`\n${path} (median of ${runs.length}, performance ${median.categories.performance.score}, Lighthouse ${median.lighthouseVersion})`);
    for (const [name, rule] of Object.entries(assertions)) {
      const { level, ok, text } = check(name, rule, median);
      const verdict = ok ? 'PASS' : level === 'error' ? 'FAIL' : 'WARN';
      if (verdict === 'FAIL') failed = true;
      console.log(`  ${verdict}  ${name}: ${text}`);
    }
  }
  return failed ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error.message ?? error);
} finally {
  await cleanup();
}
process.exit(code);
