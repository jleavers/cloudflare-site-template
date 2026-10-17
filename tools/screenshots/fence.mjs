import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The design screen is untrusted: it may only fetch from the public internet (https:) or from
 * files in its own directory and below.
 *
 * @param {string} url the request URL
 * @param {string} designDir the absolute directory holding the design screen
 * @returns {boolean}
 */
export function allowedForDesign(url, designDir) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') {
    // URL parsing has already resolved "." and ".." segments, percent-encoded or not.
    let path;
    try {
      path = fileURLToPath(parsed);
    } catch {
      return false;
    }
    const relation = relative(designDir, path);
    return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:')) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}
