import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { allowedForDesign } from '../../tools/screenshots/fence.mjs';

const designDir = resolve('/work/design/screen');
const inside = (path: string) => `${pathToFileURL(designDir).href}/${path}`;

describe('the design screenshot request fence', () => {
  test.each([
    ['the design file itself', inside('index.html')],
    ['a file in a subdirectory', inside('assets/fonts/a.woff2')],
    ['a file with a query', `${inside('index.html')}?v=1`],
    ['a file that climbs out and back in', inside('assets/../index.html')],
  ])('allows %s', (_name, url) => expect(allowedForDesign(url, designDir)).toBe(true));

  test.each([
    ['another local file', 'file:///etc/passwd'],
    ['a sibling directory', pathToFileURL(resolve('/work/design/other/secret.txt')).href],
    ['a directory with the same prefix', pathToFileURL(resolve('/work/design/screen-private/a.txt')).href],
    ['the directory above', pathToFileURL(resolve('/work/design')).href],
    ['a file that climbs out with ../', inside('../../../etc/passwd')],
    ['a file that climbs out, percent-encoded', inside('%2e%2e/%2e%2e/%2e%2e/etc/passwd')],
    ['a file that climbs out, encoded slashes', inside('..%2f..%2fetc/passwd')],
    ['a file on another host (a UNC path on Windows)', 'file://fileserver/share/a.txt'],
    // The screen reaches no network at all. A public https host was allowed until the sweep's
    // cluster 2 (Ruling 85); refusing it now is the intended change, not a regression.
    ['a public https host', 'https://fonts.googleapis.com/css2?family=Inter'],
    ['a public https IPv4 address', 'https://93.184.216.34/x'],
    // The hosts the sweep's refuters showed a host-string deny-list let through.
    ['a CGNAT or tailnet address', 'https://100.64.0.1/'],
    ['a single-label intranet name', 'https://intranet/'],
    ['a .lan name', 'https://router.lan/'],
    ['a public name that resolves to a private address', 'https://10.0.0.1.nip.io/'],
    ['an .internal name', 'https://wiki.corp.internal/'],
    ['http', 'http://example.org/'],
    ['localhost', 'https://localhost/'],
    ['a loopback address', 'https://127.0.0.1/'],
    ['a private address', 'https://10.0.0.1/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['a link-local address', 'https://169.254.169.254/'],
    ['ws', 'ws://example.org/'],
    ['wss', 'wss://example.org/'],
    ['ftp', 'ftp://example.org/a.txt'],
    // Chromium never asks route() about these (tests/e2e/design-fence.spec.ts); refused anyway.
    ['a data: URL', 'data:text/html,<p>hi</p>'],
    ['a blob: URL', 'blob:null/0b6a33a2-6a51-4b5e-9a3e-2b1c3f0c9d11'],
    ['javascript:', 'javascript:alert(1)'],
    ['a malformed URL', 'not a url'],
  ])('refuses %s', (_name, url) => expect(allowedForDesign(url, designDir)).toBe(false));
});

// A real directory, so that paths resolve. The ingest tool refuses links, so this is defence in depth.
const root = mkdtempSync(join(tmpdir(), 'fence-'));
const bundle = join(root, 'bundle');
const outside = join(root, 'outside');
mkdirSync(join(bundle, 'project'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(bundle, 'project', 'screen.html'), '<p>screen</p>');
writeFileSync(join(outside, 'secret.txt'), 'fake-probe-value');

const canLink = (() => {
  try {
    symlinkSync(join(outside, 'secret.txt'), join(bundle, 'file-link'), 'file');
    symlinkSync(outside, join(bundle, 'dir-link'), 'junction');
    symlinkSync(join(outside, 'gone.txt'), join(bundle, 'dangling-link'), 'file');
    symlinkSync(bundle, join(root, 'bundle-link'), 'junction');
    return true;
  } catch {
    return false;
  }
})();
const fileUrl = (...parts: string[]) => pathToFileURL(join(...parts)).href;

// Removes exactly what this file made: the links themselves, never what they point to.
afterAll(() => {
  for (const link of [join(bundle, 'file-link'), join(bundle, 'dir-link'), join(bundle, 'dangling-link'), join(root, 'bundle-link')]) {
    try {
      unlinkSync(link);
    } catch {
      rmdirSyncQuietly(link); // a Windows junction
    }
  }
  unlinkSync(join(bundle, 'project', 'screen.html'));
  unlinkSync(join(outside, 'secret.txt'));
  for (const dir of [join(bundle, 'project'), bundle, outside, root]) rmdirSync(dir);
});
function rmdirSyncQuietly(path: string) {
  try {
    rmdirSync(path);
  } catch {
    // never made
  }
}

describe.skipIf(!canLink)('the fence resolves symlinks', () => {
  test.each([
    ['a file link to a file outside', fileUrl(bundle, 'file-link')],
    ['a file under a directory link to outside', fileUrl(bundle, 'dir-link', 'secret.txt')],
    ['a missing file under a directory link to outside', fileUrl(bundle, 'dir-link', 'not-yet.txt')],
    ['a link that points nowhere', fileUrl(bundle, 'dangling-link')],
  ])('refuses %s', (_name, url) => expect(allowedForDesign(url, bundle)).toBe(false));

  test('allows the bundle\'s own files when the bundle is named through a link', () => {
    expect(allowedForDesign(fileUrl(bundle, 'project', 'screen.html'), join(root, 'bundle-link'))).toBe(true);
    expect(allowedForDesign(fileUrl(root, 'bundle-link', 'project', 'screen.html'), bundle)).toBe(true);
    expect(allowedForDesign(fileUrl(root, 'bundle-link', 'dir-link', 'secret.txt'), bundle)).toBe(false);
  });
});

test('a real file inside the bundle is allowed, and one outside it is not', () => {
  expect(allowedForDesign(fileUrl(bundle, 'project', 'screen.html'), bundle)).toBe(true);
  expect(allowedForDesign(fileUrl(bundle, 'project', 'missing.css'), bundle)).toBe(true);
  expect(allowedForDesign(fileUrl(outside, 'secret.txt'), bundle)).toBe(false);
});
