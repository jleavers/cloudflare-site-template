# Design ingest

`ingest.mjs` is the only way a Claude Design bundle reaches this checkout. The `new-site` skill
(step 2) runs it from the repository root, with exactly one input:

    node tools/design-ingest/ingest.mjs --source                  # the URL on design/SOURCE.md's first line
    node tools/design-ingest/ingest.mjs --source --host <name>    # another host, once the person confirms it
    node tools/design-ingest/ingest.mjs --archive design/<file>   # a .zip or .tar.gz
    node tools/design-ingest/ingest.mjs --dir "<a folder outside the repository>"   # a folder, or saved artifact files

It is plain Node with no dependencies, so it runs the same from PowerShell or a POSIX shell.

**A folder stays outside the repository.** The tool refuses a `--dir` folder inside the
repository, before it reads anything in it: the folder's path, as given or through `realpath`,
may not be at or below the repository's (the folder holding `tools/design-ingest/`, and the
folder it writes `design/bundle/` under), compared without case. Editor extensions that scan the
workspace (Tailwind CSS IntelliSense imports the `tailwindcss` nearest each stylesheet when it
starts) can run code from raw design files there, and the tool checks only what it writes. So the
person extracts or assembles a folder outside the repository, in their Downloads folder for
example; the agent saves an artifact's files into a new folder in its session scratch directory
or under the OS temp directory; and the person deletes the folder after ingest. An archive is one
file, which no extension looks inside, so `--archive` takes one in `design/`. `.gitignore` keeps
its `design/incoming/` line only so that a stray copy is never committed.

**The URL never reaches a shell.** The tool reads it from `design/SOURCE.md` and parses it. It
accepts only `https:` with no credentials and no port but 443, on `api.anthropic.com` or the
`--host` the person confirmed. It downloads with `fetch`, following at most 5 redirects, each
`https:`, into memory only, capped at 20 MB and 60 seconds.

**Every entry is checked before anything is written.** The format is decided by magic bytes. One
leading `./` on an entry's name is stripped first, and a `./` root folder is skipped (it still
counts toward the cap), so `tar -C dir -czf x.tar.gz .` output is admitted. The whole bundle is
refused, with a reason naming the entry, for:

- a link or special file of any kind (in a `--dir` folder, a hard link too), and a `--dir` folder
  inside the repository (above);
- an absolute path, a drive letter, a backslash, a `.`, `..` or empty segment, a control
  character, a format or line-separator character (a bidi override, a zero-width or tag
  character), invalid UTF-8, or a name Windows reserves or cannot hold;
- two names equal once folded (NFKC, then lower-, upper- and lower-cased, so `ſ` is `s`, `ß` and
  `ẞ` are both `ss` and fullwidth letters are ASCII), or a name that is both a file and a folder;
- in a zip: encryption, a method other than stored or deflate, zip64, more than one disk, a local
  header or data descriptor that disagrees with the central directory, overlapping entries, or a
  CRC or size mismatch (every name is read as strict UTF-8, whatever its UTF-8 flag says);
- in a tar: a bad checksum, or a type other than a file, a folder, a pax header (only its `path`
  and `size` are used), a GNU long name, or a pax global header holding only a `comment` (as
  `git archive` writes; it is ignored), or a pax or long-name header over 64 KB;
- more than 2000 entries (folders included), more than 50 MB unpacked, or a path deeper than 32
  segments or longer than 1024 bytes.

These entries are **omitted**, and listed in the output with the reason:

- anything under a name that starts with a dot (`.git`, `.claude`, `.github`, `.vscode`,
  `.mcp.json`, …);
- agent instructions (`CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, `SKILL.md`, `*.mdc` and the
  like, compared folded). Markdown under any other name is renamed instead (below), so a context
  file of a tool this list does not name is inert too;
- tool configurations, compared folded. An editor or build tool finds one by looking upward from a
  file, or across the whole workspace, and a configuration can run code or name code to run:
  - `*.config.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`: ESLint, Prettier, Stylelint, PostCSS,
    Babel, Vite, Vitest, Jest, Playwright, Astro, Tailwind, lint-staged, oxlint, knip, cspell and
    more;
  - `package.json`, whose keys configure most of those, and `tsconfig*.json` and `jsconfig.json`,
    whose `plugins` TypeScript loads into the editor;
  - `babel.config.json`, `deno.json`, `deno.jsonc`, `biome.json`, `biome.jsonc` and
    `vitest.workspace.*`;
  - `tailwind.js`, `tailwind.mjs`, `tailwind.ts` and `tailwind.config.<anything>.js` (or `.mjs`,
    `.ts`), which the Tailwind CSS editor extension takes for a JavaScript config;
  - `cspell.json` and `cspell.config.json` (a cspell configuration may import a JavaScript one),
    `dprint.json` (dprint's plugins download and run), `jest.config.json` (Jest runs the modules
    it names), and `knip.json`, `knip.js` and `knip.ts`.

  A configuration that a design file type cannot carry (`.cjs`, `.yaml`, `.toml`, `.jsonc`) is
  omitted for its type, and a dotfile (`.eslintrc.json`, `.prettierrc`, `.markdownlint.jsonc`,
  `.lintstagedrc`, `.oxlintrc.json`, `.editorconfig`, `.devcontainer/`) for its dot;
- anything under a `node_modules` folder, compared folded: a tool that loads a package for a file
  looks in the nearest one first, and the Tailwind CSS editor extension imports `tailwindcss` that
  way for every Tailwind stylesheet in the workspace, when it starts;
- anything under a name with a character outside the allowed set (letters, digits, combining
  marks, space and `. _ ( ) + , @ -`; a name starts with a letter, a digit or `_`, and no
  character in it may be default-ignorable, such as a variation selector or a Hangul filler,
  which render as nothing), so a path inside `design/bundle/` is safe in a command in double
  quotes;
- any file whose extension, lower-cased, is not one of `.html .htm .css .js .mjs .jsx .ts .tsx
  .json .md .txt .svg .png .jpg .jpeg .gif .webp .avif .ico .woff .woff2 .ttf .otf`;
- any file whose bytes hold `@plugin` or `@config`. Tailwind CSS 4 reads its configuration from
  CSS, and these two make the build and the Tailwind CSS editor extension import and run a
  JavaScript module. Every design file is read, not only a `.css` one, because a stylesheet's
  `@import` or `@reference` reads a file of any type as CSS. The match is on the raw bytes, with
  no CSS parser:
  - in any letter case, and inside a comment or a string too;
  - with comments between the `@` and the name or inside it (Tailwind's parser drops them);
  - followed by any byte but an ASCII letter, digit, `-`, `_` or `\`, which would make it a longer
    name. Tailwind's parser trims Unicode spaces such as U+00A0, U+3000 and U+FEFF from a name, so
    any other byte, non-ASCII included, ends it.

  The scan skips NUL bytes as a margin, but both consumers read a file as UTF-8 only
  (`readFile(…, 'utf-8')`), so a UTF-16 file loads nothing, and the tool does not claim to read
  UTF-16. A `.css` file is also omitted for an at-keyword spelled with a backslash escape, with or
  without comments before the escape, whatever it decodes to. A stylesheet with only
  `@import "tailwindcss"` and `@theme` tokens is kept: design tokens are the point of a design. If
  a design you trust needs a Tailwind plugin, its stylesheet is left out: remove the directive from
  your copy and ingest again, and ask before adding the plugin, which is a dependency (AGENTS.md).

The tool reads each file's bytes once, in memory, after its name has passed: the caps above bound
what it reads, and the check takes about a second for the 50 MB maximum.

**Markdown is written under a `.txt` name.** Every `.md` file that passes those checks, but a
README (`README.md` in any folder, in any letter case), is written as `<its name>.txt`: `QWEN.md`
becomes `QWEN.md.txt`, and `docs/notes.md` becomes `docs/notes.md.txt`. Agent tools load context
files by name, some from any folder below the one they start in (Gemini CLI's `GEMINI.md`, Qwen
Code's `QWEN.md`), and no list of those names stays complete: the rename covers names no list
has, since no tool loads a `.txt` file as instructions. The duplicate check, the path-length cap
and every other name check apply to the written name, so a bundle holding both `a.md` and
`a.md.txt` is refused. A `.txt` file is written as it is.

**The output is always a fresh `design/bundle/`.** The tool refuses if it exists in any form, and
writes files `0644` with nothing taken from the archive's modes or owners. It prints each file it
wrote, each Markdown file it renamed, with the name it wrote, and each entry it omitted, with the
reason. A refusal exits 1 and writes nothing; a usage error exits 2.

`tests/unit/design-ingest.test.ts` builds every fixture in memory, hostile ones included
(`tests/unit/design-ingest-archives.ts` holds small zip and tar writers), so a change to the
allow-list has to pass them.
