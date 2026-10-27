import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CI jobs that hold the Cloudflare token run this from a sparse checkout of the trusted ref,
// with no node_modules, so it imports nothing but node: modules. It refuses a wrangler.jsonc that
// would make wrangler run a shell command, and hands the job its pinned wrangler version. For the
// preview job it also writes the config that job hands wrangler (see previewConfig).
//
//   node trusted/scripts/trusted-config.mjs trusted   (appends wrangler-version=x.y.z to $GITHUB_OUTPUT)
//   node trusted/scripts/trusted-config.mjs --preview-config trusted "$RUNNER_TEMP/site/wrangler.json"

// A string, or a comment. Strings come first, so a "//" or "/*" inside one is left alone.
const STRING_OR_COMMENT = /"(?:[^"\\]|\\[\s\S])*"|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g;
// A string, or a comma that only whitespace separates from a closing bracket.
const STRING_OR_TRAILING_COMMA = /"(?:[^"\\]|\\[\s\S])*"|,(?=[ \t\n\r]*[}\]])/g;

/**
 * Parses JSONC (JSON with line and block comments, and trailing commas) as wrangler reads it.
 * A comment becomes a space, as it is a token break for wrangler's parser too. Anything else that
 * is not JSON throws, so a job fails closed.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  const withoutComments = text.replace(STRING_OR_COMMENT, (token) => (token.startsWith('"') ? token : ' '));
  return JSON.parse(withoutComments.replace(STRING_OR_TRAILING_COMMA, (token) => (token === ',' ? '' : token)));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Refuses a wrangler config with a custom build, at the top level or in any `env.<name>`: wrangler
 * runs a build's command in a shell. Also refuses a `__proto__` key anywhere, which JSON.parse
 * keeps as a plain key but wrangler's parser turns into inherited settings, a build among them.
 *
 * @param {unknown} config the parsed wrangler.jsonc
 * @returns {void}
 */
export function refuseBuild(config) {
  refuseProtoKeys(config, '');
  if (!isObject(config)) throw new Error('is not a JSON object');
  if (Object.hasOwn(config, 'build')) throw new Error('sets "build": a custom build runs a shell command');
  if (!Object.hasOwn(config, 'env')) return;
  if (!isObject(config.env)) throw new Error('"env" is not an object');
  for (const [name, env] of Object.entries(config.env)) {
    if (isObject(env) && Object.hasOwn(env, 'build')) throw new Error(`sets "env.${name}.build": a custom build runs a shell command`);
  }
}

/** @param {unknown} value @param {string} at */
function refuseProtoKeys(value, at) {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__') throw new Error(`has a "__proto__" key${at ? ` in ${at}` : ''}, which wrangler reads as inherited settings`);
    refuseProtoKeys(child, at ? `${at}.${key}` : key);
  }
}

/**
 * What the preview job's config sets, whatever the trusted wrangler.jsonc says. That job holds the
 * token, and bundle/worker.js comes from preview-build, which ran the pull request's build and
 * lockfile code, so wrangler must upload that file's bytes as they are:
 * - no_bundle: otherwise wrangler bundles worker.js again, and esbuild follows an import
 *   `with { type: 'text' }` to any file on the runner (/proc/self/environ, which holds the token,
 *   included) and inlines it into the Worker that wrangler uploads;
 * - upload_source_maps: false, because without a bundle wrangler would read, and upload as
 *   worker.js.map, any JSON file with a `sources` array that worker.js's last
 *   `//# sourceMappingURL=` comment names, wherever it is;
 * - find_additional_modules: false, because without a bundle wrangler would otherwise upload every
 *   file under the module root (beside worker.js, or base_dir) that the rules match.
 */
export const PREVIEW_SETTINGS = Object.freeze({ no_bundle: true, upload_source_maps: false, find_additional_modules: false });

// What a previews block may not hold, and why. wrangler 4.149.0 ignores the first four there, with
// a warning, but a later wrangler could honour them; it applies the last two.
const PREVIEWS_REFUSED = {
  no_bundle: 'the preview job sets it at the top level, where wrangler reads it',
  upload_source_maps: 'the preview job sets it at the top level, where wrangler reads it',
  find_additional_modules: 'the preview job sets it at the top level, where wrangler reads it',
  build: 'a custom build runs a shell command',
  define: 'wrangler applies it only when it bundles, and the preview job uploads worker.js as preview-build bundled it',
  containers: "wrangler builds, with Docker, any image whose path names a file in the site directory, where the artifact's dist/ is",
};

/**
 * The config the preview job hands wrangler: the trusted wrangler.jsonc with PREVIEW_SETTINGS, so
 * that wrangler uploads bundle/worker.js byte for byte, with the artifact's dist/ as assets, and
 * reads no other file because of what the artifact holds. It drops `env`: the job targets the
 * top-level Worker, and with no environments in the file, any one wrangler might be told to target
 * inherits these settings. It drops `tsconfig`: without a bundle, wrangler would use it only to
 * guess worker.js's module format, and the job puts no tsconfig beside the config. It throws on
 * what refuseBuild refuses, on an assets directory other than ./dist, and on a key in
 * PREVIEWS_REFUSED.
 *
 * @param {unknown} config the parsed trusted wrangler.jsonc
 * @returns {Record<string, unknown>}
 */
export function previewConfig(config) {
  refuseBuild(config);
  if (!isObject(config)) throw new Error('is not a JSON object');
  if (Object.hasOwn(config, 'assets')) {
    const { assets } = config;
    if (!isObject(assets) || typeof assets.directory !== 'string' || !/^(?:\.\/)?dist\/?$/.test(assets.directory)) {
      throw new Error('"assets.directory" must be "./dist": the preview job copies the artifact\'s dist/ there, and nothing else');
    }
  }
  if (Object.hasOwn(config, 'previews')) {
    if (!isObject(config.previews)) throw new Error('"previews" is not an object');
    for (const [key, why] of Object.entries(PREVIEWS_REFUSED)) {
      if (Object.hasOwn(config.previews, key)) throw new Error(`sets "previews.${key}": ${why}`);
    }
  }
  const { env: _env, tsconfig: _tsconfig, ...rest } = config;
  return { ...rest, ...PREVIEW_SETTINGS };
}

/**
 * The exact version a package.json pins for a devDependency, or a throw: a range, a dist-tag, a
 * path or a URL would let the registry or the branch choose what the token job runs.
 *
 * @param {unknown} packageJson the parsed package.json
 * @param {string} name the devDependency
 * @returns {string} x.y.z
 */
export function exactVersion(packageJson, name) {
  const pins = isObject(packageJson) && isObject(packageJson.devDependencies) ? packageJson.devDependencies : {};
  const version = Object.hasOwn(pins, name) ? pins[name] : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`devDependencies.${name} must be an exact x.y.z version, not ${JSON.stringify(version) ?? 'missing'}`);
  }
  return version;
}

/**
 * @template T
 * @param {string} dir @param {string} file @param {(text: string) => T} check
 * @returns {T}
 */
function checkFile(dir, file, check) {
  try {
    return check(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string | undefined} dir */
function main(dir) {
  if (!dir) throw new Error('usage: node trusted-config.mjs <dir holding wrangler.jsonc and package.json>');
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set');
  checkFile(dir, 'wrangler.jsonc', (text) => refuseBuild(parseJsonc(text)));
  const version = checkFile(dir, 'package.json', (text) => exactVersion(JSON.parse(text), 'wrangler'));
  appendFileSync(output, `wrangler-version=${version}\n`);
  console.log(`trusted-config: wrangler.jsonc has no custom build; wrangler ${version}`);
}

/** @param {string[]} args `<dir holding wrangler.jsonc> <file>.json` */
function writePreviewConfig(args) {
  const [dir, file] = args;
  if (args.length !== 2 || !dir || !file) throw new Error('usage: node trusted-config.mjs --preview-config <dir holding wrangler.jsonc> <file>.json');
  // wrangler reads a config whose name ends in anything but .json, .jsonc or .toml as an empty one.
  if (!file.endsWith('.json')) throw new Error(`${file}: the preview config must be a .json file`);
  const config = checkFile(dir, 'wrangler.jsonc', (text) => previewConfig(parseJsonc(text)));
  // Plain JSON, serialised from what parseJsonc read and previewConfig checked. wrangler parses this
  // text, not the trusted JSONC, so it reads exactly those settings, whatever its own JSONC reader
  // would have made of that file's comments, escapes or repeated keys: for this job, that settles
  // the parser-differential question (sweep 20261027T190359Z, gap 7). The flag `wx` fails, rather
  // than replace a file or follow a link, if anything is already at that path.
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const settings = Object.entries(PREVIEW_SETTINGS).map(([key, value]) => `${key} ${value}`);
  console.log(`trusted-config: wrote ${file} from wrangler.jsonc, with ${settings.join(', ')}, and no env or tsconfig`);
}

/** Whether node was asked to run this file, by any path: Node resolves symlinks in import.meta.url. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// The token jobs also stop when the version output is empty, in case this ever fails to run main(),
// and the preview job stops when the config file is missing. An older copy of this script, without
// --preview-config, reads that flag as a directory, finds no wrangler.jsonc in it, and exits 1.
if (invokedDirectly()) {
  try {
    const [first, ...rest] = process.argv.slice(2);
    if (first === '--preview-config') writePreviewConfig(rest);
    else main(first);
  } catch (error) {
    console.error(`trusted-config: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
