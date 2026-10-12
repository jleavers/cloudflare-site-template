#!/usr/bin/env node
// The whole site locally, with nothing real behind the form: builds with Turnstile's test site
// key, then serves dist/ and the Worker through `wrangler dev`, forcing `log` delivery and the
// test secret. A local run can never send a real message, whatever wrangler.jsonc says.
// `npm run preview`, Playwright (Task 9), Lighthouse (Task 10) and tools/screenshots use it.
//
//   PORT=8787 INSPECTOR_PORT=8788 node scripts/dev-stack.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY } from './test-keys.mjs';

const port = process.env.PORT || '8787';
const inspectorPort = process.env.INSPECTOR_PORT || String(Number(port) + 1);
// On Windows npx is npx.cmd, which Node only runs through a shell.
const shell = process.platform === 'win32';

function start(command, args, env = {}) {
  return spawn(command, args, { stdio: 'inherit', shell, env: { ...process.env, ...env } });
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

await finished(start('npx', ['astro', 'build'], { PUBLIC_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY }));

const wrangler = start('npx', [
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
