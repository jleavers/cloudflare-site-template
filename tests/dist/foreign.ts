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

// The HTML tokeniser's whitespace inside a tag: tab, LF, FF and space, with CR (it becomes LF first).
const TAG_SPACE = /[\t\n\f\r ]/;

/**
 * A start tag's attribute names, in order and with repeats, as the HTML tokeniser reads them from
 * the raw text after the tag name (node-html-parser's `rawAttrs`): each name runs to whitespace,
 * `/`, `>` or `=`, with its ASCII capitals folded, and each value, quoted or not, is skipped.
 * A browser keeps the first of a repeated name and drops the rest, while node-html-parser's
 * `attributes` keeps both spellings of a name in different case and only the first of an exact
 * repeat, so neither shows what a check of "the" value would have to see.
 */
export function attributeNames(raw: string): string[] {
  const names: string[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < raw.length && TAG_SPACE.test(raw[i]!)) i++;
  };
  while (i < raw.length) {
    skipSpace();
    if (i >= raw.length) break;
    if (raw[i] === '/' || raw[i] === '>') {
      i++;
      continue;
    }
    // A name may start with "=" (a parse error that the tokeniser keeps in the name).
    const start = i++;
    while (i < raw.length && !TAG_SPACE.test(raw[i]!) && !'/>='.includes(raw[i]!)) i++;
    names.push(raw.slice(start, i).replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
    skipSpace();
    if (raw[i] !== '=') continue;
    i++;
    skipSpace();
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, i + 1);
      i = end === -1 ? raw.length : end + 1;
    } else {
      while (i < raw.length && !TAG_SPACE.test(raw[i]!) && raw[i] !== '>') i++;
    }
  }
  return names;
}

/** The names that occur more than once in a start tag's raw attributes, each named once. */
export function repeatedAttributes(raw: string): string[] {
  const names = attributeNames(raw);
  return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
}

const SIMPLE = new Set(['src', 'poster', 'data', 'action', 'formaction', 'background', 'manifest', 'xlink:href']);
const NAVIGATES = new Set(['a', 'area']);

function htmlReferences(html: string): { references: Reference[]; repeated: string[] } {
  // noscript is parsed as markup (the default keeps it as text), so nothing in it is hidden.
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } });
  const references: Reference[] = [];
  const repeated: string[] = [];
  for (const element of root.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    // Refused outright, whatever the name: which copy a check reads is not the question.
    for (const name of repeatedAttributes(element.rawAttrs)) repeated.push(`<${tag}> repeats the attribute "${name}", and a browser keeps only the first`);
    // .attributes keeps the author's spelling of each name and decodes entities in the value.
    // Every entry is checked: the list is never collapsed by name.
    const attributes = Object.entries(element.attributes).map(([name, value]) => [name.trim().toLowerCase(), value] as const);
    const get = (name: string) => attributes.find(([key]) => key === name)?.[1];
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
    if (tag === 'meta' && get('http-equiv')?.trim().toLowerCase() === 'refresh') {
      const target = /url\s*=\s*['"]?([^'";]*)/i.exec(get('content') ?? '');
      if (target) add('content', target[1]!);
    }
    if (tag === 'style') for (const url of cssUrls(element.text)) references.push({ element: tag, attribute: 'text', url, image: true, script: false });
  }
  return { references, repeated };
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

/** Violations in one built page: one message per repeated attribute name, and one per refused reference. */
export function foreignInHtml(html: string, options: Options): string[] {
  const { references, repeated } = htmlReferences(html);
  return [...repeated.map((problem) => `${options.page}: ${problem}`), ...violations(references, options, options.page)];
}

/** Violations in one stylesheet: every url() and @import. */
export function foreignInCss(css: string, options: Options): string[] {
  const references = cssUrls(css).map((url) => ({ element: 'css', attribute: 'url', url, image: true, script: false }));
  return violations(references, options, options.file ?? options.page);
}
