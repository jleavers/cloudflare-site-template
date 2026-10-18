import { describe, expect, test } from 'vitest';
import { attributeNames, foreignInCss, foreignInHtml, repeatedAttributes } from '../dist/foreign';

const SITE = 'https://example.com';
const PAGE = `${SITE}/privacy/`;
const html = (markup: string, analyticsToken?: string) =>
  foreignInHtml(markup, { page: PAGE, siteUrl: SITE, analyticsToken });

describe('foreignInHtml refuses', () => {
  test.each([
    ['a mixed-case, padded preconnect', '<LINK REL=" PreConnect " HREF="https://fonts.gstatic.com">'],
    ['a protocol-relative dns-prefetch preconnect', '<link rel="dns-prefetch preconnect" href="//cdn.example.net">'],
    ['a mixed-case stylesheet', '<link rel="Stylesheet" href="https://cdn.example.net/x.css">'],
    ['a foreign svg image', '<img src="https://cdn.example.net/x.svg">'],
    ['a video poster', '<video poster="https://cdn.example.net/p.jpg">'],
    ['a foreign srcset candidate', '<source srcset="https://cdn.example.net/a.webp 1x, /b.webp 2x">'],
    ['an anchor ping', '<a href="/x" ping="https://track.example.net/p">x</a>'],
    ['a style element @import', '<style>@import "https://cdn.example.net/x.css";</style>'],
    ['a style attribute url()', '<div style="background:url(//cdn.example.net/i.png)">'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0; url=https://elsewhere.example.net/">'],
    ['an entity-encoded src', '<img src="&#47;&#47;cdn.example.net/x.png">'],
    ['an SVG xlink:href', '<svg><use xlink:href="https://cdn.example.net/s.svg#a"/></svg>'],
    ['a src inside noscript', '<noscript><img src="https://cdn.example.net/t.gif"></noscript>'],
    ['a data: URL outside an image place', '<iframe src="data:text/html,hi"></iframe>'],
    ['a foreign script', '<script src="https://cdn.example.net/x.js"></script>'],
    ['the Turnstile host as a stylesheet', '<link rel="stylesheet" href="https://challenges.cloudflare.com/x.css">'],
    ['a foreign form action', '<form action="https://example.net/post">'],
    ['a foreign imagesrcset', '<link rel="preload" as="image" imagesrcset="https://cdn.example.net/a.png 1x">'],
    ['a look-alike host', '<img src="https://example.com.evil.net/x.png">'],
    // A browser keeps the first of a repeated attribute name and drops the rest; a check that
    // reads another copy proves nothing. The final review's two cases, then the safe-looking one.
    ['a preconnect whose href is repeated in capitals', '<link rel="preconnect" href="https://evil.example.net" HREF="/ok">'],
    ['an image whose src is repeated in capitals', '<img src="https://evil.example.net/x.png" SRC="/favicon.svg">'],
    ['a script whose src is repeated in capitals', '<script src="https://evil.example.net/x.js" SRC="/_astro/x.js"></script>'],
    ['a repeated name even when the first copy is on the site', '<img src="/favicon.svg" src="https://evil.example.net/x.png">'],
  ])('%s', (_name, markup) => {
    expect(html(markup)).not.toEqual([]);
  });

  test('names the page, element, attribute and URL', () => {
    const [message] = html('<link rel="preconnect" href="https://fonts.gstatic.com">');
    expect(message).toContain(PAGE);
    expect(message).toContain('<link>');
    expect(message).toContain('href');
    expect(message).toContain('https://fonts.gstatic.com');
  });

  test('names the repeated attribute', () => {
    expect(html('<link rel="preconnect" href="https://evil.example.net" HREF="/ok">')).toContain(`${PAGE}: <link> repeats the attribute "href", and a browser keeps only the first`);
  });

  test('the analytics beacon without a token', () => {
    expect(html('<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>')).not.toEqual([]);
  });

  test('a stylesheet on the analytics host even with a token', () => {
    expect(html('<link rel="stylesheet" href="https://static.cloudflareinsights.com/x.css">', 'tok')).not.toEqual([]);
  });
});

describe('foreignInHtml allows', () => {
  test.each([
    ['navigation', '<a href="https://github.com/x">x</a>'],
    ['an area link', '<map><area href="https://github.com/x"></map>'],
    ['the canonical link', `<link rel="canonical" href="${SITE}/">`],
    ['a same-origin preload', '<link rel="preload" href="/_astro/fonts/a.woff2">'],
    ['a data: image', '<img src="data:image/png;base64,AAAA">'],
    ['a data: image in srcset', '<img srcset="data:image/png;base64,AAAA 1x, /a.png 2x">'],
    ['Turnstile', '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'],
    ['a relative image', '<img src="../_astro/a.webp">'],
    ['a same-origin absolute stylesheet', `<link rel="stylesheet" href="${SITE}/_astro/a.css">`],
    ['a same-origin ping', '<a href="/x" ping="/p">x</a>'],
    ['a same-origin meta refresh', '<meta http-equiv="refresh" content="0; url=/other/">'],
    ['a same-origin style url', '<div style="background:url(/_astro/a.png)">'],
  ])('%s', (_name, markup) => {
    expect(html(markup)).toEqual([]);
  });

  test('the analytics beacon, with a token', () => {
    const beacon = '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>';
    expect(html(beacon, 'tok')).toEqual([]);
  });
});

describe('foreignInCss', () => {
  const css = (source: string) => foreignInCss(source, { page: `${SITE}/_astro/a.css`, siteUrl: SITE, file: '_astro/a.css' });

  test('refuses a foreign font', () => {
    expect(css('@font-face{src:url(https://fonts.gstatic.com/a.woff2)}')).not.toEqual([]);
  });
  test('refuses a string @import', () => {
    expect(css('@import "https://cdn.example.net/x.css";')).not.toEqual([]);
  });
  test('refuses a quoted protocol-relative url()', () => {
    expect(css("a{background:URL( '//cdn.example.net/i.png' )}")).not.toEqual([]);
  });
  test('allows same-origin and data: urls', () => {
    expect(css('@font-face{src:url(/_astro/fonts/a.woff2)} a{background:url("data:image/png;base64,AAAA")}')).toEqual([]);
  });
});

// The attribute names as the HTML tokeniser reads them from node-html-parser's rawAttrs.
describe('attributeNames', () => {
  test.each([
    ['ASCII case folded, repeats kept', 'rel="preconnect" href="https://evil.example.net" HREF="/ok"', ['rel', 'href', 'href']],
    ['a quoted value hides nothing', 'alt="a src=b" title=\'c href=d\' src=/e', ['alt', 'title', 'src']],
    ['no space after a quoted value', 'src="/a"SRC="https://evil.example.net/x.png"', ['src', 'src']],
    ['a slash between attributes', 'alt="x" /src="https://evil.example.net/x.png" /', ['alt', 'src']],
    ['a quote inside a name is part of it', 'x"src="/a" src=/b', ['x"src', 'src']],
    ['an equals sign that starts a name', '=src=x src=y', ['=src', 'src']],
    ['spaces around the equals sign', 'src = "/a" href =/b', ['src', 'href']],
    ['names with no value', 'async defer SRC', ['async', 'defer', 'src']],
    ['only ASCII letters fold', 'DATA-\u212A=1 data-k=2', ['data-\u212a', 'data-k']],
  ])('%s', (_name, raw, names) => {
    expect(attributeNames(raw)).toEqual(names);
  });

  test('repeatedAttributes names each repeated name once', () => {
    expect(repeatedAttributes('src=a SRC=b Src=c alt=d')).toEqual(['src']);
    expect(repeatedAttributes('src=a alt=b')).toEqual([]);
  });
});
