import { parse } from 'node-html-parser';

/**
 * Contract C2/C3 as an allow-list: every reference in a built page or stylesheet that can make a
 * browser fetch or connect is resolved against the page's URL, and its origin must be the site's
 * (or one of the few third parties the CSP in public/_headers allows). Pure, so it can be unit
 * tested on strings; tests/dist/assets.test.ts applies it to dist/.
 */
export interface Options {
  /** The page's absolute URL: site.url plus its route. */
  page: string;
  /** site.url. */
  siteUrl: string;
  /** site.analytics.cloudflareToken; the analytics beacon is allowed only when it is set. */
  analyticsToken?: string;
  /** A name for CSS files, which have no element. */
  file?: string;
}

interface Reference {
  element: string;
  attribute: string;
  url: string;
  /** An image place: a data: URL is allowed here (img-src 'self' data:). */
  image: boolean;
  /** A script src: Turnstile and the beacon are allowed here and nowhere else. */
  script: boolean;
}

const URL_FUNCTION = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi;
const IMPORT_STRING = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

function cssUrls(css: string): string[] {
  const urls: string[] = [];
  for (const match of css.matchAll(URL_FUNCTION)) urls.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
  for (const match of css.matchAll(IMPORT_STRING)) urls.push((match[1] ?? match[2] ?? '').trim());
  return urls;
}

/** Every candidate URL of a srcset, following the HTML parsing rules: a URL is a run of non-space characters. */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i]!)) i++;
    let start = i;
    while (i < value.length && !/\s/.test(value[i]!)) i++;
    let url = value.slice(start, i);
    if (!url) break;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else while (i < value.length && value[i] !== ',') i++; // descriptors
    urls.push(url);
  }
  return urls;
}

const SIMPLE = new Set(['src', 'poster', 'data', 'action', 'formaction', 'background', 'manifest', 'xlink:href']);
const NAVIGATES = new Set(['a', 'area']);

function htmlReferences(html: string): Reference[] {
  // noscript is parsed as markup (the default keeps it as text), so nothing in it is hidden.
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } });
  const references: Reference[] = [];
  for (const element of root.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    // .attributes keeps the author's spelling of each name and decodes entities in the value.
    const attributes = new Map(Object.entries(element.attributes).map(([name, value]) => [name.trim().toLowerCase(), value]));
    const add = (attribute: string, url: string) =>
      references.push({
        element: tag,
        attribute,
        url: url.trim(),
        image: tag === 'img' && (attribute === 'src' || attribute === 'srcset'),
        script: tag === 'script' && attribute === 'src',
      });
    for (const [name, value] of attributes) {
      if (SIMPLE.has(name) || (name === 'href' && !NAVIGATES.has(tag))) add(name, value);
      else if (name === 'srcset' || name === 'imagesrcset') for (const url of srcsetUrls(value)) add(name, url);
      else if (name === 'ping') for (const url of value.split(/\s+/).filter(Boolean)) add(name, url);
      else if (name === 'style') for (const url of cssUrls(value)) references.push({ element: tag, attribute: 'style', url, image: true, script: false });
    }
    if (tag === 'meta' && attributes.get('http-equiv')?.trim().toLowerCase() === 'refresh') {
      const target = /url\s*=\s*['"]?([^'";]*)/i.exec(attributes.get('content') ?? '');
      if (target) add('content', target[1]!);
    }
    if (tag === 'style') for (const url of cssUrls(element.text)) references.push({ element: tag, attribute: 'text', url, image: true, script: false });
  }
  return references;
}

function violations(references: Reference[], options: Options, where: string): string[] {
  const site = new URL(options.siteUrl);
  const problems: string[] = [];
  for (const reference of references) {
    let url: URL;
    try {
      url = new URL(reference.url, options.page);
    } catch {
      problems.push(`${where}: <${reference.element}> ${reference.attribute}="${reference.url}" is not a URL`);
      continue;
    }
    const allowed =
      url.origin === site.origin ||
      (url.protocol === 'data:' && reference.image) ||
      (reference.script && url.origin === 'https://challenges.cloudflare.com') ||
      (reference.script && url.origin === 'https://static.cloudflareinsights.com' && Boolean(options.analyticsToken));
    if (!allowed) problems.push(`${where}: <${reference.element}> ${reference.attribute}="${reference.url}" reaches ${url.origin}`);
  }
  return problems;
}

/** Violations in one built page: one message per refused reference. */
export function foreignInHtml(html: string, options: Options): string[] {
  return violations(htmlReferences(html), options, options.page);
}

/** Violations in one stylesheet: every url() and @import. */
export function foreignInCss(css: string, options: Options): string[] {
  const references = cssUrls(css).map((url) => ({ element: 'css', attribute: 'url', url, image: true, script: false }));
  return violations(references, options, options.file ?? options.page);
}
