// Runs the pinned wrangler so that it reaches nothing real: every folder it writes is inside the
// test's own temporary directory, it gets a fake token and account ID if any, metrics are off, and
// nothing else of the caller's environment (no CLOUDFLARE_*, WRANGLER_* or proxy variable, no real
// home directory) reaches it.
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

const require = createRequire(import.meta.url);
const PACKAGE = dirname(require.resolve('wrangler/package.json'));
/** The pinned wrangler's Node API, as `require()` loads it. */
export const WRANGLER_API = require.resolve('wrangler');
/** The pinned wrangler's command line: what `npx wrangler` runs. */
export const WRANGLER_BIN = join(PACKAGE, 'bin', 'wrangler.js');

export const FAKE_TOKEN = 'fake-cloudflare-api-token-for-tests';
export const FAKE_ACCOUNT_ID = '0'.repeat(32);

/** An environment for a wrangler child process: `home` holds every folder it writes, and `extra` is all else it gets. */
export function sandboxEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    WRANGLER_SEND_METRICS: 'false',
    ...extra,
  };
  // Windows needs these to start a process at all; none of them names a credential.
  for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

/** Removes a directory the test made, never following a link, and never outside `root`. */
export function removeTree(root: string, path = root): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`not removing ${path}: outside ${root}`);
  if (!lstatSync(path).isDirectory()) return unlinkSync(path);
  for (const name of readdirSync(path)) removeTree(root, join(path, name));
  rmdirSync(path);
}
