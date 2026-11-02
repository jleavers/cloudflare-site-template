// What the token jobs' wrangler uploads (sweep 20261027T190359Z, cluster 1). The preview job hands
// the pinned wrangler's preview command a worker.js that a pull request's build wrote, so wrangler
// must upload that file's bytes as they are, with the artifact's dist/ as assets, and read no other
// file on the runner because of what worker.js says. This runs that command, from a scratch copy of
// the job's site directory, against a stub of the Cloudflare API, and reads back what it uploaded.
// It also runs the deploy job's own command, read from ci.yml, as a dry run (Ruling 96).
//
// worker.js imports a stand-in secret file with `with { type: 'text' }`, as a hostile build could
// import /proc/self/environ, which holds the job's token, and names the same file in a
// `//# sourceMappingURL=` comment. The RED runs show that the harness sees the secret when wrangler
// reads it; the GREEN runs, with the config trusted-config.mjs writes or the deploy job's flags, that
// it never does.
//
// Hermetic. The stub listens on 127.0.0.1, and CLOUDFLARE_API_BASE_URL points wrangler at it.
// Proxy variables send every other request (wrangler sends all but loopback through them) to a proxy
// on 127.0.0.1, which refuses each one with a 403 and records the host and port it asked for, and
// each run fails unless those are among the ones expected: only registry.npmjs.org:443, for the
// update check in wrangler's banner. preview-upload-guard.mjs, preloaded into each wrangler process,
// logs every connection and lookup and refuses any destination but 127.0.0.1, and each run fails
// unless every connection went to the stub or the proxy. The stub fails a run on any request it
// doesn't expect, and on any that lacks the fake token. wrangler's home, config, cache and temporary
// folders are in this test's temporary directory, with no variable from the caller's environment
// but PATH (wrangler-sandbox.ts), and a run that hangs is killed, with every process it started.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseJsonc } from '../../scripts/trusted-config.mjs';
import { FAKE_ACCOUNT_ID, FAKE_TOKEN, WRANGLER_BIN, removeTree, sandboxEnv } from './wrangler-sandbox';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const GUARD = pathToFileURL(fileURLToPath(new URL('./preview-upload-guard.mjs', import.meta.url))).href;
const TRUSTED_CONFIG_SCRIPT = root('scripts/trusted-config.mjs');
const REPO_CONFIG = readFileSync(root('wrangler.jsonc'), 'utf8');
const SECRET = 'SYNTHETIC-PREVIEW-UPLOAD-SECRET-not-a-real-token';
// Each wrangler run takes a second or two; the first loads wrangler from a cold disk cache. A run
// still going after WRANGLER_TIMEOUT_MS is killed, well inside the test's own timeout.
const RUN_TIMEOUT_MS = 60_000;
const WRANGLER_TIMEOUT_MS = 45_000;
// What wrangler may ask the proxy for: the npm registry, for its banner's update check. The check is
// skipped while a cached answer is fresh, so a run may ask for less, never more.
const PROXY_TARGETS = ['registry.npmjs.org:443'];

const scratch = mkdtempSync(join(tmpdir(), 'preview-upload-'));
const home = join(scratch, 'home');
// Outside every site directory. JSON with a `sources` array, so wrangler would take it for a source
// map too; and the same text as plain text, which wrangler fails to parse as one.
const secretFile = join(scratch, 'secret', 'token.json');
mkdirSync(dirname(secretFile));
writeFileSync(secretFile, `${JSON.stringify({ version: 3, sources: [SECRET], names: [], mappings: '', secret: SECRET })}\n`);
writeFileSync(join(scratch, 'secret', 'token.txt'), `${SECRET}\n`);
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
const proxied: string[] = [];

// What wrangler 4.152.0's preview command asks for a new preview whose assets the stub already
// has (cli.js runPreview), under /client/v4/accounts/<account>/workers. A deploy dry run asks nothing.
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

// ROUTES answers one wrangler version's requests, and wrangler changes them between releases, so the
// preview runs below hold only for the version they were written for (Ruling 103). After an update,
// the template fails here until someone re-checks the preview path and updates ROUTES and this
// version. A site stamped from the template, whose monthly dependency pull request would otherwise
// stay red until its owner rewrote the stub, skips the preview runs instead; its previews then rest
// on trusted-config.mjs's settings and the workflow pins (trusted-config and ci-workflow tests).
const STUB_WRANGLER = '4.152.0';
const INSTALLED_WRANGLER = (JSON.parse(readFileSync(root('node_modules/wrangler/package.json'), 'utf8')) as { version: string }).version;
const STUB_MATCHES = INSTALLED_WRANGLER === STUB_WRANGLER;
// The marker docs.test.ts uses: a stamped site replaces README.md (new-site step 9a).
const TEMPLATE_REPOSITORY = (() => {
  try {
    return readFileSync(root('README.md'), 'utf8').split(/\r?\n/, 1)[0] === '# cloudflare-site-template';
  } catch {
    return false;
  }
})();

describe.runIf(TEMPLATE_REPOSITORY)('the API stub, in the template', () => {
  test("answers the installed wrangler's requests", () => {
    expect(
      INSTALLED_WRANGLER,
      `ROUTES answers wrangler ${STUB_WRANGLER}'s preview requests, and ${INSTALLED_WRANGLER} is installed: re-check what its preview command reads and uploads (cli.js previewHandler, buildWorker's no-bundle path), then update ROUTES and STUB_WRANGLER so the RED and GREEN runs below pass`,
    ).toBe(STUB_WRANGLER);
  });
});
if (!STUB_MATCHES && !TEMPLATE_REPOSITORY) {
  test.skip(`the preview upload runs were written for wrangler ${STUB_WRANGLER}, and this site has ${INSTALLED_WRANGLER}: previews rest on the trusted-config and ci-workflow tests`, () => {});
}

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

// The proxy: it refuses a CONNECT tunnel, or a plain request for an absolute URI, with a 403, and
// records the host and port each one asked for.
const proxy = createServer((request, response) => {
  const url = new URL(request.url ?? '', 'http://unknown.invalid');
  proxied.push(`${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
  response.writeHead(403);
  response.end();
});
proxy.on('connect', (request, socket) => {
  proxied.push(request.url ?? '');
  socket.on('error', () => {});
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});

let stubPort = 0;
let proxyPort = 0;
const listen = async (target: typeof server) => {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  return (target.address() as AddressInfo).port;
};

beforeAll(async () => {
  stubPort = await listen(server);
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  for (const target of [server, proxy]) {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
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

/** Kills a child and every process it started: its process group, made with `detached`, or its tree on Windows. */
function killAll(pid: number | undefined) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: every process in the group has exited already.
  }
}

/** Runs wrangler with `args` in `dir`, as the jobs' wrangler-action does, and checks that the run stayed on this machine. */
async function wrangler(dir: string, args: string[]) {
  requests.length = 0;
  proxied.length = 0;
  const netLog = `${dir}-net.log`;
  writeFileSync(netLog, '');
  const env = sandboxEnv(home, {
    CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${stubPort}/client/v4`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    PREVIEW_UPLOAD_NET_LOG: netLog,
  });
  const child = spawn(process.execPath, ['--import', GUARD, WRANGLER_BIN, ...args], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so that killAll reaches the CLI process the bin starts, and esbuild.
    detached: process.platform !== 'win32',
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => (output += data.toString()));
  child.stderr.on('data', (data: Buffer) => (output += data.toString()));
  const timer = setTimeout(() => killAll(child.pid), WRANGLER_TIMEOUT_MS);
  let status: number | null;
  try {
    status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  } finally {
    clearTimeout(timer);
    killAll(child.pid);
  }
  const net = readFileSync(netLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as NetEntry);
  // Hermetic, or the run proves nothing: only the stub and the proxy, both on loopback, and only the
  // proxy targets expected.
  expect(requests.filter((request) => !request.expected).map((request) => `${request.method} ${request.path}`), output).toEqual([]);
  expect(requests.map((request) => request.headers.authorization)).toEqual(requests.map(() => `Bearer ${FAKE_TOKEN}`));
  expect(net.filter((entry) => !(entry.connect?.host === '127.0.0.1' && [stubPort, proxyPort].includes(entry.connect.port ?? -1))), output).toEqual([]);
  expect(proxied.filter((target) => !PROXY_TARGETS.includes(target)), output).toEqual([]);
  // And the proxy saw every request sent its way: one target for each connection to it.
  expect(proxied.length, output).toBe(net.filter((entry) => entry.connect?.port === proxyPort).length);
  return { status, output, net };
}

/** Runs `wrangler preview bundle/worker.js --name pr-1 --config <config>` in `dir`, and reads back what it uploaded. */
async function preview(dir: string, config: string) {
  const { status, output, net } = await wrangler(dir, ['preview', 'bundle/worker.js', '--name', 'pr-1', '--config', config]);
  expect(status, output).toBe(0);
  expect(net.some((entry) => entry.connect?.port === stubPort), output).toBe(true);
  const uploads = new Map<string, Buffer>();
  let metadata: { main_module?: string } = {};
  const deployment = requests.find((request) => request.method === 'POST' && request.path.endsWith('/deployments'));
  if (deployment) {
    const form = await new Response(new Uint8Array(deployment.body), { headers: { 'content-type': String(deployment.headers['content-type']) } }).formData();
    metadata = JSON.parse(String(form.get('metadata'))) as typeof metadata;
    for (const file of form.getAll('files')) if (typeof file !== 'string') uploads.set(file.name, Buffer.from(await file.arrayBuffer()));
  }
  return { output, uploads, metadata, bodies: requests.map((request) => request.body) };
}

const worker = (dir: string) => readFileSync(join(dir, 'bundle', 'worker.js'));
const holdsSecret = (bytes: Buffer) => bytes.includes(SECRET);

describe.runIf(STUB_MATCHES)('RED: what wrangler uploads from a config that leaves it a way to read the runner', () => {
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

describe.runIf(STUB_MATCHES)('GREEN: what wrangler uploads from the config trusted-config.mjs writes', () => {
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

// Ruling 96. The deploy job's worker.js comes from verify, which runs main's lockfile code, and
// `--no-bundle` alone still reads the file a `//# sourceMappingURL=` comment names when main's
// wrangler.jsonc sets upload_source_maps: a JSON file is uploaded as worker.js.map, and anything
// else fails the deploy with its first bytes in the log. A dry run reads it the same way, and here
// the comment names a plain-text secret, so the log shows whether wrangler read it.
describe("the deploy job's own command, as a dry run, from a main that turns on source maps", () => {
  const command = /^ {10}command: (deploy [^\n]*)$/m.exec(readFileSync(root('.github/workflows/ci.yml'), 'utf8'))?.[1] ?? '';
  const deploySite = (name: string) => {
    const dir = site(name, { 'bundle/worker.js': "export default { fetch: () => new Response('ok') };\n//# sourceMappingURL=../../secret/token.txt\n" });
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ ...(parseJsonc(REPO_CONFIG) as object), upload_source_maps: true }));
    return dir;
  };
  const leaked = `"${SECRET.slice(0, 10)}"`;

  test('ci.yml has the command, with --no-bundle and --upload-source-maps=false', () => {
    expect(command.split(' ')).toEqual(expect.arrayContaining(['deploy', 'bundle/worker.js', '--no-bundle', '--upload-source-maps=false', '--config', 'wrangler.jsonc']));
  });

  test(
    'RED: without --upload-source-maps=false, wrangler reads the named file, and prints its first bytes',
    async () => {
      const { status, output } = await wrangler(deploySite('deploy-maps-on'), [...command.split(' ').filter((arg) => arg !== '--upload-source-maps=false'), '--dry-run']);
      expect(status, output).toBe(1);
      expect(output).toContain(leaked);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    'GREEN: with the command as ci.yml has it, wrangler reads no source map',
    async () => {
      const { status, output } = await wrangler(deploySite('deploy-maps-off'), [...command.split(' '), '--dry-run']);
      expect(status, output).toBe(0);
      expect(output).toContain('--dry-run: exiting now.');
      expect(output).not.toContain(SECRET.slice(0, 10));
    },
    RUN_TIMEOUT_MS,
  );
});
