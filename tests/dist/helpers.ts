import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type HTMLElement } from 'node-html-parser';

export const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/ is missing: run `npm run build` before `npm run test:dist`.');
}

export interface Page {
  /** Path inside dist/, e.g. "privacy/index.html". */
  file: string;
  /** The URL path it serves, e.g. "/privacy/". */
  route: string;
  html: string;
  root: HTMLElement;
}

export const distFile = (path: string): string => join(DIST, path);
export const readDist = (path: string): string => readFileSync(distFile(path), 'utf8');

export function allFiles(extension: string): string[] {
  return readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => relative(DIST, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

export function pages(): Page[] {
  return allFiles('.html').map((file) => {
    const html = readDist(file);
    const route = `/${file.replace(/index\.html$/, '').replace(/\.html$/, '')}`;
    return { file, route, html, root: parse(html, { comment: false }) };
  });
}
