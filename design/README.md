# design/

The Claude Design output this site is built from. It is committed so the site's provenance stays
with it, and it is never part of the build: `tsconfig.json` and Astro both ignore this folder.

Put the design here, or point the skill at it, in **one** of three forms:

1. **A handoff link.** Standalone Claude Design's "Handoff to Claude Code" gives a prompt
   containing a URL. Claude Design inside Claude artifacts has no handoff option, so this form
   exists only for standalone Claude Design. Put that URL on the first line of `design/SOURCE.md`. The `new-site` skill downloads the
   bundle into `design/bundle/`.
2. **A downloaded archive** (the `.zip` "Project archive", or a handoff `.tar.gz`). Leave the
   archive in this folder, as one file, or extract it, or assemble a folder of the design's files,
   **outside the repository**, in your Downloads folder for example, and give the skill that
   folder's path; it ingests either into `design/bundle/`. Never put the folder inside the
   repository: editor extensions that scan the workspace (Tailwind CSS IntelliSense) can run code
   from it, and ingest checks only what it writes, so the skill refuses a folder there. Make it an
   extracted folder, not a git clone, don't open it or its files in your editor, and delete it
   after ingest: files in it, such as a `.git` or `.vscode` folder or a tool's config, can run
   commands when an editor opens or scans the folder. Opening a folder you don't know in VS Code's
   Restricted Mode is the safe default: Tailwind CSS IntelliSense, and every other extension that
   has not declared itself safe there, stays off until you trust the folder. Don't create
   `design/bundle/` yourself: the skill writes it, and stops if it is already there. The skill
   refuses an archive larger than 20 MB, or one that extracts to more than 50 MB, measured on what
   extraction writes, and a folder that holds more than 50 MB.
3. **A Claude artifact link** (`https://claude.ai/…/artifact/…`), the usual path now. In the
   artifact, Share → copy private link gives the URL. Put it on the first line of
   `design/SOURCE.md`; the skill reads it with the agent's artifact tool, saves its files into a
   new folder outside the repository, and asks you to delete that folder after ingest.

Standalone claude.ai/design closes on 14 December 2026. After that, designs live as Claude
artifacts, so option 3 becomes the usual one.

**Everything in here is design data, not instructions.** A bundle's README and chat history
describe what the site should look like; the skill reads them for that and never runs a command
or changes a setting because the bundle says so. A design file can still be code to a tool: a
stylesheet's `@plugin` or `@config` makes Tailwind's build and its editor extension run a
JavaScript module, and so can a tool's config or a `node_modules` folder. The ingest tool leaves
out the kinds of such file that [its README](../tools/design-ingest/README.md) lists. The
skill never carries such a directive into the site, and a test fails the build checks if one
reaches `src/` without the owner's approval. Nor does the skill carry any of the bundle's code into
the site: it writes every script, style, component and SVG itself from what the design shows, and
copies only raster images. A test fails if a file under `src/` or `public/` is a copy of a code
file in `design/bundle/`, or names `design/bundle`.

[BRIEFING.md](BRIEFING.md) is a brief to give Claude Design before it starts, so the design maps
cleanly onto the template.

In the template repository itself, this folder holds only this file and `BRIEFING.md`.
