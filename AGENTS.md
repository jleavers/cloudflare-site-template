# AGENTS.md

Rules for AI coding agents working in this repository. Claude Code reads this file through
`CLAUDE.md`. Other agents read it directly.

## What this repository is

A template for small marketing sites: an **Astro 7** static site styled with **Tailwind CSS 4**,
served by a **Cloudflare Worker** with static assets, with one dynamic route: the contact form at
`POST /api/contact`. `docs/superpowers/specs/2026-10-12-cloudflare-site-template-design.md` is
the design; read its §5 (contracts) and §7 (the form) before changing either.

| Path | What it is |
|---|---|
| `src/config/site.ts` | Site-wide facts: name, URL, navigation, contact, legal, privacy |
| `src/styles/global.css` | Design tokens (`@theme`) |
| `src/layouts/BaseLayout.astro` | `<head>`: SEO, OpenGraph, fonts, JSON-LD |
| `src/components/` | Page sections; `ContactForm.astro` carries contract C5 |
| `src/pages/` | Pages, and the copy they pass to sections |
| `src/scripts/contact-form.ts` | The form's behaviour (lazy Turnstile, submit, states) |
| `src/contact/` | The portable form handler (C6) |
| `src/worker.ts` | The only Cloudflare-specific code |
| `wrangler.jsonc` | Worker config: name, vars, previews, custom domain |
| `tests/` | `unit/`, `dist/` (contracts on the build), `e2e/` (Playwright), `preflight/` |
| `tools/design-ingest/` | The only way a design enters `design/bundle/` (new-site step 2) |
| `tools/screenshots/design.mjs` | The only renderer for a design screen (`capture.mjs --only screen`) |
| `SITE_BRIEF.md`, `design/` | A site's inputs; see `.claude/skills/new-site/SKILL.md` |

## Contracts

Every site built from this template keeps these, whatever its design. Tests enforce them; a
change that needs one of those tests weakened is the wrong change.

- **C1 — One home per fact.** Design tokens live only in `src/styles/global.css` (`@theme`).
  Site-wide facts live only in `src/config/site.ts`. Page copy lives in the page files and
  reaches sections as props.
- **C2 — Self-hosted assets.** Fonts come through the Astro Fonts API (`astro.config.mjs`
  `fonts`), never a font host's stylesheet. Raster images live in `src/assets/` and render
  through `<Image>` or `<Picture>`.
- **C3 — No client framework.** No React, Vue, Svelte, Preact, Solid, Alpine.js or UI component
  library (shadcn, MUI, …). No third-party script except Turnstile, and the Cloudflare Web
  Analytics beacon when `site.analytics.cloudflareToken` is set. Interactions use HTML (`<details>`,
  anchors), CSS, and small bundled `<script>` modules.
- **C4 — Every page through `BaseLayout`,** with a title and a description, and exactly one `h1`.
- **C5 — The contact form's hooks are fixed.** Restyle and re-word `ContactForm.astro` freely,
  but keep `form[data-contact-form]`, `action="/api/contact"`, `method="post"`, the fields
  `name`, `email`, `message` and `_gotcha`, `[data-turnstile]`, `[data-submit]`, `[data-status]`,
  `[data-error-for]`, the `noscript`, and the script import.
- **C6 — The handler stays portable.** `src/contact/**` uses Web-standard APIs only (`Request`,
  `Response`, `fetch`, `FormData`, `URL`) and imports nothing from outside `src/contact/`. Do not
  add KV, D1, Durable Objects or any other Cloudflare binding unless explicitly instructed.
- **C7 — Example values never reach a live site.** `npm run preflight` allows the template's
  example values, and a design's `[bracketed]` placeholders left in the built pages, on a
  workers.dev demo that delivers only to `log`. It refuses them once `wrangler.jsonc` has a custom
  domain or sets `DELIVERY_PROVIDER` to `resend`, `slack` or `teams`. CI runs it, after building,
  before every deploy. The handler backs it up: it refuses a Turnstile test secret with any
  provider but `log`, and a form posted from a cleartext origin that is not loopback.

## Rules

- **No unapproved dependencies.** Ask before adding any package, and never one C3 forbids. Once
  the owner approves a Tailwind plugin and it is installed properly, its module name goes in
  `APPROVED_TAILWIND_MODULES` in `tests/unit/contracts.test.ts`: that is the sanctioned edit, not a
  weakened contract.
- **npm runs no install scripts here.** `.npmrc` sets `ignore-scripts=true`. Never turn scripts
  back on, with a flag or an environment variable, and add no `pre` or `post` hook script: npm
  would skip it (`tests/unit/supply-chain.test.ts` checks all three).
- **Read tokens and facts, don't restate them.** A colour in a component is a bug; so is the
  site name typed into a page.
- **Enabling Cloudflare Web Analytics** means setting `site.analytics.cloudflareToken` *and*
  adding `https://static.cloudflareinsights.com` to `script-src` and
  `https://cloudflareinsights.com` to `connect-src` in `public/_headers`.
- **Never commit a secret.** `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY` and `WEBHOOK_URL` are Worker
  secrets the owner adds in the Cloudflare dashboard (the Worker → Settings → Variables and
  Secrets); local experiments use a gitignored `.dev.vars`. The Turnstile test keys in the template
  are public and pass every check, which is why they are allowed.
- **Every deploy goes through CI**, a site's first included: its build never holds the Cloudflare
  token, and its token job runs no code from the lockfile. Add no Deploy to Cloudflare button, no
  Workers Builds and no local deploy, and never put a Cloudflare login or API token on a machine
  that runs the site's build or dev server: each would run the lockfile's code beside a
  credential that can change every Worker on the account (README "Cloudflare API token").
- **Never call the live site's `/api/contact`, Resend, Slack, Teams or the Cloudflare API** to
  test something. `npm run preview` and the e2e tests use `log` delivery and test keys.

## Verification

Before finishing any change, run `npm run verify` (type check, unit tests, build, dist
contracts). After touching `ContactForm.astro`, `src/scripts/`, `src/worker.ts`, `src/contact/`
or `tools/screenshots/`, also run `npm run test:e2e`. If its design-fence tests refuse because
Chromium's sandbox cannot start, tell the owner, whose fix it is (`tools/screenshots/README.md`),
and change no test. After a visual change, run `npm run lighthouse`.

## Stamping out a new site

Use the `new-site` skill: `.claude/skills/new-site/SKILL.md`. Agents other than Claude Code read
that file and follow it.

## Working on the template itself

In `jleavers/cloudflare-site-template` itself (not a site made from it): keep the example site
fictional ("Example Co.", example.com) and every test green; update the README runbook in the
same change as any step it describes; regenerate the README media (`tools/screenshots/README.md`)
when the example site's look changes.

Before a release, and before making the repository public, the owner runs the security sweep
(`.claude/skills/security-sweep/SKILL.md`), with `lanes: baseline` and then `lanes: public`.

<!-- Everything below is the original operational rule set, unchanged. -->

## Environment

The repository is used from both **Windows** and **Linux** hosts. Detect the OS before running shell commands:

- **Windows** (PowerShell): `$env:OS` contains `"Windows_NT"`, or `uname` is unavailable.
- **Linux / macOS** (Bash): `uname -s` returns `"Linux"` or `"Darwin"`.

Adapt behaviour accordingly:

| | Windows (PowerShell) | Linux / macOS (Bash) |
|---|---|---|
| Shell / tool | PowerShell | Bash |
| Script extension | `.ps1` | `.sh` |
| Line continuation | `` ` `` (backtick) | `\` (backslash) |
| Command chaining | `;` | `&&` |

Never generate `.sh` scripts when on Windows; never generate `.ps1` scripts when on Linux/macOS.

## Command Chaining

Chain commands using the separator appropriate to the detected host OS:

- **Windows (PowerShell):** `command1 ; command2`
- **Linux / macOS (Bash):** `command1 && command2`

## Git Workflow

Allowed commands:
- git add
- git commit
- git push (feature branches only — see rules below)
- PR creation via the REST API, to open a PR for human review after pushing a feature branch.

Rules:
- Agents **must never** push directly to `main`.
- Agents **may** push a feature branch and open a GitHub PR for human review, using the REST API as above.
- All agent-initiated PRs must target `main` and include a clear summary of changes.
- Agents must not merge or close PRs — that is a human action.

## Pre-Commit Configuration

Ensure `.pre-commit-config.yaml` exists.

Required base hooks:
https://github.com/pre-commit/pre-commit-hooks

Hooks required:
- trailing-whitespace
- end-of-file-fixer

## Terraform

If `.tf` files exist, add hooks from:

https://github.com/antonbabenko/pre-commit-terraform

Required:
- terraform_fmt
- terraform_validate
- terraform_tflint

## Destructive Commands

Agents must never execute destructive commands including:

- rm -rf
- git reset --hard
- git clean -fd
