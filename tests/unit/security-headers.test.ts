import { describe, expect, test } from 'vitest';
import { ANALYTICS, CSP_ALLOW_LIST, headersProblems } from '../dist/headers';

// Today's public/_headers, written out: the fixture each row edits. The allow-list in
// tests/dist/headers.ts judges it, and neither is read from the other.
const BASE = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`;
const BASE_CSP = BASE.match(/Content-Security-Policy: (.+)/)![1]!;

/** BASE with each [from, to] pair replaced once; a pair that matches nothing is a broken row. */
function edit(...pairs: [string, string][]): string {
  return pairs.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`the fixture has no ${JSON.stringify(from)}`);
    return text.replace(from, to);
  }, BASE);
}
/** BASE with another block after it. */
const plus = (block: string) => `${BASE}${block}\n`;

const SCRIPT_SRC = "script-src 'self' https://challenges.cloudflare.com";
const WITH_ANALYTICS = edit(
  [SCRIPT_SRC, `${SCRIPT_SRC} ${ANALYTICS['script-src']}`],
  ["connect-src 'self'", `connect-src 'self' ${ANALYTICS['connect-src']}`],
);

describe('headersProblems refuses', () => {
  test.each([
    // The rows the sweep found passing (run 20261028T185449Z, cluster 2).
    ['a source after Turnstile in script-src', edit([SCRIPT_SRC, `${SCRIPT_SRC} https://evil.example`])],
    ['a widened connect-src', edit(["connect-src 'self'", "connect-src 'self' https://evil.example"])],
    ['a duplicate script-src', edit(["object-src 'none'", "object-src 'none'; script-src 'self'"])],
    ['a second CSP on another path that adds a source', plus(`/blog/*\n  Content-Security-Policy: ${BASE_CSP.replace(SCRIPT_SRC, `${SCRIPT_SRC} https://evil.example`)}`)],
    ['a "! Content-Security-Policy" line', plus('/blog/*\n  ! Content-Security-Policy')],
    ['object-src missing', edit(["; object-src 'none'", ''])],
    ['an HSTS max-age of 300', edit(['max-age=31536000\n', 'max-age=300\n'])],
    // The sweep's csp-wide mutation, one change at a time.
    ['a wildcard in script-src', edit([SCRIPT_SRC, `${SCRIPT_SRC} *`])],
    ["'unsafe-inline' in script-src", edit([SCRIPT_SRC, `${SCRIPT_SRC} 'unsafe-inline'`])],
    ["'unsafe-eval' in script-src", edit([SCRIPT_SRC, `${SCRIPT_SRC} 'unsafe-eval'`])],
    ["'unsafe-hashes' in script-src", edit([SCRIPT_SRC, `${SCRIPT_SRC} 'unsafe-hashes'`])],
    ["'strict-dynamic' in script-src", edit([SCRIPT_SRC, `${SCRIPT_SRC} 'strict-dynamic'`])],
    ['a bare https: in connect-src', edit(["connect-src 'self'", "connect-src 'self' https:"])],
    ['a wildcard host in img-src', edit(["img-src 'self' data:", "img-src 'self' data: https://*.example.net"])],
    ['data: outside img-src', edit(["font-src 'self'", "font-src 'self' data:"])],
    ['a widened form-action', edit(["form-action 'self'", "form-action 'self' https://evil.example"])],
    ["frame-ancestors 'self'", edit(["frame-ancestors 'none'", "frame-ancestors 'self'"])],
    ["object-src 'self'", edit(["object-src 'none'", "object-src 'self'"])],
    ['base-uri missing', edit(["; base-uri 'self'", ''])],
    ['form-action missing', edit(["; form-action 'self'", ''])],
    ['frame-ancestors missing', edit(["; frame-ancestors 'none'", ''])],
    ['default-src missing', edit(["default-src 'self'; ", ''])],
    ['connect-src missing', edit(["; connect-src 'self'", ''])],
    ['a directive the allow-list does not know', edit([SCRIPT_SRC, `${SCRIPT_SRC}; script-src-elem https://evil.example`])],
    ['a duplicate directive in other case', edit(["object-src 'none'", "object-src 'none'; SCRIPT-SRC 'self'"])],
    ['a second policy after a comma that adds a source', edit(["object-src 'none'", "object-src 'none', script-src https://evil.example"])],
    ['a lower-case CSP header on another path that adds a source', plus(`/blog/*\n  content-security-policy: ${BASE_CSP.replace("connect-src 'self'", "connect-src 'self' https://evil.example")}`)],
    ['the analytics hosts without a token', WITH_ANALYTICS],
    ['Turnstile dropped from script-src', edit([SCRIPT_SRC, "script-src 'self'"])],
    ['Turnstile dropped from frame-src', edit(['frame-src https://challenges.cloudflare.com; ', ''])],
    ['a CSP on another path only', edit(['/*\n', '/blog/*\n'], ['  X-Content-Type-Options', '/*\n  X-Content-Type-Options'])],
    ['an empty CSP', edit([BASE_CSP, ';'])],
    // The sibling headers.
    ['X-Content-Type-Options missing', edit(['  X-Content-Type-Options: nosniff\n', ''])],
    ['Referrer-Policy widened', edit(['strict-origin-when-cross-origin', 'unsafe-url'])],
    ['Permissions-Policy widened', edit(['camera=()', 'camera=*'])],
    // Tightening passes, widening never does (20r round 1).
    ['a Referrer-Policy list that ends in a wider policy', edit(['strict-origin-when-cross-origin', 'no-referrer, unsafe-url'])],
    ['a Permissions-Policy feature allowed to self', edit(['geolocation=()', 'geolocation=(), payment=(self)'])],
    ['a Permissions-Policy feature allowed to all', edit(['geolocation=()', 'geolocation=(), usb=*'])],
    ['a Permissions-Policy feature repeated wider', edit(['geolocation=()', 'geolocation=(), camera=*'])],
    ['a Permissions-Policy without geolocation', edit([', geolocation=()', ''])],
    ['a Permissions-Policy a browser cannot parse (spaces around =)', edit(['camera=()', 'camera = ()'])],
    ['a Permissions-Policy a browser cannot parse (a capital)', edit(['camera=()', 'Camera=()'])],
    ['a Permissions-Policy a browser cannot parse (a trailing comma)', edit(['geolocation=()', 'geolocation=(),'])],
    ["webrtc 'allow'", edit([SCRIPT_SRC, `${SCRIPT_SRC}; webrtc 'allow'`])],
    ['upgrade-insecure-requests with a value', edit([SCRIPT_SRC, `${SCRIPT_SRC}; upgrade-insecure-requests https://evil.example`])],
    ['HSTS missing', edit(['  Strict-Transport-Security: max-age=31536000\n', ''])],
    ['HSTS with max-age twice', edit(['max-age=31536000\n', 'max-age=31536000; max-age=300\n'])],
    ['HSTS set again on another path', plus('/blog/*\n  Strict-Transport-Security: max-age=31536000')],
    ['Referrer-Policy set again on another path', plus('/blog/*\n  Referrer-Policy: unsafe-url')],
    ['a "! Strict-Transport-Security" line', plus('/blog/*\n  ! Strict-Transport-Security')],
    ['a "!" line on /* in other case', edit(['/_astro/*', '  !   referrer-policy\n/_astro/*'])],
    // Lines Cloudflare ignores, which take the header with them.
    ['an HSTS line with no colon', edit(['Strict-Transport-Security: max-age', 'Strict-Transport-Security max-age'])],
    ['a header line that reads as a path, ending the /* block', edit(['  X-Content-Type-Options', '  X-Probe:https://evil.example\n  X-Content-Type-Options'])],
    ['a CSP line over 2,000 characters', edit(["img-src 'self' data:", `img-src 'self' data:${" 'self'".repeat(300)}`])],
    ['a "!" with no space, which Cloudflare ignores', edit(['/_astro/*', '  !Cache-Control\n/_astro/*'])],
    ['more than 100 rules', plus(Array.from({ length: 100 }, (_, i) => `/p${i}/*\n  X-Robots-Tag: noindex`).join('\n'))],
  ])('%s', (_name, text) => {
    expect(headersProblems(text)).not.toEqual([]);
  });

  test('a token without the analytics hosts', () => {
    expect(headersProblems(BASE, { analyticsToken: 'tok' })).not.toEqual([]);
  });

  test('names the line, the path, the directive and the source', () => {
    const problems = headersProblems(plus(`/blog/*\n  Content-Security-Policy: ${BASE_CSP.replace("connect-src 'self'", "connect-src 'self' https://evil.example")}`));
    expect(problems).toEqual([
      '_headers:10 (/blog/*): Content-Security-Policy: connect-src allows https://evil.example, which is not in its list; anything wider than the lists in tests/dist/headers.ts breaks contract C2 or C3, which only the owner can change',
    ]);
  });

  // A stamped site's agent reads these: each names what judges it and that the contract is the owner's.
  test.each([
    ['a source outside the list', edit([SCRIPT_SRC, `${SCRIPT_SRC} https://evil.example`])],
    ['an unknown directive', edit([SCRIPT_SRC, `${SCRIPT_SRC}; script-src-elem https://evil.example`])],
    ['a missing object-src', edit(["; object-src 'none'", ''])],
    ['a removed CSP', plus('/blog/*\n  ! Content-Security-Policy')],
    ['a wider Referrer-Policy', edit(['strict-origin-when-cross-origin', 'unsafe-url'])],
    ['a wider Permissions-Policy', edit(['camera=()', 'camera=*'])],
    ['a shorter HSTS', edit(['max-age=31536000\n', 'max-age=300\n'])],
    ['a missing X-Content-Type-Options', edit(['  X-Content-Type-Options: nosniff\n', ''])],
  ])('names tests/dist/headers.ts and the owner on %s, and invites no edit', (_name, text) => {
    const problems = headersProblems(text);
    expect(problems).not.toEqual([]);
    for (const problem of problems) {
      expect(problem).toContain('tests/dist/headers.ts');
      expect(problem).toContain('breaks contract C2 or C3, which only the owner can change');
      expect(problem).not.toMatch(/\b(add|edit|extend|widen)\b/i);
    }
  });
});

describe('headersProblems allows', () => {
  test.each([
    ["today's _headers", BASE],
    ["a tightened img-src ('self' only)", edit(["img-src 'self' data:", "img-src 'self'"])],
    ['style-src and font-src dropped (they fall back to default-src)', edit(["; style-src 'self' 'unsafe-inline'; font-src 'self'", ''])],
    ["default-src 'none'", edit(["default-src 'self'", "default-src 'none'"])],
    ['directive names and keywords in other case', edit(["object-src 'none'", "OBJECT-SRC 'NONE'"])],
    ['a stricter CSP on another path', plus(`/blog/*\n  Content-Security-Policy: ${BASE_CSP.replace("img-src 'self' data:", "img-src 'self'")}`)],
    ['comments, blank lines and CRLF', `# Security headers\r\n\r\n${BASE.replaceAll('\n', '\r\n')}`],
    ['a longer HSTS with includeSubDomains and preload', edit(['max-age=31536000\n', 'max-age=63072000; includeSubDomains; preload\n'])],
    ['a "!" line that removes another header', plus('/blog/*\n  ! Cache-Control')],
    // Tightening passes (20r round 1).
    ['Referrer-Policy: no-referrer', edit(['strict-origin-when-cross-origin', 'no-referrer'])],
    ['Referrer-Policy: same-origin', edit(['strict-origin-when-cross-origin', 'same-origin'])],
    ['Referrer-Policy: strict-origin', edit(['strict-origin-when-cross-origin', 'strict-origin'])],
    ['a reordered, respaced Permissions-Policy', edit(['camera=(), microphone=(), geolocation=()', 'geolocation=(),camera=( ),\tmicrophone=()'])],
    ['more Permissions-Policy features denied', edit(['geolocation=()', 'geolocation=(), payment=(), usb=()'])],
    ['upgrade-insecure-requests', edit([SCRIPT_SRC, `${SCRIPT_SRC}; upgrade-insecure-requests`])],
    ["require-trusted-types-for 'script'", edit([SCRIPT_SRC, `${SCRIPT_SRC}; require-trusted-types-for 'script'`])],
    ["webrtc 'block'", edit([SCRIPT_SRC, `${SCRIPT_SRC}; webrtc 'block'`])],
  ])('%s', (_name, text) => {
    expect(headersProblems(text)).toEqual([]);
  });

  test('the analytics hosts, with a token', () => {
    expect(headersProblems(WITH_ANALYTICS, { analyticsToken: 'tok' })).toEqual([]);
  });
});

// The forbidden sources are refused by construction: the allow-list never lists them.
test("the allow-list has no wildcard, no bare scheme but img-src's data:, and no unsafe keyword but style-src's", () => {
  const lists = [...Object.entries(CSP_ALLOW_LIST), ['script-src', [ANALYTICS['script-src']]], ['connect-src', [ANALYTICS['connect-src']]]] as const;
  for (const [directive, sources] of lists) {
    for (const source of sources) {
      expect(source, `${directive} ${source}`).not.toContain('*');
      if (/^[a-z][a-z0-9+.-]*:$/.test(source)) expect(`${directive} ${source}`).toBe('img-src data:');
      expect(["'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", "'wasm-unsafe-eval'"], `${directive} ${source}`).not.toContain(source);
      if (source === "'unsafe-inline'") expect(directive).toBe('style-src');
      if (source.includes('://')) expect(source, `${directive} ${source}`).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  }
});
