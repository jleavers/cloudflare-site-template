// What the preview job's wrangler uploads (sweep 20261027T190359Z, cluster 1). The job hands the
// pinned wrangler's preview command a worker.js that a pull request's build wrote, so wrangler must
// upload that file's bytes as they are, with the artifact's dist/ as assets, and read no other file
// on the runner because of what worker.js says. This runs that command, from a scratch copy of the
// job's site directory, against a stub of the Cloudflare API, and reads back what it uploaded.
//
// worker.js imports a stand-in secret file with `with { type: 'text' }`, as a hostile build could
// import /proc/self/environ, which holds the job's token, and names the same file in a
// `//# sourceMappingURL=` comment. The RED runs show that the harness sees the secret when wrangler
// uploads it; the GREEN runs, with the config trusted-config.mjs writes, that it never does.
//
// Hermetic. The stub listens on 127.0.0.1, and CLOUDFLARE_API_BASE_URL points wrangler at it. Proxy
// variables point every other request at a port on 127.0.0.1 that nothing listens on (wrangler sends
// all but loopback through them). preview-upload-guard.cjs, loaded into each wrangler process, logs
// every connection and lookup and refuses any destination but 127.0.0.1, and each run fails unless
// every one went to the stub or to that dead port. The stub fails a run on any request it doesn't
// expect, and on any that lacks the fake token. wrangler's home, config, cache and temporary folders
// are in this test's temporary directory, with no variable from the caller's environment but PATH
// (wrangler-sandbox.ts).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseJsonc } from '../../scripts/trusted-config.mjs';
import { FAKE_ACCOUNT_ID, FAKE_TOKEN, WRANGLER_BIN, removeTree, sandboxEnv } from './wrangler-sandbox';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const GUARD = fileURLToPath(new URL('./preview-upload-guard.cjs', import.meta.url));
const TRUSTED_CONFIG_SCRIPT = root('scripts/trusted-config.mjs');
const REPO_CONFIG = readFileSync(root('wrangler.jsonc'), 'utf8');
const SECRET = 'SYNTHETIC-PREVIEW-UPLOAD-SECRET-not-a-real-token';
// Each wrangler run takes a second or two; the first loads wrangler from a cold disk cache.
const RUN_TIMEOUT_MS = 60_000;

const scratch = mkdtempSync(join(tmpdir(), 'preview-upload-'));
const home = join(scratch, 'home');
// Outside every site directory. JSON with a `sources` array, so wrangler would take it for a source map too.
const secretFile = join(scratch, 'secret', 'token.json');
mkdirSync(dirname(secretFile));
writeFileSync(secretFile, `${JSON.stringify({ version: 3, sources: [SECRET], names: [], mappings: '', secret: SECRET })}\n`);
const WORKER = [
  `import secret from ${JSON.stringify(secretFile)} with { type: 'text' };`,
  'export default { fetch: () => new Response(secret) };',
  // From <site>/bundle/worker.js, two levels up is the scratch directory.
  '//# sourceMappingURL=../../secret/token.json',
  '',
].join('\n');

type Recorded = { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer; expected: boolean };
type NetEntry = { connect?: { host?: string; port?: number; path?: string }; lookup?: string };
const requests: Recorded[] = [];

// What wrangler 4.149.0's preview command asks for a new preview whose assets the stub already
// has (cli.js runPreview), under /client/v4/accounts/<account>/workers.
const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
const ok = (result: unknown) => json(200, { success: true, errors: [], messages: [], result });
const ROUTES: [string, RegExp, () => { status: number; body: string }][] = [
  // getPreview: none yet (10025), so runPreview creates one.
  ['GET', /^\/workers\/[^/]+\/previews\/[^/]+$/, () => json(404, { success: false, errors: [{ code: 10025, message: 'not found' }], messages: [], result: null })],
  ['POST', /^\/workers\/[^/]+\/previews$/, () => ok({ id: 'preview-id', name: 'pr-1', slug: 'pr-1', urls: ['https://pr-1.example.invalid'] })],
  // syncAssets: no buckets, so no asset is uploaded, only the manifest of hashes.
  ['POST', /^\/scripts\/[^/]+\/assets-upload-session$/, () => ok({ jwt: 'stub-assets-jwt', buckets: [] })],
  ['POST', /^\/workers\/[^/]+\/previews\/[^/]+\/deployments$/, () => ok({ id: 'deployment-id', urls: ['https://deployment.example.invalid'], env: {} })],
  // getPreviewBaseConfig, read for the warning about production bindings a preview lacks.
  ['GET', /^\/workers\/[^/]+$/, () => ok({ previews_base_config: {} })],
];
const API = `/client/v4/accounts/${FAKE_ACCOUNT_ID}/workers`;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const route = path.startsWith(API) ? ROUTES.find(([method, pattern]) => method === request.method && pattern.test(path.slice(API.length))) : undefined;
    requests.push({ method: request.method ?? '', path, headers: request.headers, body: Buffer.concat(chunks), expected: route !== undefined });
    const { status, body } = route ? route[2]() : json(500, { success: false, errors: [{ code: 0, message: 'unexpected request' }], messages: [], result: null });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
});
let stubPort = 0;
let deadPort = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stubPort = (server.address() as AddressInfo).port;
  // A port that was free a moment ago, and is closed now: a request through the proxy fails there.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeTree(scratch);
});

/** A scratch copy of the job's site directory: dist/ and bundle/worker.js, and `extra` files. */
function site(name: string, extra: Record<string, string> = {}) {
  const dir = join(scratch, name);
  const files = { 'dist/index.html': '<!doctype html><title>Preview</title>\n', 'dist/_headers': '/*\n  X-Preview-Upload: 1\n', 'bundle/worker.js': WORKER, ...extra };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Writes the preview config as the job does: `trusted-config.mjs --preview-config <trusted> <site>/wrangler.json`. */
function writePreviewConfig(trusted: string, dir: string) {
  const result = spawnSync(process.execPath, [TRUSTED_CONFIG_SCRIPT, '--preview-config', trusted, join(dir, 'wrangler.json')], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return 'wrangler.json';
}

/** Runs `wrangler preview bundle/worker.js --name pr-1 --config <config>` in `dir`, as the job's wrangler-action does. */
async function preview(dir: string, config: string) {
  requests.length = 0;
  const netLog = `${dir}-net.log`;
  writeFileSync(netLog, '');
  const env = sandboxEnv(home, {
    CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${stubPort}/client/v4`,
    HTTPS_PROXY: `http://127.0.0.1:${deadPort}`,
    HTTP_PROXY: `http://127.0.0.1:${deadPort}`,
    PREVIEW_UPLOAD_NET_LOG: netLog,
  });
  const child = spawn(process.execPath, ['--require', GUARD, WRANGLER_BIN, 'preview', 'bundle/worker.js', '--name', 'pr-1', '--config', config], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => (output += data.toString()));
  child.stderr.on('data', (data: Buffer) => (output += data.toString()));
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const net = readFileSync(netLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as NetEntry);
  const uploads = new Map<string, Buffer>();
  let metadata: { main_module?: string } = {};
  const deployment = requests.find((request) => request.method === 'POST' && request.path.endsWith('/deployments'));
  if (deployment) {
    const form = await new Response(new Uint8Array(deployment.body), { headers: { 'content-type': String(deployment.headers['content-type']) } }).formData();
    metadata = JSON.parse(String(form.get('metadata'))) as typeof metadata;
    for (const file of form.getAll('files')) if (typeof file !== 'string') uploads.set(file.name, Buffer.from(await file.arrayBuffer()));
  }
  // Hermetic, or the run proves nothing: only the stub and the dead proxy port, both on loopback.
  expect(requests.filter((request) => !request.expected).map((request) => `${request.method} ${request.path}`), output).toEqual([]);
  expect(requests.map((request) => request.headers.authorization)).toEqual(requests.map(() => `Bearer ${FAKE_TOKEN}`));
  expect(net.filter((entry) => !(entry.connect?.host === '127.0.0.1' && [stubPort, deadPort].includes(entry.connect.port ?? -1))), output).toEqual([]);
  expect(net.some((entry) => entry.connect?.port === stubPort), output).toBe(true);
  expect(status, output).toBe(0);
  return { output, uploads, metadata, bodies: requests.map((request) => request.body) };
}

const worker = (dir: string) => readFileSync(join(dir, 'bundle', 'worker.js'));
const holdsSecret = (bytes: Buffer) => bytes.includes(SECRET);

describe('RED: what wrangler uploads from a config that leaves it a way to read the runner', () => {
  test(
    'with the trusted wrangler.jsonc copied in, as the job did, wrangler bundles the imported file into worker.js',
    async () => {
      const dir = site('copied');
      writeFileSync(join(dir, 'wrangler.jsonc'), REPO_CONFIG);
      const { uploads } = await preview(dir, 'wrangler.jsonc');
      expect(holdsSecret(worker(dir))).toBe(false);
      expect(holdsSecret(uploads.get('worker.js')!)).toBe(true);
      expect(uploads.get('worker.js')!.equals(worker(dir))).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    'with no_bundle alone, wrangler uploads the file a source-map comment names, and the files beside worker.js',
    async () => {
      const dir = site('no-bundle-only', { 'bundle/beside.txt': SECRET });
      writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ ...(parseJsonc(REPO_CONFIG) as object), no_bundle: true, upload_source_maps: true }));
      const { uploads } = await preview(dir, 'wrangler.json');
      expect(uploads.get('worker.js')!.equals(worker(dir))).toBe(true);
      expect(holdsSecret(uploads.get('worker.js.map')!)).toBe(true);
      expect(holdsSecret(uploads.get('beside.txt')!)).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});

describe('GREEN: what wrangler uploads from the config trusted-config.mjs writes', () => {
  /** worker.js byte for byte, dist/_headers (which wrangler sends as a module), and nothing else; no request carries the secret. */
  function expectOnlyWorker(dir: string, run: Awaited<ReturnType<typeof preview>>) {
    expect([...run.uploads.keys()].sort()).toEqual(['_headers', 'worker.js']);
    expect(run.metadata.main_module).toBe('worker.js');
    expect(run.uploads.get('worker.js')!.equals(worker(dir))).toBe(true);
    expect(run.uploads.get('_headers')!.equals(readFileSync(join(dir, 'dist', '_headers')))).toBe(true);
    expect(run.bodies.filter(holdsSecret)).toEqual([]);
  }

  test(
    "from the repository's wrangler.jsonc, wrangler uploads worker.js byte for byte, and nothing of the runner's",
    async () => {
      const dir = site('written');
      expectOnlyWorker(dir, await preview(dir, writePreviewConfig(root('.'), dir)));
    },
    RUN_TIMEOUT_MS,
  );

  test(
    'from a trusted config that turns on source maps and additional modules, the same',
    async () => {
      const trusted = join(scratch, 'trusted-with-maps');
      mkdirSync(trusted);
      writeFileSync(join(trusted, 'wrangler.jsonc'), JSON.stringify({ ...(parseJsonc(REPO_CONFIG) as object), upload_source_maps: true, find_additional_modules: true }));
      const dir = site('written-over-maps', { 'bundle/beside.txt': SECRET });
      expectOnlyWorker(dir, await preview(dir, writePreviewConfig(trusted, dir)));
    },
    RUN_TIMEOUT_MS,
  );
});
