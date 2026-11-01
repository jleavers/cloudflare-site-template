import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { removeTree } from './wrangler-sandbox';

// scripts/dev-stack.mjs is what `npm run preview`, Playwright, Lighthouse and the screenshots run.
// It forces `log` delivery and the Turnstile test secret on wrangler's command line, so nothing may
// rewrite that line on its way: no shell (on Windows, `shell: true` hands it to cmd.exe unescaped,
// and Node warns, DEP0190) and no npx. Here a copy of it runs beside stub astro and wrangler
// packages, which record what reached them and which process started them. The real run is e2e's.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-stack-')));
afterAll(() => removeTree(root));
let runs = 0;

const RECORD = (tool: string) =>
  `require('node:fs').appendFileSync(process.env.DEV_STACK_LOG, JSON.stringify({ tool: ${JSON.stringify(tool)}, args: process.argv.slice(2), ppid: process.ppid, siteKey: process.env.PUBLIC_TURNSTILE_SITE_KEY ?? null }) + '\\n');\n`;

/** A folder holding the script and stub packages shaped as the real ones are: astro's bin is ESM, wrangler's CommonJS, and wrangler has more than one. */
function fixture(): string {
  const dir = join(root, `run-${++runs}`);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const file of ['dev-stack.mjs', 'test-keys.mjs']) {
    copyFileSync(fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url)), join(dir, 'scripts', file));
  }
  const astro = join(dir, 'node_modules', 'astro');
  mkdirSync(join(astro, 'bin'), { recursive: true });
  writeFileSync(join(astro, 'package.json'), JSON.stringify({ name: 'astro', version: '0.0.0', type: 'module', bin: { astro: './bin/astro.mjs' } }));
  writeFileSync(join(astro, 'bin', 'astro.mjs'), `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${RECORD('astro')}`);
  const wrangler = join(dir, 'node_modules', 'wrangler');
  mkdirSync(join(wrangler, 'bin'), { recursive: true });
  writeFileSync(join(wrangler, 'package.json'), JSON.stringify({ name: 'wrangler', version: '0.0.0', bin: { 'cf-wrangler': './bin/cf-wrangler.js', wrangler: './bin/wrangler.js', wrangler2: './bin/wrangler.js' } }));
  writeFileSync(join(wrangler, 'bin', 'wrangler.js'), RECORD('wrangler'));
  writeFileSync(join(wrangler, 'bin', 'cf-wrangler.js'), RECORD('cf-wrangler'));
  return dir;
}

type Record = { tool: string; args: string[]; ppid: number; siteKey: string | null };

/** Runs the copy with `ports` set, and returns how it ended and what reached the stubs. npm, should it be asked, can install and fetch nothing. */
function devStack(ports: { PORT?: string; INSPECTOR_PORT?: string }) {
  const dir = fixture();
  const log = join(dir, 'log.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, DEV_STACK_LOG: log, npm_config_yes: 'false', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: join(dir, 'npm-cache') };
  delete env.PORT;
  delete env.INSPECTOR_PORT;
  // npm run and npx put this repository's node_modules/.bin on PATH, where the real astro is.
  for (const key of Object.keys(env).filter((name) => name.toUpperCase() === 'PATH')) {
    env[key] = env[key]!.split(delimiter).filter((entry) => !entry.includes('node_modules')).join(delimiter);
  }
  const child = spawn(process.execPath, [join(dir, 'scripts', 'dev-stack.mjs')], { cwd: dir, env: { ...env, ...ports }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise<{ code: number | null; pid: number; stderr: string; records: Record[] }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const records = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record) : [];
      resolve({ code, pid: child.pid!, stderr, records });
    });
  });
}

test('builds with astro, then serves with wrangler dev, each run by node itself from its own package, with nothing between', async () => {
  const run = await devStack({ PORT: '48787', INSPECTOR_PORT: '48790' });
  expect(run.stderr).not.toContain('DEP0190');
  expect(run.records, run.stderr).toEqual([
    { tool: 'astro', args: ['build'], ppid: run.pid, siteKey: '1x00000000000000000000AA' },
    {
      tool: 'wrangler',
      args: [
        'dev',
        '--ip', '127.0.0.1',
        '--port', '48787',
        '--inspector-port', '48790',
        '--show-interactive-dev-session=false',
        '--var', 'DELIVERY_PROVIDER:log',
        '--var', 'TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA',
        '--var', 'TURNSTILE_FAIL_OPEN:false',
      ],
      ppid: run.pid,
      siteKey: null,
    },
  ]);
  expect(run.code).toBe(0);
});

test('without the variables, serves on 8787 with the inspector on 8788', async () => {
  const run = await devStack({});
  const wrangler = run.records.find((record) => record.tool === 'wrangler');
  expect(wrangler?.args.slice(1, 7), run.stderr).toEqual(['--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '8788']);
});

test.each([
  [{ PORT: '8787 & calc' }, 'PORT'],
  [{ PORT: 'abc' }, 'PORT'],
  [{ PORT: '0' }, 'PORT'],
  [{ PORT: '65536' }, 'PORT'],
  [{ PORT: '8787', INSPECTOR_PORT: '8788; whoami' }, 'INSPECTOR_PORT'],
  [{ PORT: '65535' }, 'INSPECTOR_PORT'],
])('refuses %o, naming %s, before it runs anything', async (ports, name) => {
  const run = await devStack(ports);
  expect(run.records).toEqual([]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`dev-stack: ${name} must be a port number from 1 to 65535`);
});
