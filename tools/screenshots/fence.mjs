import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The design screen is untrusted: it may load only files inside its bundle directory, decided by
 * resolved path, with symlinks followed on both sides. Every other URL is refused, whatever its
 * scheme (https:, http:, ws:, data:, blob: and the rest), so the screen reaches no network.
 *
 * @param {string} url the request URL
 * @param {string} bundleDir the bundle directory holding the design screen
 * @returns {boolean}
 */
export function allowedForDesign(url, bundleDir) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // A file: URL with a host is a UNC path on Windows: resolving it would reach another machine.
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
  // URL parsing has already resolved "." and ".." segments, percent-encoded or not.
  let path;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return false;
  }
  if (path.includes('\0')) return false;
  const file = realPath(path);
  const bundle = realPath(bundleDir);
  if (file === undefined || bundle === undefined) return false;
  const relation = relative(bundle, file);
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/**
 * The path with every symlink resolved. A path that does not exist yet resolves through its
 * nearest existing ancestor, so a missing file under a link to elsewhere counts as elsewhere. An
 * entry that exists but cannot be resolved (a dangling or looping link) gives undefined.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
function realPath(path) {
  const rest = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {
      if (exists(head)) return undefined;
      const parent = dirname(head);
      if (parent === head) return undefined;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

/** @param {string} path */
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
