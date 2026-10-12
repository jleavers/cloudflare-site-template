import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { distFile, pages } from './helpers';

const all = pages();
const byRoute = new Map(all.map((page) => [page.route, page]));

function fileFor(pathname: string): string | null {
  const candidates = pathname.endsWith('/') ? [`${pathname}index.html`] : [pathname, `${pathname}/index.html`, `${pathname}.html`];
  return candidates.map((candidate) => candidate.slice(1)).find((candidate) => existsSync(distFile(candidate))) ?? null;
}

describe.each(all.map((page) => [page.route, page] as const))('links on %s', (_route, page) => {
  test('every internal link and fragment resolves', () => {
    for (const anchor of page.root.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') ?? '';
      if (/^(https?:|mailto:|tel:)/.test(href)) continue;
      const url = new URL(href, `https://site.invalid${page.route}`);
      const target = url.pathname === page.route ? page : byRoute.get(url.pathname);
      if (!target) {
        expect(fileFor(url.pathname), `${href} has no file in dist/`).not.toBeNull();
        continue;
      }
      if (url.hash) expect(target.root.querySelector(`[id="${url.hash.slice(1)}"]`), `${href} has no #${url.hash.slice(1)}`).not.toBeNull();
    }
  });
});
