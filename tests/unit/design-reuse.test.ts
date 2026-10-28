import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

// Ruling 107: no code from design/bundle/ is copied or adapted into the site. The agent writes every
// script, style, component and SVG itself (new-site SKILL.md, the data rule and step 6). This file
// is a tripwire, not the boundary: the rule is. It catches the lazy copy, a bundle file carried into
// src/ or public/ whole, and a site file that names design/bundle; code that was adapted passes it.
// It runs on this repository's own tree, which in a stamped site holds the bundle, and on fixtures.

const root = fileURLToPath(new URL('../../', import.meta.url));

/** The bundle's file types that are code to a browser or the build, compared lower-cased. */
const CODE_TYPES = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx', '.css', '.html', '.htm', '.svg']);
/**
 * Below this many bytes, once normalised, a bundle file is not compared. What two unrelated web
 * projects share by chance is a line of boilerplate, each well under it: `export {};` is 10 bytes,
 * `<!doctype html>` 15, `@import "tailwindcss";` 22, `/// <reference types="astro/client" />` 38.
 * A script, stylesheet or drawing worth copying is longer, and the template's smallest source file
 * is 266 bytes.
 */
const MIN_BYTES = 64;
/** Raster images, which cannot import or link anything: a `design/bundle` string in their bytes is metadata, not a reference. */
const RASTER_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
/** Where the site is: what the build reads, and what is served as it is. */
const SITE = ['src', 'public'];

/** Every file under a folder of `base`, as a path relative to `base` with `/`; links are not followed. */
function filesUnder(base: string, dir: string): string[] {
  if (!existsSync(join(base, dir))) return [];
  return readdirSync(join(base, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(base, path) : entry.isFile() ? [path] : [];
  });
}

/** A file's bytes, one character each, with CRLF and CR as LF, no space or tab at a line's end, and no blank lines at its end. */
const normalised = (path: string) => readFileSync(path).toString('latin1').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const fingerprint = (text: string) => createHash('sha256').update(text, 'latin1').digest('hex');

/** Each file under src/ or public/ that is a copy of a code file in design/bundle/, as a message naming both. */
function copiedFromBundle(base: string): string[] {
  const code = new Map<string, string>();
  for (const path of filesUnder(base, 'design/bundle')) {
    if (!CODE_TYPES.has(extname(path).toLowerCase())) continue;
    const text = normalised(join(base, path));
    if (text.length >= MIN_BYTES && !code.has(fingerprint(text))) code.set(fingerprint(text), path);
  }
  return SITE.flatMap((dir) => filesUnder(base, dir)).flatMap((path) => {
    const bundled = code.get(fingerprint(normalised(join(base, path))));
    if (bundled === undefined) return [];
    if (extname(bundled).toLowerCase() === '.svg') {
      return [`${path} is a copy of ${bundled}. No SVG from the bundle is copied into the site, not even as an image: write the SVG from its shapes, yourself, with drawing elements only (new-site SKILL.md, step 6). If you did not copy it, the bundle holds a copy of this site's own file: tell the person, who can \`git rm\` it from design/bundle/; never rewrite src/contact/ or src/scripts/contact-form.ts to pass this check.`];
    }
    return [`${path} is a copy of ${bundled}. No code from the bundle is copied into the site: write the code instead, yourself, from design/INVENTORY.md and the screens (new-site SKILL.md, step 6). If you did not copy it, the bundle holds a copy of this site's own file: tell the person, who can \`git rm\` it from design/bundle/; never rewrite src/contact/ or src/scripts/contact-form.ts to pass this check.`];
  });
}

/** Each file under src/ or public/, but a raster image, whose bytes name design/bundle. */
function namingTheBundle(base: string): string[] {
  return SITE.flatMap((dir) => filesUnder(base, dir))
    .filter((path) => !RASTER_TYPES.has(extname(path).toLowerCase()))
    .filter((path) => readFileSync(join(base, path)).includes('design/bundle'))
    .map((path) => `${path} names design/bundle. The site never imports, links or points at the bundle: write the code yourself, and copy a raster image into src/assets/ (new-site SKILL.md, step 6).`);
}

describe('no code from design/bundle/ reaches the site', () => {
  const bundled = existsSync(join(root, 'design', 'bundle'));
  test(
    bundled ? 'no file under src/ or public/ is a copy of a code file in design/bundle/' : 'no file under src/ or public/ is a copy of a code file in design/bundle/ (there is no design/bundle/ here, so nothing to compare)',
    () => {
      expect(copiedFromBundle(root)).toEqual([]);
    },
  );

  test('no file under src/ or public/ names design/bundle', () => {
    expect(namingTheBundle(root)).toEqual([]);
  });
});

describe('the tripwire, on a fixture site', () => {
  const base = mkdtempSync(join(tmpdir(), 'design-reuse-'));
  const made: string[] = [];
  const write = (path: string, content: string | Buffer) => {
    for (let dir = dirname(join(base, path)); dir !== base && !made.includes(dir); dir = dirname(dir)) made.push(dir);
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
    made.push(join(base, path));
  };
  // Removes exactly what this describe made, deepest first, each removal on its own.
  afterAll(() => {
    for (const path of [...new Set(made)].sort((a, b) => b.length - a.length).concat(base)) {
      try {
        if (lstatSync(path).isDirectory()) rmdirSync(path);
        else unlinkSync(path);
      } catch {
        // already gone
      }
    }
  });

  /** Writes a file for one test, runs it, and removes the file again. */
  const withFile = (path: string, content: string | Buffer, run: () => void) => {
    write(path, content);
    try {
      run();
    } finally {
      unlinkSync(join(base, path));
    }
  };

  const carousel = "// A carousel.\nconst track = document.querySelector('[data-track]');\nfor (const button of document.querySelectorAll('[data-next]')) button.addEventListener('click', () => track.scrollBy({ left: track.clientWidth }));\n";
  const styles = '.card {\n  padding: 2rem;\n  border-radius: 1rem;\n  box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);\n}\n';
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#2f5d46"/><script>alert(1)</script></svg>\n';
  const chat = 'Make the hero warmer, and keep the carousel to three cards. The person rejected the dark theme.\n';
  const png = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
  write('design/bundle/screens/site.js', carousel);
  write('design/bundle/styles/cards.css', styles);
  write('design/bundle/assets/logo.svg', logo);
  write('design/bundle/assets/hero.png', png);
  write('design/bundle/chats/chat1.md.txt', chat);
  write('design/bundle/short.js', 'export {};\n');
  // The site's own files, and three the rule allows: a raster image copied from the bundle, a note
  // that matches a bundle file that is not code, and a line of boilerplate under the minimum.
  write('src/scripts/own.ts', "document.documentElement.dataset.ready = 'yes'; // this site's own script, longer than the minimum\n");
  write('public/robots.txt', 'User-agent: *\nAllow: /\n');
  write('src/assets/hero.png', png);
  write('src/content/notes.md', chat);
  write('src/env.d.ts', 'export {};\n');

  const WRITE_IT = 'No code from the bundle is copied into the site: write the code instead, yourself, from design/INVENTORY.md and the screens (new-site SKILL.md, step 6).';
  const NOT_COPIED = " If you did not copy it, the bundle holds a copy of this site's own file: tell the person, who can `git rm` it from design/bundle/; never rewrite src/contact/ or src/scripts/contact-form.ts to pass this check.";

  test('a clean site passes both checks', () => {
    expect(copiedFromBundle(base)).toEqual([]);
    expect(namingTheBundle(base)).toEqual([]);
  });

  test('finds a bundle script copied into src/, whatever its name, line endings or trailing whitespace', () => {
    withFile('src/scripts/carousel.ts', `${carousel.replaceAll('\n', '  \r\n')}\r\n\t\r\n`, () => {
      expect(copiedFromBundle(base)).toEqual([`src/scripts/carousel.ts is a copy of design/bundle/screens/site.js. ${WRITE_IT}${NOT_COPIED}`]);
    });
  });

  test('finds a bundle stylesheet copied into public/', () => {
    withFile('public/styles/site.css', styles, () => {
      expect(copiedFromBundle(base)).toEqual([`public/styles/site.css is a copy of design/bundle/styles/cards.css. ${WRITE_IT}${NOT_COPIED}`]);
    });
  });

  // An SVG in public/, or one <Image> emits into /_astro/, is served from the site's origin, where
  // opened on its own it is a document, and its script runs.
  test('finds a bundle SVG copied in as an image, and says to write it from its shapes', () => {
    withFile('public/favicon.svg', logo, () => {
      expect(copiedFromBundle(base)).toEqual([
        'public/favicon.svg is a copy of design/bundle/assets/logo.svg. No SVG from the bundle is copied into the site, not even as an image: write the SVG from its shapes, yourself, with drawing elements only (new-site SKILL.md, step 6).' + NOT_COPIED,
      ]);
    });
  });

  test('a raster image whose bytes hold design/bundle passes', () => {
    withFile('src/assets/photo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('tEXt Comment: exported from design/bundle/assets'), Buffer.from(png)]), () => {
      expect(namingTheBundle(base)).toEqual([]);
    });
  });

  test('finds a file under src/ or public/ that names design/bundle', () => {
    withFile('src/components/Carousel.astro', "---\nimport '../../design/bundle/styles/cards.css';\n---\n<div data-track></div>\n", () => {
      withFile('public/notes.txt', 'Taken from design/bundle/screens/home.html.\n', () => {
        expect(namingTheBundle(base)).toEqual([
          'src/components/Carousel.astro names design/bundle. The site never imports, links or points at the bundle: write the code yourself, and copy a raster image into src/assets/ (new-site SKILL.md, step 6).',
          'public/notes.txt names design/bundle. The site never imports, links or points at the bundle: write the code yourself, and copy a raster image into src/assets/ (new-site SKILL.md, step 6).',
        ]);
      });
    });
  });
});
