# Design ingest

`ingest.mjs` is the only way a Claude Design bundle reaches this checkout. The `new-site` skill
(step 2) runs it from the repository root, with exactly one input:

    node tools/design-ingest/ingest.mjs --source                  # the URL on design/SOURCE.md's first line
    node tools/design-ingest/ingest.mjs --source --host <name>    # another host, once the person confirms it
    node tools/design-ingest/ingest.mjs --archive design/<file>   # a .zip or .tar.gz
    node tools/design-ingest/ingest.mjs --dir design/incoming     # a folder (gitignored staging)

It is plain Node with no dependencies, so it runs the same from PowerShell or a POSIX shell.

**The URL never reaches a shell.** The tool reads it from `design/SOURCE.md` and parses it. It
accepts only `https:` with no credentials and no port but 443, on `api.anthropic.com` or the
`--host` the person confirmed. It downloads with `fetch`, following at most 5 redirects, each
`https:`, into memory only, capped at 20 MB and 60 seconds.

**Every entry is checked before anything is written.** The format is decided by magic bytes. One
leading `./` on an entry's name is stripped first, and a `./` root folder is skipped (it still
counts toward the cap), so `tar -C dir -czf x.tar.gz .` output is admitted. The whole bundle is
refused, with a reason naming the entry, for:

- a link or special file of any kind;
- an absolute path, a drive letter, a backslash, a `.`, `..` or empty segment, a control
  character, a format or line-separator character (a bidi override, a zero-width or tag
  character), invalid UTF-8, or a name Windows reserves or cannot hold;
- two names equal after NFC normalisation and lower-casing, or a name that is both a file and a
  folder;
- in a zip: encryption, a method other than stored or deflate, zip64, more than one disk, a local
  header that disagrees with the central directory, overlapping entries, a CRC or size mismatch,
  or a non-ASCII name without the UTF-8 flag;
- in a tar: a bad checksum, or a type other than a file, a folder, a pax header (only its `path`
  and `size` are used), a GNU long name, or a pax global header holding only a `comment` (as
  `git archive` writes; it is ignored);
- more than 2000 entries (folders included), more than 50 MB unpacked, or a path deeper than 32
  segments or longer than 1024 bytes.

These entries are **omitted**, and listed in the output with the reason: anything under a name that
starts with a dot (`.git`, `.claude`, `.github`, `.mcp.json`, …); agent instructions (`CLAUDE.md`,
`AGENTS.md`, `SKILL.md`, `*.mdc` and the like, in any case); and any file that is not one of
`.html .htm .css .js .mjs .jsx .ts .tsx .json .md .txt .svg .png .jpg .jpeg .gif .webp .avif .ico
.woff .woff2 .ttf .otf`.

**The output is always a fresh `design/bundle/`.** The tool refuses if it exists in any form, and
writes files `0644` with nothing taken from the archive's modes or owners. A refusal exits 1 and
writes nothing; a usage error exits 2.

`tests/unit/design-ingest.test.ts` builds every fixture in memory, hostile ones included
(`tests/unit/design-ingest-archives.ts` holds small zip and tar writers), so a change to the
allow-list has to pass them.
