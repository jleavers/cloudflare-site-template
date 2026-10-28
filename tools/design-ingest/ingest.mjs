import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';

// The only way a Claude Design bundle reaches the checkout (the new-site skill, step 2). It reads
// the handoff URL from design/SOURCE.md itself, or a local .zip or .tar.gz, or a folder outside the
// repository, checks every entry against one allow-list, and only then writes a fresh
// design/bundle/. The allow-list judges an entry by its path and type, and a file also by its bytes,
// since a design file type can still be code to a tool: a stylesheet's @plugin makes Tailwind run a
// module. Nothing it reads is ever put into a command line, and nothing is renamed in place: an
// entry outside the allow-list is refused (the whole bundle) or omitted (that entry), never moved
// aside. It imports only node: modules, so it needs no install, and it runs the same on Windows and
// Linux.
//
//   node tools/design-ingest/ingest.mjs --source [--host <name>]   the URL in design/SOURCE.md
//   node tools/design-ingest/ingest.mjs --archive design/<file>     a .zip or .tar.gz
//   node tools/design-ingest/ingest.mjs --dir "<a folder outside the repository>"
//                                                 a folder, or saved artifact files; never inside it
//
// tests/unit/design-ingest.test.ts holds the hostile shapes it refuses.

/**
 * @typedef {{ maxArchiveBytes: number, maxBytes: number, maxEntries: number, maxDepth: number, maxPathBytes: number, maxRedirects: number, timeoutMs: number, maxHeaderBytes: number }} Limits
 */

/** The caps. Every reader takes them as a parameter, so a test can use small ones. @type {Readonly<Limits>} */
export const LIMITS = Object.freeze({
  /** A download, or an --archive file. */
  maxArchiveBytes: 20971520,
  /** Everything decompressed, in total. */
  maxBytes: 52428800,
  /** Entries, folders included; also the files and folders written. */
  maxEntries: 2000,
  maxDepth: 32,
  maxPathBytes: 1024,
  maxRedirects: 5,
  /** The whole download, every hop and the body. */
  timeoutMs: 60000,
  /** A tar pax ('x', 'g') or GNU long-name ('L') header's body, checked before it is parsed. */
  maxHeaderBytes: 65536,
});

/** Claude Design's handoff host. Any other needs --host, after the person confirms it. */
export const HANDOFF_HOST = 'api.anthropic.com';

/** Agent-instruction file names, compared lower-cased; so is the `.mdc` suffix. */
const INSTRUCTIONS = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'agent.md', 'skill.md', 'gemini.md', 'copilot-instructions.md']);
/**
 * Tool configurations of a design file type, compared folded. An editor or build tool finds one by
 * looking upward from a file, or across the whole workspace, and a configuration can run code or
 * name code to run. Names a design file type cannot carry (`.cjs`, `.yaml`, `.toml`, a dotfile)
 * are omitted anyway. tools/design-ingest/README.md says which tool each one is for.
 */
const TOOL_CONFIG = new RegExp(
  [
    // ESLint, Prettier, Stylelint, PostCSS, Babel, Vite, Vitest, Jest, Playwright, Astro, Tailwind,
    // lint-staged, oxlint, knip, cspell and many more: <tool>.config.{js,mjs,cjs,ts,mts,cts}.
    String.raw`\.config\.[cm]?[jt]s$`,
    // Keys in package.json configure most of them, and tsconfig.json or jsconfig.json loads tsserver plugins.
    String.raw`^package\.json$`,
    String.raw`^tsconfig.*\.json$`,
    String.raw`^jsconfig\.json$`,
    String.raw`^babel\.config\.json$`,
    String.raw`^deno\.jsonc?$`,
    String.raw`^biome\.jsonc?$`,
    String.raw`^vitest\.workspace\.(?:[cm]?[jt]s|json)$`,
    // The Tailwind CSS language server's {tailwind,tailwind.config,tailwind.*.config,tailwind.config.*}.{js,…}.
    String.raw`^tailwind(?:\.config\..*)?\.[cm]?[jt]s$`,
    // cspell (a configuration may import a JavaScript one), dprint (its plugins download and run),
    // Jest (setupFiles, globalSetup and transform name modules it runs), and knip.
    String.raw`^cspell(?:\.config)?\.json$`,
    String.raw`^dprint\.json$`,
    String.raw`^jest\.config\.json$`,
    String.raw`^knip\.(?:json|[cm]?[jt]s)$`,
  ].join('|'),
);
/**
 * A package folder, compared folded. A tool that loads a package for a file looks in the nearest
 * `node_modules` first: the Tailwind CSS language server imports `tailwindcss` that way for every
 * stylesheet it takes as a Tailwind 4 one, which `@import "tailwindcss"` is enough for.
 */
const PACKAGE_FOLDER = 'node_modules';
/** The file types a design is made of, compared lower-cased (not folded: `.ＰＮＧ` is not `.png`). */
const DESIGN_TYPES = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
/** Device names Windows reserves in any folder, with any extension (superscript digits included). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\..*)?$/i;
/**
 * The only segments written: letters, digits, combining marks, space and `. _ ( ) + , @ -`,
 * starting with a letter, a digit or `_`. A combining mark (Mn, Mc) may follow any first character,
 * as in an NFD name from macOS or an Indic or Thai name. No character may be default-ignorable,
 * since one renders as nothing: not a variation selector or the combining grapheme joiner (marks),
 * nor a Hangul filler (a letter). Such a name is safe inside double quotes in a POSIX shell or
 * PowerShell, so a later step may use a path from design/bundle/ in a command (Rulings 89 and 92).
 */
const ALLOWED_NAME = /^(?![^]*\p{Default_Ignorable_Code_Point})[\p{L}\p{N}_][\p{L}\p{N}\p{Mn}\p{Mc} ._()+,@-]*$/u;
const ALLOWED_SET = 'letters, digits, combining marks, space and . _ ( ) + , @ -';
/**
 * A name folded as case-insensitive and normalising filesystems fold it, or more strictly: NFKC,
 * then lower-, upper- and lower-cased, so `ſ` is `s`, `ﬆ` is `st`, the Kelvin sign is `k`,
 * fullwidth letters are ASCII, and `ß` and `ẞ` are both `ss`. The first lower-casing takes `ẞ` to
 * `ß`, which the upper-casing then takes to `SS`, so a folded name folds to itself. Used for
 * agent-instruction and tool-configuration names, and duplicates.
 */
export const fold = (/** @type {string} */ name) => name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase();
/** A host name of letters, digits and hyphens, whose last label starts with a letter: no IP address, and nothing a shell reads specially. */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const SPECIAL_MODES = new Map([
  [0o120000, 'a symbolic link'],
  [0o020000, 'a character device'],
  [0o060000, 'a block device'],
  [0o010000, 'a FIFO'],
  [0o140000, 'a socket'],
]);

/** Why the whole bundle was refused. Nothing has been written when one is thrown. */
export class Refusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

/** A command line that gives no input, more than one, or --host without --source. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** @param {string} reason @returns {never} */
function refuse(reason) {
  throw new Refusal(reason);
}

/** @typedef {{ name: string, kind: 'file' | 'dir', data?: Uint8Array }} Entry */
/** @typedef {(url: string, init: { redirect: 'manual', signal: AbortSignal }) => Promise<Response>} Fetch */
/** @typedef {{ dirs: string[], files: { path: string, data: Uint8Array }[], omitted: { name: string, reason: string }[] }} Plan */
/** @typedef {{ from: string, dirs: string[], files: string[], bytes: number, omitted: { name: string, reason: string }[] }} Summary */

/** @param {Partial<Limits>} [limits] @returns {Limits} */
const withLimits = (limits) => ({ ...LIMITS, ...limits });

/**
 * What JSON.stringify leaves raw but a terminal may act on or render invisibly: DEL, C1 controls,
 * format characters, separators, and default-ignorable characters (a variation selector, the
 * combining grapheme joiner), so two names that differ only by one never print alike.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
/** A code point as U+XXXX. */
const codePoint = (/** @type {string} */ character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
/** A name as JSON, every control, format, separator or default-ignorable character escaped, so none reaches a terminal raw; a long one is cut short. */
const show = (/** @type {string} */ name) =>
  JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}…` : name).replace(INVISIBLE, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
  });
const hex = (/** @type {Uint8Array} */ bytes) => `${Buffer.from(bytes.subarray(0, 32)).toString('hex').replace(/(..)(?!$)/g, '$1 ')}${bytes.length > 32 ? ' …' : ''}`;
const bytesText = (/** @type {number} */ count) => (count % 1048576 === 0 ? `${count} bytes (${count / 1048576} MB)` : `${count} bytes`);
const plural = (/** @type {number} */ count, /** @type {string} */ one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const errorText = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** @param {Uint8Array} bytes @returns {string} */
function decodeName(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return refuse(`an entry's name is not valid UTF-8 (bytes ${hex(bytes)})`);
  }
}

// ---------------------------------------------------------------------------------------------
// The handoff URL

/**
 * The handoff URL on the first line of design/SOURCE.md, parsed, or a refusal: it must be https:,
 * with no username, password or port other than 443, on api.anthropic.com or on the host the
 * person confirmed with --host.
 *
 * @param {string} text design/SOURCE.md
 * @param {{ host?: string }} [options]
 * @returns {URL}
 */
export function sourceUrl(text, { host } = {}) {
  let confirmed;
  if (host !== undefined) {
    confirmed = host.toLowerCase();
    if (!DNS_NAME.test(confirmed)) refuse(`--host ${show(host)} is not a plain DNS name`);
  }
  const line = (text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '').trim();
  if (!line) refuse('design/SOURCE.md has no URL on its first line');
  /** @type {URL} */
  let url;
  try {
    url = new URL(line);
  } catch {
    return refuse('the first line of design/SOURCE.md is not a URL');
  }
  if (url.protocol !== 'https:') refuse(`the handoff URL is ${url.protocol}, not https:`);
  if (url.username || url.password) refuse('the handoff URL has a username or password');
  if (url.port) refuse(`the handoff URL names port ${url.port}; only https's own, 443, is allowed`);
  if (!DNS_NAME.test(url.hostname)) refuse("the handoff URL's host is not a plain DNS name");
  if (url.hostname === HANDOFF_HOST || url.hostname === confirmed) return url;
  if (confirmed) refuse(`the handoff URL's host is ${url.hostname}, not ${HANDOFF_HOST} or ${confirmed}`);
  return refuse(
    `the handoff URL's host is ${url.hostname}, not ${HANDOFF_HOST}. Ask the person whether they trust that host, and only if they confirm it, run again with --source --host ${url.hostname}`,
  );
}

/**
 * The redirect policy, over the hops followed so far (each an absolute URL): at most
 * `maxRedirects`, each https: with no username or password. A hop may change the host.
 *
 * @param {string[]} hops
 * @param {{ maxRedirects?: number }} [options]
 */
export function checkHops(hops, { maxRedirects = LIMITS.maxRedirects } = {}) {
  if (hops.length > maxRedirects) refuse(`the download took more than ${maxRedirects} redirects`);
  for (const hop of hops) {
    /** @type {URL} */
    let url;
    try {
      url = new URL(hop);
    } catch {
      return refuse('a redirect pointed at something that is not a URL');
    }
    if (url.protocol !== 'https:') refuse(`a redirect pointed at ${url.protocol}//${url.host}, which is not https:`);
    if (url.username || url.password) refuse('a redirect pointed at a URL with a username or password');
  }
}

/**
 * Settles with the promise, or rejects when the signal aborts, whichever is first.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function untilAborted(promise, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Downloads the bundle into memory, never to disk: `fetch` with `redirect: 'manual'`, each hop
 * through checkHops, the body capped on Content-Length and again as it streams, and one timeout
 * over the whole download.
 *
 * @param {URL} url a URL sourceUrl returned
 * @param {Partial<Limits> & { fetch?: Fetch }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function download(url, options = {}) {
  const { fetch: get = /** @type {Fetch} */ (globalThis.fetch), maxArchiveBytes, maxRedirects, timeoutMs } = { ...LIMITS, ...options };
  const signal = AbortSignal.timeout(timeoutMs);
  /** @type {string[]} */
  const hops = [];
  let current = url;
  try {
    for (;;) {
      const response = await untilAborted(get(current.href, { redirect: 'manual', signal }), signal);
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) refuse(`a redirect (HTTP ${response.status}) had no Location`);
        /** @type {URL} */
        let next;
        try {
          next = new URL(location, current);
        } catch {
          return refuse('a redirect pointed at something that is not a URL');
        }
        hops.push(next.href);
        checkHops(hops, { maxRedirects });
        current = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        refuse(`the download answered HTTP ${response.status}`);
      }
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > maxArchiveBytes) {
        await response.body?.cancel().catch(() => {});
        refuse(`the download's Content-Length ${length} is over the cap of ${bytesText(maxArchiveBytes)}`);
      }
      return await readCapped(response.body, maxArchiveBytes, signal);
    }
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (signal.aborted) refuse(`the download did not finish within ${timeoutMs / 1000} s`);
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${errorText(error.cause)})` : '';
    return refuse(`the download failed: ${errorText(error)}${cause}`);
  }
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} max
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array>}
 */
async function readCapped(body, max, signal) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > max) refuse(`the download is more than ${bytesText(max)}`);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------------------------
// Archives

/**
 * Reads a .zip or a .tar.gz, decided by its first bytes, never by its name.
 *
 * @param {Uint8Array} bytes
 * @param {Partial<Limits>} [limits]
 * @returns {Entry[]}
 */
export function readArchive(bytes, limits) {
  const caps = withLimits(limits);
  if (bytes.length > caps.maxArchiveBytes) refuse(`the archive is larger than ${bytesText(caps.maxArchiveBytes)}`);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return readTarGz(bytes, caps);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return readZip(bytes, caps);
  return refuse('the archive is neither a zip (which starts 50 4b 03 04) nor a gzip-compressed tar (1f 8b), by its first bytes');
}

/**
 * @param {Uint8Array} bytes
 * @param {Partial<Limits>} [limits]
 * @returns {Entry[]}
 */
export function readTarGz(bytes, limits) {
  const caps = withLimits(limits);
  /** @type {Buffer} */
  let tar;
  try {
    // maxOutputLength stops inflating as soon as the output passes the cap.
    tar = gunzipSync(bytes, { maxOutputLength: caps.maxBytes });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ERR_BUFFER_TOO_LARGE') refuse(`the archive decompresses to more than ${bytesText(caps.maxBytes)}`);
    return refuse(`the gzip data is corrupt (${errorText(error)})`);
  }
  return readTar(tar, caps);
}

/** @param {Buffer} block @param {number} start @param {number} length */
const cString = (block, start, length) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
};

/** @param {Buffer} header @param {number} start @param {number} length @param {string} what @param {number} at */
function octalField(header, start, length, what, at) {
  const text = header.toString('latin1', start, start + length).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(text)) refuse(`the tar header at byte ${at} has a malformed ${what} field`);
  return parseInt(text, 8);
}

/** @param {Buffer} header @param {number} at */
function checkChecksum(header, at) {
  const stored = octalField(header, 148, 8, 'checksum', at);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i] ?? 0;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  // Old writers summed signed bytes; tar readers accept either sum.
  if (stored !== unsigned && stored !== signed) refuse(`the tar header at byte ${at} has a bad checksum`);
}

/**
 * A pax header's records, as [key, value] pairs, in order.
 *
 * @param {Buffer} content
 * @param {number} at
 * @returns {[string, string][]}
 */
function paxRecords(content, at) {
  const malformed = () => refuse(`the pax header at byte ${at} is malformed`);
  /** @type {[string, string][]} */
  const records = [];
  let position = 0;
  while (position < content.length) {
    const space = content.indexOf(0x20, position);
    const lengthText = space === -1 ? '' : content.toString('latin1', position, space);
    if (!/^[1-9]\d{0,8}$/.test(lengthText)) malformed();
    const end = position + Number(lengthText);
    if (end > content.length || end <= space + 1 || content[end - 1] !== 0x0a) malformed();
    let record;
    try {
      record = UTF8.decode(content.subarray(space + 1, end - 1));
    } catch {
      return refuse(`the pax header at byte ${at} is not valid UTF-8`);
    }
    const equals = record.indexOf('=');
    if (equals <= 0) malformed();
    records.push([record.slice(0, equals), record.slice(equals + 1)]);
    position = end;
  }
  return records;
}

/**
 * A pax extended header ('x'). Only `path` and `size` are honoured; other keys are ignored.
 *
 * @param {Buffer} content
 * @param {number} at
 * @returns {{ path?: string, size?: number }}
 */
function parsePax(content, at) {
  /** @type {{ path?: string, size?: number }} */
  const result = {};
  for (const [key, value] of paxRecords(content, at)) {
    if (key === 'path') result.path = value;
    if (key === 'size') {
      if (!/^\d{1,15}$/.test(value)) refuse(`the pax header at byte ${at} is malformed`);
      result.size = Number(value);
    }
  }
  return result;
}

/**
 * Reads an uncompressed tar (POSIX ustar, or GNU). It admits regular files ('0' and NUL),
 * folders ('5'), pax extended headers ('x', for `path` and `size` only), GNU long names ('L'),
 * and a pax global header ('g') whose only key is `comment`, as `git archive` writes, which it
 * ignores. It refuses every other type, and a global header with any other key.
 *
 * @param {Uint8Array} bytes
 * @param {Partial<Limits>} [limits]
 * @returns {Entry[]}
 */
export function readTar(bytes, limits) {
  const caps = withLimits(limits);
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  /** @type {Entry[]} */
  const entries = [];
  /** @type {{ pax?: { path?: string, size?: number }, longName?: Uint8Array } | null} */
  let pending = null;
  let total = 0;
  let offset = 0;
  while (offset < data.length) {
    if (offset + 512 > data.length) refuse('the tar ends in the middle of a header');
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!data.subarray(offset).every((byte) => byte === 0)) refuse('the tar has data after the end-of-archive marker');
      break;
    }
    checkChecksum(header, offset);
    const magic = header.toString('latin1', 257, 265);
    const posix = magic === 'ustar\u000000';
    if (!posix && magic !== 'ustar  \u0000') refuse(`the tar header at byte ${offset} is not a ustar or GNU tar header`);
    const type = header[156] === 0 ? '\0' : String.fromCharCode(header[156] ?? 0);
    if ((header[124] ?? 0) & 0x80) refuse(`the tar header at byte ${offset} has a base-256 size, for an entry over 8 GB`);
    let size = octalField(header, 124, 12, 'size', offset);
    const body = offset + 512;

    if (type === 'x' || type === 'L') {
      if (size > caps.maxHeaderBytes) refuse(`the tar's ${type === 'x' ? 'pax' : 'GNU long-name'} header at byte ${offset} is ${size} bytes, more than ${caps.maxHeaderBytes}`);
      if (body + size > data.length) refuse(`the tar's ${type === 'x' ? 'pax' : 'GNU long-name'} header at byte ${offset} runs past the end of the archive`);
      const content = data.subarray(body, body + size);
      if (type === 'x') {
        if (pending?.pax) refuse(`the tar has two pax headers in a row at byte ${offset}`);
        pending = { ...pending, pax: parsePax(content, offset) };
      } else {
        if (pending?.longName) refuse(`the tar has two GNU long-name headers in a row at byte ${offset}`);
        pending = { ...pending, longName: cString(content, 0, content.length) };
      }
      offset = body + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'K') refuse(`the tar header at byte ${offset} is a GNU long link name (type K), which only a link has`);
    if (type === 'g') {
      // git archive writes one, holding the commit id as a comment. Any other key would set something for every entry.
      if (size > caps.maxHeaderBytes) refuse(`the tar's pax global header (type g) at byte ${offset} is ${size} bytes, more than ${caps.maxHeaderBytes}`);
      if (body + size > data.length) refuse(`the tar's pax global header (type g) at byte ${offset} runs past the end of the archive`);
      const keys = paxRecords(data.subarray(body, body + size), offset).map(([key]) => key);
      const other = keys.find((key) => key !== 'comment');
      if (other !== undefined) refuse(`the tar's pax global header (type g) at byte ${offset} sets ${show(other)}: only a "comment" is allowed, as git archive writes`);
      if (keys.length === 0) refuse(`the tar's pax global header (type g) at byte ${offset} is empty`);
      offset = body + Math.ceil(size / 512) * 512;
      continue;
    }

    let nameBytes = cString(header, 0, 100);
    if (posix) {
      const prefix = cString(header, 345, 155);
      if (prefix.length) nameBytes = Buffer.concat([prefix, Buffer.from('/'), nameBytes]);
    }
    if (pending?.pax?.path !== undefined && pending.longName) refuse(`the tar entry at byte ${offset} has both a pax path and a GNU long name`);
    const name = pending?.longName ? decodeName(pending.longName) : pending?.pax?.path ?? decodeName(nameBytes);
    if (pending?.pax?.size !== undefined) size = pending.pax.size;
    pending = null;

    if (type === '1') refuse(`${show(name)} is a hard link (tar type 1)`);
    if (type === '2') refuse(`${show(name)} is a symbolic link (tar type 2)`);
    if (type === '3') refuse(`${show(name)} is a character device (tar type 3)`);
    if (type === '4') refuse(`${show(name)} is a block device (tar type 4)`);
    if (type === '6') refuse(`${show(name)} is a FIFO (tar type 6)`);
    if (type !== '0' && type !== '\0' && type !== '5') {
      refuse(`${show(name)} has tar type ${JSON.stringify(type)}, which is not allowed: only regular files ("0") and folders ("5") are`);
    }
    if (entries.length + 1 > caps.maxEntries) refuse(`the archive has more than ${caps.maxEntries} entries`);
    if (body + size > data.length) refuse(`${show(name)} runs past the end of the archive (it is truncated)`);
    if (type === '5') {
      if (size !== 0) refuse(`${show(name)} is a folder with ${size} bytes of data`);
      entries.push({ name: name.endsWith('/') ? name.slice(0, -1) : name, kind: 'dir' });
    } else {
      total += size;
      if (total > caps.maxBytes) refuse(`the archive decompresses to more than ${bytesText(caps.maxBytes)}`);
      entries.push({ name, kind: 'file', data: new Uint8Array(data.subarray(body, body + size)) });
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  if (pending) refuse('the tar ends with a pax or GNU long-name header that has no entry after it');
  return entries;
}

/** @param {Buffer} zip @returns {number} the end record's offset */
function findEnd(zip) {
  // The end record is the last 22 bytes plus its comment; a signature inside the comment does not count.
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) return at;
  }
  return refuse('the zip has no end of central directory record at its end');
}

/**
 * Reads a zip by its central directory, checking each local header against it. It admits
 * stored and deflate entries that are regular files or folders, and refuses zip64, more than one
 * disk, encryption, overlapping data and any CRC or size mismatch.
 *
 * @param {Uint8Array} bytes
 * @param {Partial<Limits>} [limits]
 * @returns {Entry[]}
 */
export function readZip(bytes, limits) {
  const caps = withLimits(limits);
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const end = findEnd(zip);
  if (end >= 20 && zip.readUInt32LE(end - 20) === 0x07064b50) refuse('the zip is zip64 (it has a zip64 end locator)');
  const disk = zip.readUInt16LE(end + 4);
  const directoryDisk = zip.readUInt16LE(end + 6);
  const onDisk = zip.readUInt16LE(end + 8);
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if ([disk, directoryDisk, onDisk, count].includes(0xffff) || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    refuse('the zip is zip64 (its end record has a 0xFFFF or 0xFFFFFFFF field)');
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) refuse('the zip spans more than one disk');
  if (count > caps.maxEntries) refuse(`the archive has more than ${caps.maxEntries} entries`);
  if (directoryOffset + directorySize !== end) refuse("the zip's central directory is not where its end record says");

  /** @type {{ name: string, kind: 'file' | 'dir', method: number, crc: number, compressed: number, size: number, start: number, dataStart: number, end: number }[]} */
  const records = [];
  let listed = 0;
  let position = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || zip.readUInt32LE(position) !== 0x02014b50) refuse("the zip's central directory is malformed");
    const flags = zip.readUInt16LE(position + 8);
    const method = zip.readUInt16LE(position + 10);
    const crc = zip.readUInt32LE(position + 16);
    const compressed = zip.readUInt32LE(position + 20);
    const size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
    const diskStart = zip.readUInt16LE(position + 34);
    const mode = zip.readUInt32LE(position + 38) >>> 16;
    const local = zip.readUInt32LE(position + 42);
    if (next > end) refuse("the zip's central directory is malformed");
    const nameBytes = zip.subarray(position + 46, position + 46 + nameLength);
    // Every name is read as strict UTF-8, whatever bit 11 says: macOS Archive Utility writes UTF-8
    // without it, and this tool is the only reader, so no other tool sees a different name (Ruling 89).
    const rawName = decodeName(nameBytes);
    position = next;

    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff || diskStart === 0xffff) refuse(`${show(rawName)} is a zip64 entry (a 0xFFFF or 0xFFFFFFFF field)`);
    if (diskStart !== 0) refuse(`${show(rawName)} starts on another disk (${diskStart}): the zip spans more than one disk`);
    if (flags & (0x1 | 0x40 | 0x2000)) refuse(`${show(rawName)} is encrypted`);
    if (method !== 0 && method !== 8) refuse(`${show(rawName)} uses compression method ${method}: only stored (0) and deflate (8) are allowed`);
    const special = SPECIAL_MODES.get(mode & S_IFMT);
    if (special) refuse(`${show(rawName)} is ${special} (Unix mode ${mode.toString(8)})`);
    if (mode & S_IFMT && (mode & S_IFMT) !== S_IFREG && (mode & S_IFMT) !== S_IFDIR) refuse(`${show(rawName)} has an unknown Unix file type (mode ${mode.toString(8)})`);
    const isDir = rawName.endsWith('/');
    if ((mode & S_IFMT) === S_IFDIR && !isDir) refuse(`${show(rawName)} is a folder by its Unix mode but not by its name`);
    if ((mode & S_IFMT) === S_IFREG && isDir) refuse(`${show(rawName)} is a folder by its name but a regular file by its Unix mode`);

    if (local + 30 > directoryOffset || zip.readUInt32LE(local) !== 0x04034b50) refuse(`${show(rawName)} has no local header where the central directory says`);
    const localFlags = zip.readUInt16LE(local + 6);
    const localNameLength = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
    if (dataStart > directoryOffset || !zip.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) {
      refuse(`${show(rawName)}'s local header names it differently from the central directory`);
    }
    if (zip.readUInt16LE(local + 8) !== method || localFlags & (0x1 | 0x40 | 0x2000)) refuse(`${show(rawName)}'s local header disagrees with the central directory on its method or encryption`);
    const dataEnd = dataStart + compressed;
    if (dataEnd > directoryOffset) refuse(`${show(rawName)}'s data runs past the end of the archive's entries`);
    let spanEnd = dataEnd;
    const sizes = [zip.readUInt32LE(local + 14), zip.readUInt32LE(local + 18), zip.readUInt32LE(local + 22)];
    if (localFlags & 0x8) {
      // A data descriptor follows the data, with or without its signature.
      if (!sizes.every((value, i) => value === 0 || value === [crc, compressed, size][i])) refuse(`${show(rawName)}'s local header disagrees with the central directory on its CRC or sizes`);
      const signed = dataEnd + 4 <= directoryOffset && zip.readUInt32LE(dataEnd) === 0x08074b50;
      const at = signed ? dataEnd + 4 : dataEnd;
      spanEnd = at + 12;
      if (spanEnd > directoryOffset) refuse(`${show(rawName)}'s data descriptor runs past the end of the archive's entries`);
      if (zip.readUInt32LE(at) !== crc || zip.readUInt32LE(at + 4) !== compressed || zip.readUInt32LE(at + 8) !== size) {
        refuse(`${show(rawName)}'s data descriptor disagrees with the central directory`);
      }
    } else if (sizes[0] !== crc || sizes[1] !== compressed || sizes[2] !== size) {
      refuse(`${show(rawName)}'s local header disagrees with the central directory on its CRC or sizes`);
    }
    listed += size;
    if (listed > caps.maxBytes) refuse(`the archive decompresses to more than ${bytesText(caps.maxBytes)}`);
    records.push({ name: isDir ? rawName.slice(0, -1) : rawName, kind: isDir ? 'dir' : 'file', method, crc, compressed, size, start: local, dataStart, end: spanEnd });
  }
  if (position !== end) refuse("the zip's central directory has more records than its end record counts");

  const spans = [...records].sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const [before, after] = [spans[i - 1], spans[i]];
    if (before && after && after.start < before.end) refuse(`${show(after.name)} and ${show(before.name)} overlap in the archive`);
  }

  return records.map((record) => {
    const raw = zip.subarray(record.dataStart, record.dataStart + record.compressed);
    /** @type {Uint8Array} */
    let content = raw;
    if (record.method === 0 && record.compressed !== record.size) refuse(`${show(record.name)} is stored, but its listed sizes differ (${record.compressed} and ${record.size})`);
    if (record.method === 8) {
      try {
        // An entry may not inflate past its listed size, and the listed sizes are capped in total.
        content = inflateRawSync(raw, { maxOutputLength: Math.max(1, record.size) });
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ERR_BUFFER_TOO_LARGE') refuse(`${show(record.name)} inflates past its listed size of ${record.size} bytes`);
        refuse(`${show(record.name)}'s deflate data is corrupt (${errorText(error)})`);
      }
    }
    if (content.length !== record.size) refuse(`${show(record.name)} decompresses to ${content.length} bytes, not its listed size of ${record.size}`);
    if (crc32(content) >>> 0 !== record.crc) refuse(`${show(record.name)} fails its CRC check`);
    return record.kind === 'dir' ? { name: record.name, kind: record.kind } : { name: record.name, kind: record.kind, data: new Uint8Array(content) };
  });
}

// ---------------------------------------------------------------------------------------------
// A staging folder

/** @param {import('node:fs').Stats} stat */
const specialKind = (stat) =>
  stat.isFIFO() ? 'a FIFO' : stat.isSocket() ? 'a socket' : stat.isCharacterDevice() ? 'a character device' : stat.isBlockDevice() ? 'a block device' : 'a special file';

/**
 * Reads a whole regular file through an open handle, checking what it opened.
 *
 * @param {string} path
 * @param {number} flags extra open flags
 * @param {number} max
 * @param {string} what the name to report
 * @returns {Uint8Array}
 */
function readOpened(path, flags, max, what) {
  /** @type {number} */
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | flags);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ELOOP' || code === 'EMLINK') refuse(`${show(what)} is a symbolic link`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse(`${show(what)} is not a regular file`);
    if (stat.size > max) refuse(`${show(what)} is larger than ${bytesText(max)}`);
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > stat.size) refuse(`${show(what)} grew while it was being read`);
    }
    if (length !== stat.size) refuse(`${show(what)} changed while it was being read`);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads a staging folder: walked with lstat, so a symbolic link or a special file anywhere in it
 * refuses the bundle, and each file read with O_NOFOLLOW where the platform has it.
 *
 * @param {string} path
 * @param {Partial<Limits>} [limits]
 * @returns {Entry[]}
 */
export function readDir(path, limits) {
  const caps = withLimits(limits);
  /** @type {import('node:fs').Stats | undefined} */
  let rootStat;
  try {
    rootStat = lstatSync(path);
  } catch {
    rootStat = undefined;
  }
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) refuse(`${show(path)} is not a real folder (a directory, not a link)`);
  /** @type {Entry[]} */
  const entries = [];
  let total = 0;
  /** @param {string} dir @param {string} prefix */
  const walk = (dir, prefix) => {
    for (const raw of readdirSync(dir, { encoding: 'buffer' }).sort(Buffer.compare)) {
      const name = decodeName(raw);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entries.length + 1 > caps.maxEntries) refuse(`the folder has more than ${caps.maxEntries} entries`);
      if (relative.split('/').length > caps.maxDepth) refuse(`${show(relative)} is deeper than ${caps.maxDepth} segments`);
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) refuse(`${show(relative)} is a symbolic link`);
      if (stat.isDirectory()) {
        entries.push({ name: relative, kind: 'dir' });
        walk(full, relative);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) refuse(`${show(relative)} is a hard link (it has ${stat.nlink} names)`);
        total += stat.size;
        if (total > caps.maxBytes) refuse(`the folder holds more than ${bytesText(caps.maxBytes)}`);
        entries.push({ name: relative, kind: 'file', data: readOpened(full, constants.O_NOFOLLOW ?? 0, stat.size, relative) });
      } else {
        refuse(`${show(relative)} is ${specialKind(stat)}, not a regular file or a folder`);
      }
    }
  };
  walk(path, '');
  return entries;
}

// ---------------------------------------------------------------------------------------------
// The allow-list

/**
 * A relative path's segments, or a refusal: no absolute path, drive letter, backslash, `.` or
 * `..` or empty segment, control character, format or line-separator character (bidi overrides,
 * zero-width and tag characters), Windows device name, segment ending in a dot or a space,
 * character Windows forbids, or path over the depth and length caps.
 *
 * @param {string} name
 * @param {Partial<Limits>} [limits]
 * @returns {string[]}
 */
export function checkPath(name, limits) {
  const caps = withLimits(limits);
  if (name === '') refuse('an entry has an empty name');
  if (/\p{Cc}/u.test(name)) refuse(`${show(name)} has a NUL or other control character`);
  const invisible = name.match(/[\p{Cf}\p{Zl}\p{Zp}]/u);
  if (invisible) {
    refuse(`${show(name)} has a format or line-separator character (${codePoint(invisible[0])}), which can hide or reorder what a name shows`);
  }
  if (Buffer.byteLength(name) > caps.maxPathBytes) refuse(`${show(name)} is longer than ${caps.maxPathBytes} bytes`);
  if (name.includes('\\')) refuse(`${show(name)} has a backslash`);
  if (name.startsWith('/')) refuse(`${show(name)} is an absolute path`);
  if (/^[a-z]:/i.test(name)) refuse(`${show(name)} starts with a drive letter`);
  const segments = name.split('/');
  if (segments.length > caps.maxDepth) refuse(`${show(name)} is deeper than ${caps.maxDepth} segments`);
  for (const segment of segments) {
    if (segment === '') refuse(`${show(name)} has an empty segment`);
    if (segment === '.' || segment === '..') refuse(`${show(name)} has a "${segment}" segment`);
    if (/[<>:"|?*]/.test(segment)) refuse(`${show(name)} has a character Windows does not allow in a name (one of < > : " | ? *)`);
    if (WINDOWS_DEVICE.test(segment)) refuse(`${show(name)} has a segment Windows reserves for a device (${show(segment)})`);
    if (/[. ]$/.test(segment)) refuse(`${show(name)} has a segment that ends in a dot or a space`);
  }
  return segments;
}

/**
 * The bytes of a CSS name: ASCII letters and digits, `-`, `_`, `\` (an escape continues a name),
 * and every byte of a non-ASCII character.
 */
const NAME_BYTE = Uint8Array.from({ length: 256 }, (_, byte) => Number(byte >= 0x80 || /[\w\\-]/.test(String.fromCharCode(byte))));
/**
 * The bytes that continue `@plugin` or `@config` into a longer name: ASCII letters and digits, `-`,
 * `_` and `\`. Any other byte ends the name, a non-ASCII one too, because Tailwind 4.3.3's parser
 * cuts a name at an ASCII space, tab or `(` and then trims it with String.prototype.trim, which
 * strips U+00A0, U+3000, U+FEFF and other Unicode spaces (Ruling 97).
 */
const NAME_CONTINUES = Uint8Array.from({ length: 256 }, (_, byte) => Number(/[\w\\-]/.test(String.fromCharCode(byte))));
const [AT, SLASH, STAR, BACKSLASH] = [0x40, 0x2f, 0x2a, 0x5c];
/**
 * The at-rules that make a consumer import a module: Tailwind CSS 4's build (`@tailwindcss/node`)
 * and its editor language server load `@plugin`'s module and `@config`'s file as JavaScript. For
 * each, which letters of its name a byte is, ASCII case-insensitively, as bits.
 */
const DIRECTIVES = ['@plugin', '@config'].map((directive) => {
  const letters = directive.slice(1);
  const masks = Uint8Array.from({ length: 256 }, (_, byte) => {
    let mask = 0;
    for (let k = 0; k < letters.length; k++) if (letters.charCodeAt(k) === (byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte)) mask |= 1 << k;
    return mask;
  });
  return { directive, masks, all: (1 << letters.length) - 1, full: 1 << letters.length };
});

/**
 * The code-loading directive a file's raw bytes hold, or null. It reads the bytes as they are, with
 * no CSS parser, so no difference between parsers re-opens it:
 * - `@plugin` or `@config`, ASCII case-insensitively, followed by anything but an ASCII name
 *   character (NAME_CONTINUES), wherever it is: inside a comment or a string too;
 * - with any number of comments between the `@` and the name or inside it, since Tailwind's
 *   parser drops a comment from a name. A comment here is anything from a `/*` to any later `*\/`,
 *   so where a parser would end one does not matter;
 * - NUL bytes skipped, a margin only: both consumers read a file as UTF-8, so UTF-16 text loads
 *   nothing, and this does not claim to read UTF-16;
 * - in a stylesheet only, also an at-keyword spelled with a backslash escape (`@` and any name
 *   characters or comments, then `\`), whatever it decodes to. Elsewhere `@\` is ordinary text (a
 *   regular expression such as `/\S+@\S+/`), and in binary data it is common.
 * One pass, in time linear in the bytes: each name is matched by a small automaton, not a regular
 * expression that backtracks over comments.
 *
 * @param {Uint8Array} bytes
 * @param {{ stylesheet?: boolean }} [options]
 * @returns {'@plugin' | '@config' | 'an escaped at-keyword' | null}
 */
export function codeLoadingDirective(bytes, { stylesheet = false } = {}) {
  // Per directive, as bits by the number of letters matched: `ready`, right after the `@` and those
  // letters; `open`, after a `/` there; `inside`, in a comment opened there (it stays set, since a
  // comment may end at any later `*/`); `star`, in such a comment, after a `*`. The escape rule keeps
  // the same four states for an at-keyword's name, as booleans.
  const ready = new Uint8Array(DIRECTIVES.length);
  const open = new Uint8Array(DIRECTIVES.length);
  const inside = new Uint8Array(DIRECTIVES.length);
  const star = new Uint8Array(DIRECTIVES.length);
  let [atName, atOpen, atInside, atStar] = [false, false, false, false];
  for (let i = 0; i <= bytes.length; i++) {
    // -1 is the end, where a name that is complete is followed by nothing.
    const byte = i < bytes.length ? bytes[i] : -1;
    if (byte === 0) continue;
    for (let d = 0; d < DIRECTIVES.length; d++) {
      const { directive, masks, all, full } = DIRECTIVES[d];
      const r = ready[d];
      if (r & full && (byte === -1 || !NAME_CONTINUES[byte])) return /** @type {'@plugin' | '@config'} */ (directive);
      if (byte === -1) continue;
      const n = inside[d];
      ready[d] = ((r & masks[byte]) << 1) | (byte === SLASH ? star[d] : 0) | (byte === AT ? 1 : 0);
      inside[d] = n | (byte === STAR ? open[d] : 0);
      open[d] = byte === SLASH ? r & all : 0;
      star[d] = byte === STAR ? n : 0;
    }
    if (stylesheet && byte !== -1) {
      if (atName && byte === BACKSLASH) return 'an escaped at-keyword';
      [atName, atOpen, atInside, atStar] = [
        byte === AT || (atName && NAME_BYTE[byte] === 1) || (atStar && byte === SLASH),
        atName && byte === SLASH,
        atInside || (atOpen && byte === STAR),
        atInside && byte === STAR,
      ];
    }
  }
  return null;
}

/**
 * Why an entry that passed checkPath is not written, or null to write it: a segment that starts
 * with a dot, a segment that names agent instructions, a tool configuration or a package folder
 * (all compared folded), a segment with a character outside the allowed set, a file that is not a
 * design file type (its extension compared lower-cased), or a file whose bytes hold a directive
 * that loads code (codeLoadingDirective). Its bytes are read only when its name passes, but a file
 * must come with them: without its bytes it cannot be judged, so that throws rather than pass it.
 *
 * @param {string[]} segments
 * @param {'file' | 'dir'} kind
 * @param {Uint8Array} [data] a file's bytes, required for a file
 * @returns {string | null}
 */
export function omission(segments, kind, data) {
  if (kind === 'file' && !(data instanceof Uint8Array)) throw new TypeError(`omission() needs a file's bytes to judge ${show(segments.join('/'))}`);
  for (const segment of segments) {
    if (fold(segment).startsWith('.')) return `${show(segment)} starts with a dot: dotfiles and dot-folders (.git, .claude, .github and the like) are never written`;
  }
  for (const segment of segments) {
    const folded = fold(segment);
    if (INSTRUCTIONS.has(folded) || folded.endsWith('.mdc')) return `${show(segment)} names agent instructions, which are never written`;
    if (TOOL_CONFIG.test(folded)) {
      return `${show(segment)} is a tool configuration (*.config.js, package.json, tsconfig.json, tailwind.js, cspell.json, dprint.json and the like, which tools/design-ingest/README.md lists), which an editor or build tool may find and load, so it is never written`;
    }
    if (folded === PACKAGE_FOLDER) {
      return `${show(segment)} is a package folder: a tool that loads a package for a file looks in the nearest one first (the Tailwind CSS editor extension imports tailwindcss so), so it is never written`;
    }
  }
  for (const segment of segments) {
    if (!ALLOWED_NAME.test(segment)) {
      return `name has a character outside the allowed set (${ALLOWED_SET}): ${show(segment)} (and a name starts with a letter, a digit or _)`;
    }
  }
  if (kind === 'dir') return null;
  const last = segments[segments.length - 1] ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return 'it has no file extension, so it is not a design file type';
  const extension = last.slice(dot).toLowerCase();
  if (!DESIGN_TYPES.has(extension)) return `${show(extension)} is not a design file type`;
  const directive = codeLoadingDirective(/** @type {Uint8Array} */ (data), { stylesheet: extension === '.css' });
  if (directive === 'an escaped at-keyword') {
    return 'it holds an escaped at-keyword (an @-name spelled with a backslash escape, whatever it decodes to), which could spell a directive that loads code, such as @plugin or @config, so it is never written';
  }
  if (directive) {
    return `it holds ${JSON.stringify(directive)}, a Tailwind CSS directive that makes the build and the editor extension load and run a JavaScript module, so it is never written (in any letter case, with comments in it, followed by any character but an ASCII letter, digit, -, _ or \\, and in a comment or a string too, since a stylesheet's @import reads a file of any type)`;
  }
  return null;
}

/**
 * Checks every entry, and decides what to write. One leading `./` on a name is stripped first, and
 * a `.` root folder is skipped. Refuses a bad path, two names that are equal once folded
 * (NFKC, then lower-, upper- and lower-cased), a name that is both a file and a folder, more files
 * and folders (those a path implies included) than the cap, or nothing to write.
 *
 * @param {Entry[]} entries
 * @param {Partial<Limits>} [limits]
 * @returns {Plan}
 */
export function plan(entries, limits) {
  const caps = withLimits(limits);
  /** @type {Map<string, { path: string, kind: 'file' | 'dir', explicit: boolean }>} */
  const claimed = new Map();
  /** @param {string} path @param {'file' | 'dir'} kind @param {boolean} explicit */
  const claim = (path, kind, explicit) => {
    const key = fold(path);
    const prior = claimed.get(key);
    if (!prior) return void claimed.set(key, { path, kind, explicit });
    if (prior.path !== path) refuse(`${show(prior.path)} and ${show(path)} differ only in case or Unicode normalisation`);
    if (prior.kind !== kind) refuse(`${show(path)} is both a file and a folder`);
    if (explicit && prior.explicit) refuse(`${show(path)} appears twice`);
    prior.explicit ||= explicit;
  };
  const checked = entries.flatMap((entry) => {
    // `tar -C dir -czf x.tar.gz .` writes a "./" root and names every entry "./…": the root is
    // skipped (the readers have counted it), and one leading "./" is stripped before any check.
    if (entry.kind === 'dir' && entry.name === '.') return [];
    const name = entry.name.startsWith('./') ? entry.name.slice(2) : entry.name;
    const segments = checkPath(name, caps);
    for (let i = 1; i < segments.length; i++) claim(segments.slice(0, i).join('/'), 'dir', false);
    claim(name, entry.kind, true);
    return [{ ...entry, name, segments }];
  });

  /** @type {Plan['files']} */
  const files = [];
  /** @type {Plan['omitted']} */
  const omitted = [];
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const entry of checked) {
    const reason = omission(entry.segments, entry.kind, entry.data);
    if (reason) {
      omitted.push({ name: entry.name, reason });
      continue;
    }
    for (let i = 1; i < entry.segments.length; i++) dirs.add(entry.segments.slice(0, i).join('/'));
    if (entry.kind === 'dir') dirs.add(entry.name);
    else files.push({ path: entry.name, data: entry.data ?? new Uint8Array(0) });
  }
  const written = files.length + dirs.size;
  if (written > caps.maxEntries) refuse(`the bundle would write ${written} files and folders, more than ${caps.maxEntries}`);
  if (files.length === 0) refuse('the bundle has no design files to write');
  const depth = (/** @type {string} */ path) => path.split('/').length;
  return { dirs: [...dirs].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)), files, omitted };
}

// ---------------------------------------------------------------------------------------------
// Writing

const BUNDLE_EXISTS =
  "design/bundle already exists, so this site's design was ingested before, and the tool writes only a fresh one. A folder you extracted yourself belongs outside the repository, in your Downloads folder for example, and its path goes to --dir";

/** The repository this tool belongs to: the folder that holds tools/design-ingest/. */
const TOOL_REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Refuses a --dir folder inside the repository, before anything in it is read (Ruling 99). Raw
 * design files never sit in the repository: editor extensions that scan the workspace can run code
 * from them (Tailwind CSS IntelliSense imports the `tailwindcss` nearest each stylesheet when it
 * starts), and this tool checks only what it writes. The repository is the folder holding
 * tools/design-ingest/ and the folder design/bundle/ is written under (`cwd`), one folder in a
 * site. The folder is inside if its path, as typed or as realpath gives it, is at or below either of
 * theirs, as typed or real. Paths are compared folded, since Windows, macOS and WSL's Windows drives
 * ignore case. A folder that does not exist is left to readDir to refuse.
 *
 * @param {string} given the --dir argument, as typed
 * @param {string} dir that argument resolved against `cwd`
 * @param {string} cwd
 */
function refuseInsideRepository(given, dir, cwd) {
  /** @param {string} path @returns {string[]} */
  const both = (path) => {
    try {
      return [resolve(path), realpathSync.native(path)];
    } catch {
      return [resolve(path)];
    }
  };
  const roots = [...both(TOOL_REPOSITORY), ...both(cwd)];
  for (const path of both(dir)) {
    for (const root of roots) {
      const rest = relative(fold(root), fold(path));
      if (rest === '' || !(rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest))) {
        refuse(
          `${show(given)} is inside the repository (${show(root)}), and the tool reads a folder only from outside it: editor extensions that scan the workspace (Tailwind CSS IntelliSense) can run code from raw design files there, and the tool checks only what it writes. Extract or save the folder outside the repository instead, in your Downloads folder or a new temporary folder for example, run again with --dir and that folder's path, and delete the folder after ingest`,
        );
      }
    }
  }
}

/** @param {string} path */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} design the design/ folder */
function checkDesign(design) {
  /** @type {import('node:fs').Stats | undefined} */
  let stat;
  try {
    stat = lstatSync(design);
  } catch {
    stat = undefined;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) refuse('design is not a real folder (a directory, not a link): run this from the repository root');
  if (present(join(design, 'bundle'))) refuse(BUNDLE_EXISTS);
}

/**
 * Writes a checked plan into a fresh design/bundle/: folders one at a time, files with
 * `wx` and 0644. No mode or owner comes from the archive.
 *
 * @param {string} design the design/ folder
 * @param {Plan} bundle
 */
export function writeBundle(design, bundle) {
  checkDesign(design);
  const root = join(design, 'bundle');
  try {
    mkdirSync(root, { mode: 0o755 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') refuse(BUNDLE_EXISTS);
    throw error;
  }
  let written = 0;
  try {
    for (const dir of bundle.dirs) mkdirSync(join(root, ...dir.split('/')), { mode: 0o755 });
    for (const file of bundle.files) {
      writeFileSync(join(root, ...file.path.split('/')), file.data, { flag: 'wx', mode: 0o644 });
      written++;
    }
  } catch (error) {
    throw new Error(
      `writing design/bundle/ failed after ${written} of ${bundle.files.length} files (${errorText(error)}), so it is incomplete: ask the person to remove it before trying again`,
    );
  }
}

/**
 * Reads exactly one input, checks it, and writes design/bundle/ under `cwd`.
 *
 * @param {{ source?: boolean, host?: string, archive?: string, dir?: string }} input
 * @param {{ cwd?: string, fetch?: Fetch, limits?: Partial<Limits> }} [deps]
 * @returns {Promise<Summary>}
 */
export async function ingest(input, deps = {}) {
  const caps = withLimits(deps.limits);
  const given = [input.source === true, input.archive !== undefined, input.dir !== undefined].filter(Boolean).length;
  if (given !== 1) throw new UsageError('give exactly one of --source, --archive <path> or --dir <path>');
  if (input.host !== undefined && input.source !== true) throw new UsageError('--host goes with --source');
  const cwd = deps.cwd ?? process.cwd();
  const design = resolve(cwd, 'design');
  checkDesign(design);
  /** @type {Entry[]} */
  let entries;
  /** @type {string} */
  let from;
  if (input.source) {
    const source = join(design, 'SOURCE.md');
    if (!present(source)) refuse('there is no design/SOURCE.md to read the handoff URL from');
    const text = Buffer.from(readOpened(source, 0, 65536, 'design/SOURCE.md')).toString('utf8');
    const url = sourceUrl(text, { host: input.host });
    entries = readArchive(await download(url, { ...caps, fetch: deps.fetch }), caps);
    from = `the handoff URL on ${url.hostname}`;
  } else if (input.archive !== undefined) {
    const path = resolve(cwd, input.archive);
    if (!present(path)) refuse(`there is no file at ${show(input.archive)}`);
    if (!statSync(path).isFile()) refuse(`${show(input.archive)} is not a regular file`);
    entries = readArchive(readOpened(path, 0, caps.maxArchiveBytes, input.archive), caps);
    from = show(input.archive);
  } else {
    const dir = /** @type {string} */ (input.dir);
    refuseInsideRepository(dir, resolve(cwd, dir), cwd);
    entries = readDir(resolve(cwd, dir), caps);
    from = show(dir);
  }
  const bundle = plan(entries, caps);
  writeBundle(design, bundle);
  return {
    from,
    dirs: bundle.dirs,
    files: bundle.files.map((file) => file.path),
    bytes: bundle.files.reduce((total, file) => total + file.data.length, 0),
    omitted: bundle.omitted,
  };
}

/**
 * What was written, and each omitted entry with its reason.
 *
 * @param {Summary} summary
 * @returns {string}
 */
export function formatSummary({ from, dirs, files, bytes, omitted }) {
  const lines = [`design-ingest: wrote design/bundle/ from ${from}: ${plural(files.length, 'file')} (${bytes} bytes) in ${plural(dirs.length, 'folder')}.`];
  for (const file of files) lines.push(`  ${file}`);
  if (omitted.length === 0) lines.push('design-ingest: omitted nothing.');
  else {
    lines.push(`design-ingest: omitted ${plural(omitted.length, 'entry', 'entries')}, which ${omitted.length === 1 ? 'was' : 'were'} not written:`);
    for (const { name, reason } of omitted) lines.push(`  ${show(name)}: ${reason}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The command line

const USAGE = 'usage: node tools/design-ingest/ingest.mjs --source [--host <name>] | --archive <path> | --dir <path>';


/** @param {string[]} argv */
async function main(argv) {
  /** @type {{ source?: boolean, host?: string, archive?: string, dir?: string }} */
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { source: { type: 'boolean' }, host: { type: 'string' }, archive: { type: 'string' }, dir: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(errorText(error));
  }
  // ingest() checks that exactly one input is given, and throws a UsageError if not.
  console.log(formatSummary(await ingest({ source: values.source, host: values.host, archive: values.archive, dir: values.dir })));
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

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof UsageError) {
      console.error(`design-ingest: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else if (error instanceof Refusal) {
      console.error(`design-ingest: refused, and wrote nothing: ${error.message}`);
      process.exitCode = 1;
    } else {
      console.error(`design-ingest: failed: ${errorText(error)}`);
      process.exitCode = 1;
    }
  });
}
