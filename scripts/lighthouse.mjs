#!/usr/bin/env node
// Lighthouse budgets (spec §11.4) against scripts/dev-stack.mjs, using Playwright's Chromium.
//   node scripts/lighthouse.mjs        local: performance must score 1
//   node scripts/lighthouse.mjs --ci   CI: noisy category scores warn; deterministic audits fail
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const ci = process.argv.includes('--ci');
const port = process.env.E2E_PORT || process.env.PORT || '8787';
const origin = `http://127.0.0.1:${port}`;

const base = JSON.parse(readFileSync(new URL('../lighthouserc.json', import.meta.url), 'utf8'));
const config = structuredClone(base);
delete config.modes;
config.ci.assert.assertions = { ...base.ci.assert.assertions, ...base.modes[ci ? 'ci' : 'local'] };
Object.assign(config.ci.collect, {
  url: ['/', '/privacy/'].map((path) => origin + path),
  startServerCommand: 'node scripts/dev-stack.mjs',
  startServerReadyPattern: 'Ready on',
  startServerReadyTimeout: 180000,
  chromePath: chromium.executablePath(),
});

// Inside the workspace (gitignored), not shared /tmp: see jleavers/ci-runners "What a workflow must do".
mkdirSync('.lighthouseci', { recursive: true });
const configPath = '.lighthouseci/lighthouserc.generated.json';
writeFileSync(configPath, JSON.stringify(config, null, 2));

const child = spawn('npx', ['lhci', 'autorun', `--config=${configPath}`], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, PORT: port, INSPECTOR_PORT: String(Number(port) + 1) },
});
child.on('exit', (code) => process.exit(code ?? 1));
