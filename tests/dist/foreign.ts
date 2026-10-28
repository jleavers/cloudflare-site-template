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

type CssToken =
  | { type: 'function' | 'at-keyword'; name: string }
  | { type: 'string' | 'url'; value: string }
  | { type: '(' | ')' | 'whitespace' | 'other' };

const REPLACEMENT = String.fromCodePoint(0xfffd);
const NUL = String.fromCodePoint(0);
const isCssSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n';
const isNameStart = (char: string | undefined) => char !== undefined && (/[A-Za-z_]/.test(char) || char.charCodeAt(0) >= 0x80);
const isNameChar = (char: string | undefined) => isNameStart(char) || (char !== undefined && /[0-9-]/.test(char));
const isNonPrintable = (char: string) => {
  const code = char.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
};
/** ASCII letters only, as HTML and CSS fold names; tests/dist/headers.ts uses it too. */
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The tokens of a stylesheet that can name a URL, read as CSS Syntax 3 section 4 reads them.
 * Escapes (a backslash, then 1 to 6 hex digits and one optional whitespace, or any other
 * character) are decoded inside names, strings and unquoted url()s, so `\75 rl(` is `url(`, and
 * an escaped quote or parenthesis stays part of its value, as it does in a browser. Comments go;
 * numbers, hashes and delimiters are "other". For the text it is given, that can only add a match,
 * never hide one; which text a browser parses is the caller's to give it (an HTML <style> both as
 * written and entity-decoded, since its element decides).
 */
function cssTokens(source: string): CssToken[] {
  // CSS Syntax 3 section 3.3: CR, FF and CRLF become LF, and NUL becomes U+FFFD.
  const css = source.replace(/\r\n?|\f/g, '\n').replaceAll(NUL, REPLACEMENT);
  const tokens: CssToken[] = [];
  let i = 0;
  const validEscape = (at: number) => css[at] === '\\' && css[at + 1] !== '\n';
  const startsName = (at: number) =>
    css[at] === '-' ? isNameStart(css[at + 1]) || css[at + 1] === '-' || validEscape(at + 1) : isNameStart(css[at]) || validEscape(at);
  // After the backslash.
  const escaped = (): string => {
    const hex = /^[0-9A-Fa-f]{1,6}/.exec(css.slice(i, i + 6));
    if (hex) {
      i += hex[0].length;
      if (isCssSpace(css[i])) i++;
      const code = parseInt(hex[0], 16);
      return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? REPLACEMENT : String.fromCodePoint(code);
    }
    if (i >= css.length) return REPLACEMENT;
    const char = String.fromCodePoint(css.codePointAt(i)!);
    i += char.length;
    return char;
  };
  const name = (): string => {
    let out = '';
    for (;;) {
      if (isNameChar(css[i])) out += css[i++];
      else if (validEscape(i)) {
        i++;
        out += escaped();
      } else return out;
    }
  };
  // After the opening quote. A raw newline makes a bad string, which names nothing.
  const string = (quote: string): CssToken => {
    let out = '';
    for (;;) {
      const char = css[i];
      if (char === undefined) return { type: 'string', value: out };
      if (char === quote) {
        i++;
        return { type: 'string', value: out };
      }
      if (char === '\n') return { type: 'other' };
      if (char === '\\') {
        i++;
        if (css[i] === '\n') i++;
        else if (i < css.length) out += escaped();
      } else {
        out += char;
        i++;
      }
    }
  };
  // The rest of a bad url, which names nothing.
  const badUrl = (): CssToken => {
    while (i < css.length && css[i] !== ')') {
      if (validEscape(i)) {
        i++;
        escaped();
      } else i++;
    }
    i++;
    return { type: 'other' };
  };
  // After `url(` and its whitespace, when no quote follows.
  const url = (): CssToken => {
    let out = '';
    for (;;) {
      const char = css[i];
      if (char === undefined) return { type: 'url', value: out };
      if (char === ')') {
        i++;
        return { type: 'url', value: out };
      }
      if (isCssSpace(char)) {
        while (isCssSpace(css[i])) i++;
        if (css[i] === undefined || css[i] === ')') {
          i++;
          return { type: 'url', value: out };
        }
        return badUrl();
      }
      if (char === '"' || char === "'" || char === '(' || isNonPrintable(char)) return badUrl();
      if (char === '\\') {
        if (!validEscape(i)) return badUrl();
        i++;
        out += escaped();
      } else {
        out += char;
        i++;
      }
    }
  };
  while (i < css.length) {
    const char = css[i]!;
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else if (isCssSpace(char)) {
      while (isCssSpace(css[i])) i++;
      tokens.push({ type: 'whitespace' });
    } else if (char === '"' || char === "'") {
      i++;
      tokens.push(string(char));
    } else if (char === '(' || char === ')') {
      i++;
      tokens.push({ type: char });
    } else if (char === '@' && startsName(i + 1)) {
      i++;
      tokens.push({ type: 'at-keyword', name: name() });
    } else if (startsName(i)) {
      const ident = name();
      if (css[i] !== '(') {
        tokens.push({ type: 'other' });
        continue;
      }
      i++;
      let next = i;
      while (isCssSpace(css[next])) next++;
      // url( with a quote after it is a function like any other; without one, an unquoted url.
      if (asciiLower(ident) !== 'url' || css[next] === '"' || css[next] === "'") tokens.push({ type: 'function', name: ident });
      else {
        i = next;
        tokens.push(url());
      }
    } else {
      i++;
      tokens.push({ type: 'other' });
    }
  }
  return tokens;
}

const STRING_URL_FUNCTIONS = new Set(['url', 'src']);
const IMAGE_SETS = new Set(['image-set', '-webkit-image-set']);

/**
 * Every URL a stylesheet can make a browser fetch: url(), quoted or not; src(); @import's
 * string; and image-set()'s and -webkit-image-set()'s own string options (not type()'s), whose
 * url()s are found as url()s. This is the early, named error. The built CSP is the backstop for
 * any form this still misses (tests/dist/headers.ts): img-src, font-src and style-src allow
 * nothing but the site and data: images.
 */
export function cssUrls(css: string): string[] {
  const tokens = cssTokens(css);
  const urls: string[] = [];
  const stringAfter = (at: number) => {
    let next = at + 1;
    while (tokens[next]?.type === 'whitespace') next++;
    const token = tokens[next];
    return token?.type === 'string' ? token.value : undefined;
  };
  tokens.forEach((token, at) => {
    if (token.type === 'url') urls.push(token.value);
    if (token.type !== 'function' && token.type !== 'at-keyword') return;
    const name = asciiLower(token.name);
    if ((token.type === 'function' && STRING_URL_FUNCTIONS.has(name)) || (token.type === 'at-keyword' && name === 'import')) {
      const value = stringAfter(at);
      if (value !== undefined) urls.push(value);
    } else if (token.type === 'function' && IMAGE_SETS.has(name)) {
      // Its options are the strings at its own depth; a function or bracket inside opens a level.
      let depth = 0;
      for (const inner of tokens.slice(at + 1)) {
        if (inner.type === 'function' || inner.type === '(') depth++;
        else if (inner.type === ')') {
          if (depth === 0) break;
          depth--;
        } else if (inner.type === 'string' && depth === 0) urls.push(inner.value);
      }
    }
  });
  return urls.map((url) => url.trim());
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
    names.push(asciiLower(raw.slice(start, i)));
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

/**
 * Where a `<meta http-equiv="refresh">` sends the page, read as the HTML spec's shared declarative
 * refresh steps read its content: a time, then `;` or `,`, then a URL with or without `url=`, in
 * quotes or not. Undefined when it navigates nowhere else: no URL (the page reloads itself), or a
 * content the steps give up on.
 */
export function refreshUrl(content: string): string | undefined {
  let i = 0;
  const at = (pattern: RegExp) => i < content.length && pattern.test(content[i]!);
  const skipSpace = () => {
    while (at(TAG_SPACE)) i++;
  };
  skipSpace();
  const time = i;
  while (at(/[0-9]/)) i++;
  if (i === time && !at(/\./)) return undefined;
  while (at(/[0-9.]/)) i++;
  if (i < content.length) {
    if (!at(/[\t\n\f\r ;,]/)) return undefined;
    skipSpace();
    if (at(/[;,]/)) i++;
    skipSpace();
  }
  if (i >= content.length) return undefined;
  const whole = content.slice(i);
  const skipQuotes = () => {
    const quote = at(/['"]/) ? content[i++]! : '';
    const rest = content.slice(i);
    return quote && rest.includes(quote) ? rest.slice(0, rest.indexOf(quote)) : rest;
  };
  // "url", then "=", each optional as the steps read them; a partial match is part of the URL.
  if (!at(/[Uu]/)) return skipQuotes();
  i++;
  if (!at(/[Rr]/)) return whole;
  i++;
  if (!at(/[Ll]/)) return whole;
  i++;
  skipSpace();
  if (!at(/=/)) return whole;
  i++;
  skipSpace();
  return skipQuotes();
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
      const target = refreshUrl(get('content') ?? '');
      if (target !== undefined) add('content', target);
    }
    // An HTML <style> is raw text, its entities left as written; an SVG <style> is foreign content,
    // its entities decoded. node-html-parser cannot say which, so both readings are scanned.
    if (tag === 'style') {
      for (const url of new Set([...cssUrls(element.rawText), ...cssUrls(element.text)])) references.push({ element: tag, attribute: 'text', url, image: true, script: false });
    }
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

/** Violations in one stylesheet: every URL cssUrls finds. */
export function foreignInCss(css: string, options: Options): string[] {
  const references = cssUrls(css).map((url) => ({ element: 'css', attribute: 'url', url, image: true, script: false }));
  return violations(references, options, options.file ?? options.page);
}
