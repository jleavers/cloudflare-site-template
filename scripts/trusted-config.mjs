import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The CI jobs that hold the Cloudflare token run this from a sparse checkout of the trusted ref,
// with no node_modules, so it imports nothing but node: modules. It refuses a wrangler.jsonc that
// would make wrangler run a shell command, and hands the job its pinned wrangler version.
//
//   node trusted/scripts/trusted-config.mjs trusted   (appends wrangler-version=x.y.z to $GITHUB_OUTPUT)

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`trusted-config: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
