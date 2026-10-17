import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { allowedForDesign } from '../../tools/screenshots/fence.mjs';

const designDir = resolve('/work/design/screen');
const inside = (path: string) => `${pathToFileURL(designDir).href}/${path}`;

describe('the design screenshot request fence', () => {
  test.each([
    ['the design file itself', inside('index.html')],
    ['a file in a subdirectory', inside('assets/fonts/a.woff2')],
    ['a file with a query', `${inside('index.html')}?v=1`],
    ['a public https host', 'https://fonts.googleapis.com/css2?family=Inter'],
    ['a public https IPv4 address', 'https://93.184.216.34/x'],
  ])('allows %s', (_name, url) => expect(allowedForDesign(url, designDir)).toBe(true));

  test.each([
    ['another local file', 'file:///etc/passwd'],
    ['a sibling directory', pathToFileURL(resolve('/work/design/other/secret.txt')).href],
    ['a directory with the same prefix', pathToFileURL(resolve('/work/design/screen-private/a.txt')).href],
    ['a file that climbs out with ../', inside('../../../etc/passwd')],
    ['a file that climbs out, percent-encoded', inside('%2e%2e/%2e%2e/%2e%2e/etc/passwd')],
    ['a file that climbs out, encoded slashes', inside('..%2f..%2fetc/passwd')],
    ['http', 'http://example.org/'],
    ['localhost', 'https://localhost/'],
    ['a loopback address', 'https://127.0.0.1/'],
    ['a private address', 'https://10.0.0.1/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['a link-local address', 'https://169.254.169.254/'],
    ['ws', 'ws://example.org/'],
    ['a malformed URL', 'not a url'],
  ])('refuses %s', (_name, url) => expect(allowedForDesign(url, designDir)).toBe(false));
});
