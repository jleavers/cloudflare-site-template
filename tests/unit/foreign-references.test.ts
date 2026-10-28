import { describe, expect, test } from 'vitest';
import { attributeNames, cssUrls, foreignInCss, foreignInHtml, refreshUrl, repeatedAttributes } from '../dist/foreign';

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
    // The HTML spec follows a refresh URL with no "url=" (final review, minor 1).
    ['a meta refresh without url=', '<meta http-equiv="refresh" content="0; https://elsewhere.example.net/">'],
    ['a meta refresh with a comma and no space', '<meta http-equiv="refresh" content="0,https://elsewhere.example.net/">'],
    ['a meta refresh with a quoted URL and no url=', `<meta http-equiv="refresh" content="0; 'https://elsewhere.example.net/'">`],
    ['a meta refresh with spaces around the equals sign', `<meta http-equiv="refresh" content='.5; URL = "https://elsewhere.example.net/"'>`],
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
    ['a meta refresh that reloads the page', '<meta http-equiv="refresh" content="30">'],
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

  // Every CSS form that makes a browser fetch a URL (sweep run 20261028T185449Z, cluster 2).
  test.each([
    ['a string in image-set()', 'a{background:image-set("https://evil.example/a.png" 1x)}'],
    ['a string in -webkit-image-set()', 'a{background:-webkit-image-set("https://evil.example/a.png" 1x)}'],
    ['src()', '@font-face{font-family:x;src:src("https://evil.example/f.woff2")}'],
    ['an escaped url() name', String.raw`a{background:\75 rl(https://evil.example/x)}`],
    ['a second, single-quoted image-set() option', `a{background:image-set("/_astro/a.png" 1x,'https://evil.example/b.png' 2x)}`],
    ['a url() inside image-set()', 'a{background:image-set(url(https://evil.example/a.png) 1x)}'],
    ['image-set() in capitals', 'a{background:IMAGE-SET("https://evil.example/a.png" 1x)}'],
    ['src() with a space and a comment before its string', "a{background:src( /* c */ 'https://evil.example/f.woff2')}"],
    ['an escaped image-set() name', String.raw`a{background:\69 mage-set("https://evil.example/a.png" 1x)}`],
    ['six-digit escapes with no space after them', String.raw`a{background:\000075\000072\00006c(https://evil.example/x)}`],
    ['an escape of a letter that is not a hex digit', String.raw`a{background:ur\l(https://evil.example/x)}`],
    ['an escaped scheme in a quoted url()', String.raw`a{background:url("\68 ttps://evil.example/x")}`],
    ['an escaped quote that would end the string early', String.raw`a{background:url("https://example.com\22 @evil.example/x")}`],
    ['an escaped parenthesis in an unquoted url()', String.raw`a{background:url(https://example.com\29 @evil.example/x)}`],
    ['@import with no space before its string', '@import"https://evil.example/x.css";'],
    ['@import with a comment before its string', "@import/**/'https://evil.example/x.css';"],
    ['an escaped @import', String.raw`@\69 mport "https://evil.example/x.css";`],
    ['a url() string followed by a modifier', 'a{background:url("https://evil.example/x" cross-origin(anonymous))}'],
  ])('refuses %s', (_name, source) => {
    expect(css(source)).not.toEqual([]);
  });

  test.each([
    ['same-origin and data: image-set() strings', 'a{background:image-set("/_astro/a.png" 1x, "data:image/png;base64,AAAA" 2x)}'],
    ["image-set()'s type() string, which is not a URL", 'a{background:image-set("/_astro/a.avif" type("image/avif") 1x)}'],
    ['a url() in a comment', '/* url(https://evil.example/x) */ a{color:red}'],
    ['a string that only mentions url()', 'a{content:"url(https://evil.example/x)"}'],
    ['an escaped class name that only spells url()', String.raw`.bg-\[url\(https\:\/\/evil\.example\/x\)\]{color:red}`],
  ])('allows %s', (_name, source) => {
    expect(css(source)).toEqual([]);
  });
});

// The URLs as a browser reads them: escapes decoded, image-set()'s own strings but not type()'s.
describe('cssUrls', () => {
  test.each([
    [String.raw`a{b:\75 rl(https\3a //evil.example/x)}`, ['https://evil.example/x']],
    [String.raw`a{b:url("https://example.com\22 @evil.example/x")}`, ['https://example.com"@evil.example/x']],
    [`a{b:image-set("a.png" 1x, url(b.png) 2x, 'c.png' type("image/png") 3x)}`, ['a.png', 'b.png', 'c.png']],
    [`@import "x.css"; @import url(y.css); @import url( 'z.css' ) layer(a);`, ['x.css', 'y.css', 'z.css']],
    ['@font-face{src:url(a.woff2) format("woff2"), src("b.woff2")}', ['a.woff2', 'b.woff2']],
    ['a{b:url(bad"url) url(ok)}', ['ok']],
  ])('%s', (source, urls) => {
    expect(cssUrls(source).sort()).toEqual(urls);
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

// The shared declarative refresh steps of the HTML spec, which a <meta http-equiv="refresh"> follows.
describe('refreshUrl', () => {
  test.each([
    ['0; url=https://a.example.net/', 'https://a.example.net/'],
    ['0; https://a.example.net/', 'https://a.example.net/'],
    ['  3 ,https://a.example.net/', 'https://a.example.net/'],
    ['0;URL=\'https://a.example.net/\'x', 'https://a.example.net/'],
    ['0; url = "https://a.example.net/', 'https://a.example.net/'],
    ['1.5 \'https://a.example.net/\'', 'https://a.example.net/'],
    ['0; urn:x', 'urn:x'],
    ['0; url https://a.example.net/', 'url https://a.example.net/'],
  ])('%s gives %s', (content, url) => {
    expect(refreshUrl(content)).toBe(url);
  });

  test.each(['5', '0;', '', 'soon; https://a.example.net/', '0x; https://a.example.net/'])('%j navigates nowhere else', (content) => {
    expect(refreshUrl(content)).toBeUndefined();
  });
});
