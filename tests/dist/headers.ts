/**
 * The built `_headers` judged against the security-header allow-list: every
 * Content-Security-Policy on any path, directive by directive, and the sibling headers on `/*`.
 * The CSP is the browser's backstop for C2 and C3: it is what stops a bundled module, or a CSS
 * URL form the dist scan misses, from loading a third-party script that reads the contact form
 * and sends it out. Pure, so it can be tested on strings (tests/unit/security-headers.test.ts);
 * tests/dist/files.test.ts applies it to dist/_headers.
 *
 * The sources below are the allow-list. They are not read back from public/_headers, because
 * this is what judges that file.
 */

/** Directive names, keywords, schemes and hosts compare ASCII case-insensitively. */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
/** CSP's whitespace: ASCII only. */
const CSP_SPACE = /[\t\n\f\r ]+/;

/** Cloudflare Turnstile: the widget's script and its frame (C3, C5). */
export const TURNSTILE = 'https://challenges.cloudflare.com';

/** Cloudflare Web Analytics: allowed, and then required, only when site.analytics.cloudflareToken is set (AGENTS.md). */
export const ANALYTICS = { 'script-src': 'https://static.cloudflareinsights.com', 'connect-src': 'https://cloudflareinsights.com' } as const;

/**
 * Every directive a policy may set, and every source each may list: the template's policy. A
 * subset passes, so a site may drop a source or a directive (one that falls back to `default-src`
 * gets `'self'` at most). Anything else fails, which is how no wildcard, bare scheme (but
 * `img-src`'s `data:`), `'unsafe-eval'`, `'unsafe-hashes'` or `'strict-dynamic'` gets in. A site
 * that genuinely needs another source adds it here, and that edit is the change a reviewer sees.
 */
export const CSP_ALLOW_LIST: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", TURNSTILE],
  'frame-src': [TURNSTILE],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
};

/**
 * `'none'` is allowed in every directive too. Alone it matches nothing, and beside other sources
 * a browser ignores it, so it never widens one.
 */
const NONE = "'none'";

/**
 * Present in every policy, with exactly this source list. `base-uri`, `form-action` and
 * `frame-ancestors` have no `default-src` fallback, so leaving one out allows everything.
 */
const CSP_EXACT: Readonly<Record<string, readonly string[]>> = {
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** Present in every policy, with sources the allow-list passes. */
const CSP_REQUIRED = ['default-src', 'script-src', 'connect-src'];

/** Sources every policy must list, beyond the subset check: Turnstile (C5's form needs it), and the beacon when the token is set. */
function cspMustList(analyticsToken: string | undefined): Record<string, string[]> {
  const must: Record<string, string[]> = { 'script-src': [TURNSTILE], 'frame-src': [TURNSTILE] };
  if (analyticsToken) {
    must['script-src']!.push(ANALYTICS['script-src']);
    must['connect-src'] = [ANALYTICS['connect-src']];
  }
  return must;
}

function cspAllowed(analyticsToken: string | undefined): Map<string, Set<string>> {
  const allowed = new Map(Object.entries(CSP_ALLOW_LIST).map(([name, sources]) => [name, new Set([...sources, NONE])]));
  if (analyticsToken) for (const [name, source] of Object.entries(ANALYTICS)) allowed.get(name)!.add(source);
  return allowed;
}

const HSTS_MIN_MAX_AGE = 31536000;

function hstsProblem(value: string): string | undefined {
  // RFC 6797 6.1: `;`-separated directives, each named once, or a browser ignores the header.
  const trim = (text: string) => text.replace(/^[\t ]+|[\t ]+$/g, '');
  const directives = new Map<string, string>();
  for (const part of value.split(';')) {
    const directive = trim(part);
    if (!directive) continue;
    const equals = directive.indexOf('=');
    const name = asciiLower(trim(equals === -1 ? directive : directive.slice(0, equals)));
    if (directives.has(name)) return `names ${name} twice, so a browser ignores the whole header`;
    directives.set(name, equals === -1 ? '' : trim(directive.slice(equals + 1)).replace(/^"(.*)"$/, '$1'));
  }
  const maxAge = directives.get('max-age');
  if (maxAge === undefined || !/^\d+$/.test(maxAge)) return `has no max-age a browser can read: ${value}`;
  if (Number(maxAge) < HSTS_MIN_MAX_AGE) return `max-age=${maxAge} is less than ${HSTS_MIN_MAX_AGE} (a year)`;
  return undefined;
}

const exactly = (expected: string) => (value: string) => (value === expected ? undefined : `must be ${expected}, not ${value}`);

/** The headers that sit beside the CSP on `/*`: each is set there once, with this value. */
const SIBLINGS: Readonly<Record<string, { name: string; problem: (value: string) => string | undefined }>> = {
  'x-content-type-options': { name: 'X-Content-Type-Options', problem: (value) => (asciiLower(value) === 'nosniff' ? undefined : `must be nosniff, not ${value}`) },
  'referrer-policy': { name: 'Referrer-Policy', problem: exactly('strict-origin-when-cross-origin') },
  'permissions-policy': { name: 'Permissions-Policy', problem: exactly('camera=(), microphone=(), geolocation=()') },
  'strict-transport-security': { name: 'Strict-Transport-Security', problem: hstsProblem },
};

const CSP = 'content-security-policy';
/** The headers no `!` line may remove, by their lower-case names. */
const SECURITY_HEADERS: ReadonlyMap<string, string> = new Map([[CSP, 'Content-Security-Policy'], ...Object.entries(SIBLINGS).map(([key, { name }]) => [key, name] as const)]);

export interface Options {
  /** site.analytics.cloudflareToken. */
  analyticsToken?: string;
}

/** One policy's directives, as a browser parses them (CSP3 2.2.1): names folded, a repeat dropped. */
function parsePolicy(policy: string): { directives: Map<string, string[]>; repeated: string[] } {
  const directives = new Map<string, string[]>();
  const repeated: string[] = [];
  for (const token of policy.split(';')) {
    const [name, ...sources] = token.split(CSP_SPACE).filter(Boolean);
    if (!name) continue;
    const key = asciiLower(name);
    if (directives.has(key)) repeated.push(key);
    else directives.set(key, sources);
  }
  return { directives, repeated };
}

/** Problems with one Content-Security-Policy value, each naming the directive and the source. */
export function cspProblems(value: string, options: Options = {}): string[] {
  const allowed = cspAllowed(options.analyticsToken);
  const mustList = cspMustList(options.analyticsToken);
  // A comma separates policies in one value, and a browser enforces every one, so each is held
  // to the whole check. An empty one is dropped, as a browser drops it.
  const policies = value.split(',').map(parsePolicy).filter((policy) => policy.directives.size > 0);
  if (policies.length === 0) return ['the policy is empty'];
  const problems: string[] = [];
  policies.forEach(({ directives, repeated }, index) => {
    const add = (problem: string) => problems.push(policies.length > 1 ? `policy ${index + 1}: ${problem}` : problem);
    for (const name of repeated) add(`${name} appears twice, and a browser keeps only the first`);
    for (const [name, sources] of directives) {
      const known = allowed.get(name);
      if (!known) {
        add(`${name} is not a directive the allow-list knows`);
        continue;
      }
      for (const source of sources) if (!known.has(asciiLower(source))) add(`${name} allows ${source}, which the allow-list does not`);
    }
    for (const [name, expected] of Object.entries(CSP_EXACT)) {
      const sources = directives.get(name);
      if (!sources) add(`${name} is missing; it must be ${name} ${expected.join(' ')}`);
      else if (sources.map(asciiLower).join(' ') !== expected.join(' ')) add(`${name} must be exactly ${expected.join(' ')}, not ${sources.join(' ') || '(empty)'}`);
    }
    for (const name of CSP_REQUIRED) if (!directives.has(name)) add(`${name} is missing`);
    for (const [name, sources] of Object.entries(mustList)) {
      const listed = (directives.get(name) ?? []).map(asciiLower);
      for (const source of sources) if (!listed.includes(source)) add(`${name} must allow ${source}`);
    }
  });
  return problems;
}

export interface HeaderLine {
  line: number;
  /** Lower-cased, as Cloudflare stores it. */
  name: string;
  value: string;
}

export interface HeaderRule {
  path: string;
  line: number;
  set: HeaderLine[];
  /** `! Name` lines: headers removed from responses on this path. Lower-cased and trimmed. */
  unset: { line: number; name: string }[];
}

// Cloudflare's own reading of the file (workers-shared's parseHeaders, which wrangler and
// miniflare bundle): lines are trimmed, so indentation means nothing; a line that starts with `/`
// or has a `scheme://` before any space starts a rule; a header's name runs to the first colon;
// "! " removes a header. A line it ignores, a line over 2,000 characters, and every rule after the
// 100th are problems here, so what this reads is what Cloudflare applies.
const PATH_LINE = /^([^\s]+:\/\/|\/)/;
const MAX_LINE = 2000;
const MAX_RULES = 100;

export function parseHeaders(text: string): { rules: HeaderRule[]; problems: string[] } {
  const rules: HeaderRule[] = [];
  const problems: string[] = [];
  let rule: HeaderRule | undefined;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const content = lines[index]!.trim();
    const ignored = (why: string) => problems.push(`_headers:${line}: Cloudflare ignores this line: ${why}`);
    if (!content || content.startsWith('#')) continue;
    if (content.length > MAX_LINE) {
      ignored(`it is longer than ${MAX_LINE} characters`);
      continue;
    }
    if (PATH_LINE.test(content)) {
      rule = { path: content, line, set: [], unset: [] };
      rules.push(rule);
      continue;
    }
    if (!rule) {
      ignored('it comes before any path');
      continue;
    }
    const colon = content.indexOf(':');
    if (colon === -1) {
      if (content.startsWith('! ')) rule.unset.push({ line, name: content.slice(2).trim().toLowerCase() });
      else ignored('it is neither "Name: value" nor "! Name"');
      continue;
    }
    const name = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    if (!name || /\s/.test(name)) ignored('its header name is empty or has a space');
    else if (!value) ignored('its header has no value');
    else rule.set.push({ line, name, value });
  }
  if (rules.length > MAX_RULES) problems.push(`_headers: ${rules.length} rules, but Cloudflare applies only the first ${MAX_RULES} and ignores the file from line ${rules[MAX_RULES]!.line}`);
  return { rules, problems };
}

/** Every problem with a `_headers` file, each naming its line. Empty when the file passes. */
export function headersProblems(text: string, options: Options = {}): string[] {
  const { rules, problems } = parseHeaders(text);
  const at = (rule: HeaderRule, line: number) => `_headers:${line} (${rule.path})`;
  for (const rule of rules) {
    for (const { line, name } of rule.unset) {
      const header = SECURITY_HEADERS.get(name);
      if (header) problems.push(`${at(rule, line)}: "! ${header}" removes a security header`);
    }
    for (const { line, name, value } of rule.set) {
      if (name === CSP) for (const problem of cspProblems(value, options)) problems.push(`${at(rule, line)}: Content-Security-Policy: ${problem}`);
    }
  }
  const root = rules.filter((rule) => rule.path === '/*');
  if (!root.some((rule) => rule.set.some(({ name }) => name === CSP))) problems.push('_headers: /* sets no Content-Security-Policy');
  for (const [key, { name, problem }] of Object.entries(SIBLINGS)) {
    const lines = rules.flatMap((rule) => rule.set.filter((header) => header.name === key).map((header) => ({ rule, ...header })));
    if (!root.some((rule) => lines.some((line) => line.rule === rule))) problems.push(`_headers: /* sets no ${name}`);
    lines.forEach(({ rule, line, value }, index) => {
      if (rule.path !== '/*' || index > 0) problems.push(`${at(rule, line)}: ${name} belongs once on /* and nowhere else, since Cloudflare joins every value that applies to a response`);
      const wrong = problem(value);
      if (wrong) problems.push(`${at(rule, line)}: ${name} ${wrong}`);
    });
  }
  return problems;
}
