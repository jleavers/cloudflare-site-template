#!/usr/bin/env node
// The whole site locally, with nothing real behind the form: builds with Turnstile's test site
// key, then serves dist/ and the Worker through `wrangler dev`, forcing `log` delivery and the
// test secret. A local run can never send a real message, whatever wrangler.jsonc says.
// `npm run preview`, Playwright (Task 9), Lighthouse (Task 10) and tools/screenshots use it.
//
//   PORT=8787 INSPECTOR_PORT=8788 node scripts/dev-stack.mjs
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY } from './test-keys.mjs';

const port = process.env.PORT || '8787';
const inspectorPort = process.env.INSPECTOR_PORT || String(Number(port) + 1);
for (const [name, value] of [['PORT', port], ['INSPECTOR_PORT', inspectorPort]]) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 65535) {
    console.error(`dev-stack: ${name} must be a port number from 1 to 65535, not ${JSON.stringify(value)}.`);
    process.exit(1);
  }
}

/** Runs a package's own command with this Node, as its `.bin` link would: no npx, and no shell to rewrite the arguments. */
function start([tool, ...args], env = {}) {
  const dir = new URL(`../node_modules/${tool}/`, import.meta.url);
  const { bin } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  return spawn(process.execPath, [fileURLToPath(new URL(bin[tool], dir)), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
}

function finished(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`exited with ${code ?? signal}`))));
  });
}

if (existsSync('.dev.vars')) {
  console.warn('dev-stack: .dev.vars exists; the --var flags below still force log delivery and the test secret.');
}

await finished(start(['astro', 'build'], { PUBLIC_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY }));

const wrangler = start([
  'wrangler', 'dev',
  '--ip', '127.0.0.1',
  '--port', port,
  '--inspector-port', inspectorPort,
  '--show-interactive-dev-session=false',
  '--var', 'DELIVERY_PROVIDER:log',
  '--var', `TURNSTILE_SECRET_KEY:${TURNSTILE_TEST_SECRET_KEY}`,
  '--var', 'TURNSTILE_FAIL_OPEN:false',
]);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => wrangler.kill(signal));
wrangler.on('exit', (code) => process.exit(code ?? 0));
