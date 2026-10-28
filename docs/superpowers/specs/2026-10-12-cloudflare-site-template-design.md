# cloudflare-site-template: design spec

- **Date:** 2026-10-12
- **Status:** awaiting review
- **Refines:** [`docs/PRD.md`](../../PRD.md). Where this spec and the PRD differ, this spec wins; §2 lists every difference and why.

## 1. Intent

**What the owner said.** A reusable GitHub template repository for rapidly deploying simple websites to Cloudflare. Each new site takes three inputs:

1. this template;
2. the site's output from Claude Design;
3. some simple content specific to the site.

The output is a working site. Once the template is working and tested, the repository becomes public to help others.

**Confirmed assumptions.**
- A site is mostly one landing page plus privacy and 404 pages, with one contact form.
- Stamp-outs are driven with Claude Code.
- "Tested" means automated tests plus at least one real site stamped out on the owner's Cloudflare account.
- The end-to-end test uses a throwaway site.

**Decisions taken in brainstorming.**
- **The design is the source of truth (option A).** A site follows its Claude Design output. The template's page sections are working examples the agent may rewrite. What the template guarantees is the infrastructure: SEO, the contact form and Worker, CI/CD, performance, and tests. Those guarantees live in executable contracts (§5), not in components.
- **The design-to-site step is packaged as a skill, a brief and contract tests (option 1).**
  - A `new-site` skill walks an agent through ingesting the design and a `SITE_BRIEF.md`.
  - Contract tests on the built site catch anything a rewrite breaks.
  - The skill is plain Markdown, so agents other than Claude Code can follow it.
- **Delivery providers for v1:** Resend, and Slack or Teams webhooks.
- **Licence:** Apache-2.0, matching the owner's other public repos (`codervis`, `issuebot`).
- **CI runners:** the `jleavers/ci-runners` conventions. Browser tests run in CI on the self-hosted Linux VM, after Chromium's system libraries are added to it.
- **A live demo is part of v1** (§14). The template's example site, with fabricated content, deploys from this repo to workers.dev. A new user can get the same site live on their own account straight away, with "Use this template" plus CI's two secrets. Every deploy goes through CI: there is no "Deploy to Cloudflare" button and no local deploy (D22, §10).
- **A security sweep runs before the repository goes public** (§18). It is the Claude Code workflow from `jleavers/codervis`, ported with lanes for this repository, as was done for codervis and issuebot before they went public.
- **Dependabot** keeps the SHA-pinned actions and hooks and the exact npm versions current (§10).
- **The demo runs on a separate, free Cloudflare account** used for nothing else. The token this public repo holds can then reach only the demo, never the owner's real sites.
- **README media is part of v1** (§14). Screenshots, a GIF of the form flow, a social preview and a LinkedIn header are captured from the example site, in the style of `issuebot` and `codervis`.

**Success criteria.**
1. On the owner's account, a throwaway site goes from `gh repo create --template` to a live URL by following the README runbook. The mechanical steps take under 5 minutes, excluding one-off provider setup.
2. That site's contact form delivers a real message in production, and on a PR preview delivers nothing while still showing success.
3. The template's own CI is green on GitHub-hosted runners once the repository is public, and every push to `main` redeploys the live demo.
4. Lighthouse scores the example site at 100 for performance when run locally.
5. A new user who uses this template, stores CI's token and account ID, and pushes gets a live copy of the demo from CI, with no Worker secrets to enter.

## 2. Differences from the PRD

| # | PRD | This spec | Why |
|---|---|---|---|
| D1 | Astro 5.x | Astro 7.3.x, Node ≥ 22.12 (CI and `.nvmrc` use 24), TypeScript pinned `^6` | Astro 7 is current (7.0 shipped 2026-06-22). `@astrojs/check` does not support TS 7. |
| D2 | `assets` has no `binding` | `"binding": "ASSETS"` plus `run_worker_first: ["/api/*"]` and `not_found_handling: "none"` | Without the binding, `env.ASSETS` is undefined and the Worker cannot serve a miss. With `"404-page"` the asset layer answered a miss itself, and `_headers` (matched by path) made a missing `/_astro/` file cacheable as immutable for a year; with `"none"` a miss reaches the Worker, which serves `404.html` as a 404 with `no-store`. |
| D3 | `ALLOWED_ORIGIN` var | `Origin` must equal the request's own origin | A fixed origin rejects previews, workers.dev and local dev. Same-origin also removes a per-site edit. |
| D4 | PR previews on version URLs | Cloudflare Previews (`wrangler preview --name pr-<n>`), deleted when the PR closes | Cloudflare discourages version URLs for PR testing. Version URLs also share production secrets, so a preview form would send real mail. |
| D5 | Graceful non-JS form fallback | Submit stays disabled without JS, and a `<noscript>` note offers an email address | Turnstile needs JS, so a no-JS post can never pass verification. |
| D6 | SES, Resend or webhook | Resend, Slack, Teams, plus `log` for previews and local dev | Owner's choice. SES would need SigV4 signing. |
| D7 | `EMAIL_API_KEY` | `RESEND_API_KEY` | Only Resend uses a key now. |
| D8 | Handler of about 60 lines in `worker.ts` | `worker.ts` holds only Cloudflare-specific code (about 30 lines). The portable logic lives in `src/contact/` (about 200 lines). | Turnstile, validation and three providers do not fit in 60 lines. The split keeps the portability promise checkable. |
| D9 | Status codes 200, 400, 429, 500 | 200, 400, 403, 405, 413, 500, 502, 503. No 429. | Nothing could produce 429 without a proprietary binding. Turnstile does the throttling. |
| D10 | Theme tokens in `site.ts` and in `global.css` | Tokens only in `global.css` `@theme` | Tailwind v4 reads tokens from CSS. One home per fact. |
| D11 | Recipient email in `site.ts` and in wrangler vars | Only in the wrangler var `CONTACT_TO_EMAIL` | Only the Worker needs it. |
| D12 | `CLAUDE.md` symlinked to `AGENTS.md` | `CLAUDE.md` is the single line `@AGENTS.md` | Git symlinks break on Windows without Developer Mode. |
| D13 | Alpine.js optional | No Alpine.js. The mobile menu is `<details>`, and the form script is plain JS. | One dependency fewer, and no client runtime. |
| D14 | `deploy.yml` | `ci.yml`, with jobs `verify`, `e2e`, `deploy`, `preview-build`, `preview`, `preview-cleanup` | It does more than deploy (§10). |
| D15 | Org-level GitHub secrets | Per-repo secrets set with `gh secret set` | `jleavers/` is a personal account, which has no account-level Actions secrets. |
| D16 | API token: Workers Scripts:Edit plus Account Settings:Read | The same token, held by CI, makes every deploy, a site's first included. A custom-domain site's token adds Zone → Workers Routes → Write (the dashboard's Edit), scoped to that site's zone only. | This token is enough to create and deploy a workers.dev Worker and to deploy previews (shown by the demo deploy). A deploy that adds, changes or removes a custom domain needs Workers Routes Write on each affected zone (Cloudflare, "Workers roles and permissions"). A first deploy from the owner's machine would run the lockfile's code beside a login or token, so there is none (§10). |
| D17 | `public/robots.txt` | `src/pages/robots.txt.ts`, generated from `site.url` | Removes a per-site edit, because the `Sitemap:` line needs the absolute URL. |
| D18 | Google-hosted fonts are implied | Astro Fonts API, self-hosted at build time | Better performance, and no third-party requests. |
| D19 | "Lighthouse 100" with Turnstile on the page | Turnstile loads only when the form nears the viewport | Third-party JS on first load would cost the score. |
| D20 | (absent) | Claude Design ingestion: `design/`, `SITE_BRIEF.md`, the `new-site` skill | This is the owner's actual workflow. |
| D21 | (absent) | Unit, contract and browser tests, plus Lighthouse assertions | A public template needs them, and option A makes them the only guardrail. |
| D22 | (absent) | A live demo of the example site on workers.dev, deployed by CI. No "Deploy to Cloudflare" button. | The demo shows a new user the site at once, and gives the README something to link to and capture. The button is gone because its build runs the lockfile's code beside an account token (§10). |
| D23 | (absent) | README screenshots and GIF, social preview and LinkedIn header, made by `tools/screenshots/` | Matches the owner's other public repos. |

## 3. Architecture

```
Browser ──► Cloudflare edge
              │
              ├─ path matches a file in dist/ ─────────────► static asset (free, no Worker)
              │
              └─ /api/* or no matching file ──► src/worker.ts   (Cloudflare-specific code)
                                                  │
                    POST /api/contact ────────────┤──► handleContact(request, env, deps)      src/contact/
                                                  │      ├─ turnstile.ts ──► challenges.cloudflare.com siteverify
                                                  │      ├─ validate.ts
                                                  │      └─ providers/{resend,webhook,log}.ts ──► api.resend.com | Slack | Teams
                    anything else ────────────────┴──► env.ASSETS.fetch(request)   (a miss: the 404 page, status 404, no-store)
```

- **Build:** Astro in static output mode produces plain HTML and CSS in `dist/`, plus a few small bundled scripts for the form.
- **Runtime:** one Worker, whose entry is `src/worker.ts`. A miss is a Worker invocation (`not_found_handling: "none"`), so bot probes of missing paths count toward the Workers request quota.
- **Portability:** `src/contact/` uses only `Request`, `Response`, `fetch`, `FormData`, `URL` and `AbortSignal`. It never imports from `src/worker.ts` or anything Cloudflare-specific. The unit tests run it on plain Node, which proves that.

## 4. Repository layout

```
.claude/README.md                  what ships under .claude/, and why there is no settings.json
.claude/agents/sweep-*.md          one tool profile per security-sweep stage (§18)
.claude/skills/new-site/SKILL.md   stamp-out procedure: design + brief → site → verify
.claude/skills/security-sweep/SKILL.md  how the owner runs and audits the sweep (§18)
.claude/workflows/security-sweep.js     the sweep: recon, lanes, refuters, triage, report (§18)
.github/dependabot.yml             monthly grouped npm, Actions and pre-commit updates (§10)
.github/workflows/ci.yml           verify · e2e · deploy · preview-build · preview · preview-cleanup
design/README.md                   where a site's Claude Design handoff goes (committed, never built)
docs/PRD.md                        original requirements
docs/images/                       README media (§14.3)
docs/superpowers/{specs,plans}/    this spec and the implementation plan
public/
  _headers                         security and cache headers for static assets
  favicon.svg
  og-default.png                   1200×630 fallback OpenGraph image
scripts/
  dev-stack.mjs                    builds with the test site key, then runs `wrangler dev` with test vars (§7.5)
  lighthouse.mjs                   drives Lighthouse 13 in local or CI mode (§11.4)
  test-keys.mjs                    Turnstile's published always-pass test keys
  trusted-config.mjs               run by CI's token jobs from the trusted ref: refuses a custom build, reads the wrangler pin (§10)
src/
  assets/                          images processed by <Image>
  components/                      Header Hero Features Testimonials FAQ ContactForm Footer DemoNotice (.astro)
  config/site.ts                   site-wide facts (§6.1)
  contact/
    handler.ts                     handleContact(request, env, deps): the pipeline in §7.3
    config.ts                      ContactConfig type, and readConfig() from a plain env object
    validate.ts                    pure field validation
    turnstile.ts                   siteverify call
    logger.ts                      one-JSON-line-per-event logger
    http.ts                        json() response helper
    providers/types.ts             Provider, DeliveryContext, DeliveryError, postJson()
    providers/format.ts            the plain-text message layout
    providers/resend.ts
    providers/webhook.ts           slack | teams
    providers/log.ts               previews and local dev: logs shapes, sends nothing
    providers/index.ts             provider name → implementation
  layouts/BaseLayout.astro         <head>: SEO, OpenGraph, canonical, JSON-LD, fonts, optional analytics
  pages/
    index.astro  privacy.astro  404.astro
    robots.txt.ts
  scripts/contact-form.ts          the form's behaviour: lazy Turnstile, submit, states (C5)
  styles/global.css                Tailwind import, and @theme: the only home for design tokens
  worker.ts                        Env type, /api routing, ASSETS fallback
tests/
  unit/                            vitest: contact/*, worker routing
  dist/                            vitest: contract tests on the built dist/
  preflight/                       vitest: "is this still the template?" checks
  e2e/                             Playwright: browser tests against `wrangler dev`
  sweep/                           vitest: the security-sweep engine, relay fence, shipped files (§18)
tools/design-ingest/               ingest.mjs: the only way a design bundle reaches design/bundle/ (§6.3)
tools/screenshots/                 README media capture: capture.mjs, layouts.mjs, README.md (§14.3); design.mjs and fence.mjs: the only renderer for a design screen (§6.3); playwright-chromium.apparmor: the profile that lets Chromium's sandbox start on Ubuntu 23.10 and later
.nvmrc                             24
AGENTS.md                          rules for AI agents (§12)
CLAUDE.md                          @AGENTS.md
LICENSE                            Apache-2.0
README.md                          what this is, and the stamp-out runbook
SECURITY.md                        private vulnerability reporting, and what is in scope
SITE_BRIEF.md                      per-site facts and copy; the template's copy describes the example site
astro.config.mjs  lighthouse-budgets.json  package.json  playwright.config.ts  tsconfig.json
vitest.config.ts  wrangler.jsonc
```

## 5. Contracts

Every stamped-out site must satisfy these, whatever its design. AGENTS.md states them all, and the tests named here enforce them.

| # | Contract | Enforced by |
|---|---|---|
| C1 | Design tokens live only in `src/styles/global.css` (`@theme`). Site-wide facts live only in `src/config/site.ts`. Page copy lives in the page files and is passed to sections as props. | AGENTS.md; skill |
| C2 | Fonts are self-hosted through the Astro Fonts API. Raster images go through `<Image>`, from `src/assets/`. | dist: every URL a built page or stylesheet can fetch or connect to (`src`, `srcset`, `href` but on `<a>` and `<area>`, `poster`, `data`, `action`, `formaction`, `ping`, `xlink:href`, a meta refresh, and `url()` and `@import` in a `style` attribute, a `<style>` or a CSS file) resolves to the site's own origin, but a `data:` image and the script hosts C3 allows; an attribute name repeated on one element is refused, since a browser reads only the first; every `<img>` has `width`, `height` and `alt`, and a `src` under `/_astro/` or exactly `/favicon.svg` |
| C3 | No client framework. No third-party scripts except Turnstile, and the Cloudflare Web Analytics beacon when it is enabled. | dist: script `src` allow-list; package.json has no react, vue, svelte, preact, solid or alpinejs |
| C4 | Every page renders through `BaseLayout`. | dist: every HTML page has `<title>`, meta description, canonical, `og:title`, `og:description`, an absolute `og:image` URL and `lang` |
| C5 | `ContactForm` markup may be restyled, but its contract is fixed: `form[data-contact-form]`, `action="/api/contact"`, `method="post"`, fields `name`, `email`, `message`, `_gotcha` (hidden), a `[data-turnstile]` container, a `[data-status]` live region, and the bundled submit script. | dist checks the structure; e2e checks the behaviour |
| C6 | The worker stays portable: `src/contact/**` uses only Web-standard APIs, and no KV, D1, Durable Objects or other proprietary bindings are added unless explicitly instructed. | unit tests on Node; a test asserts no `cloudflare:` imports in `src/contact` |
| C7 | The template's example values, and a design's `[bracketed]` placeholders, may be deployed to a workers.dev demo that delivers only to `log`, which is how the demo works, but never to a live site: one whose `wrangler.jsonc` has a custom domain or sets `DELIVERY_PROVIDER` to `resend`, `slack` or `teams`. The handler adds two refusals: a Turnstile test secret with any provider but `log`, and a form posted from a cleartext origin that is not loopback. | `npm run preflight` (§11.3), run by CI's `verify` job, which the `deploy` job needs; unit tests on `readConfig` and `handleContact` |

## 6. Site configuration and inputs

### 6.1 `src/config/site.ts`

```ts
export interface NavLink { label: string; href: string }
export interface SiteConfig {
  name: string;               // "Example Co."
  title: string;              // default <title>; pages may override
  description: string;        // default meta description
  url: string;                // "https://example.com": canonical origin, no trailing slash
  locale: string;             // "en-GB": <html lang>, og:locale
  nav: { header: NavLink[]; footer: NavLink[] };
  contact: {
    turnstileSiteKey: string;    // public key
    successMessage: string;
    fallbackEmail?: string;      // shown in <noscript> and in error messages
  };
  socials: NavLink[];
  legal: {
    companyName: string;
    registration?: string;       // e.g. "Registered in England & Wales no. 01234567"
    address?: string;
    privacyEmail: string;
  };
  privacy: {                     // drives the privacy page
    processors: { name: string; purpose: string; url: string }[];
    retention: string;
  };
  analytics: { cloudflareToken?: string };  // Cloudflare Web Analytics beacon token
}
export const site: SiteConfig = { /* the example site's values */ };
```

- `astro.config.mjs` imports `./src/config/site.ts` to set `site:` for canonical URLs and the sitemap.
- The copyright year is computed at build time.
- `ContactForm` uses `import.meta.env.PUBLIC_TURNSTILE_SITE_KEY` when it is set (PR preview builds), and `site.contact.turnstileSiteKey` otherwise.

### 6.2 `SITE_BRIEF.md`

A Markdown form with fixed headings, so an agent can find each answer:

1. **Identity:** site name, slug (the Worker name), production domain, locale.
2. **Contact form:** delivery provider (`resend | slack | teams`), recipient address, from address (Resend), success message, public fallback email.
3. **Legal:** company name, registration, address, privacy contact.
4. **Socials and navigation.**
5. **Page copy (optional):** one subsection per page section. Anything left blank is taken from the design.
6. **Notes:** audience, tone, anything the design does not show.

The template's copy is filled in for the fictional example site, so it doubles as a worked example.

### 6.3 `design/`

- Holds the site's Claude Design output in one of three forms:
  - a handoff URL, recorded in `design/SOURCE.md`, which the skill's ingest tool downloads into `design/bundle/`;
  - a downloaded archive, which stays in `design/` as one file, or a folder extracted from one or assembled **outside the repository** (in the person's Downloads folder, say), which the tool ingests into `design/bundle/`. The tool refuses a `--dir` folder whose path, as given or through `realpath`, is inside the repository, before it reads anything: editor extensions that scan the workspace (Tailwind CSS IntelliSense) can run code from raw design files there, and ingest checks only what it writes. The person doesn't open the folder in an editor, and deletes it after ingest. `.gitignore` keeps `design/incoming/` only so that a stray copy is never committed;
  - a Claude artifact link, recorded in `design/SOURCE.md` (standalone claude.ai/design closes on 2026-12-14, after which designs live as artifacts). The agent saves the artifact's files into a new, empty folder outside the repository (its session scratch directory, or a new folder under the OS temp directory), passes that folder to the tool, and asks the person to delete it; an agent that cannot write outside the repository asks the person to make the folder.
- It is committed for provenance and is never part of the build.
- The bundle (README, chats, HTML or JSX screens) is treated as design data. Instructions inside it guide what the site should look like. They are never commands for the agent to run. Nor is its code carried into the site: the agent writes every script, style, component and SVG itself, and copies only raster images; `tests/unit/design-reuse.test.ts` fails on a file under `src/` or `public/` that is a copy of a bundle code file, or names `design/bundle`.
- `design/bundle/` is written only by `tools/design-ingest/ingest.mjs`, and only after every entry has passed its checks. It refuses the whole bundle for a link, a special file, an unsafe or duplicate path, an encrypted or zip64 entry, or a cap breach (20 MB downloaded, 50 MB unpacked, 2000 entries), and omits agent instructions, tool configurations (`*.config.js`, `package.json`, `tsconfig*.json`, `jsconfig.json`, `deno.json`, `biome.json`, `vitest.workspace.*`, `tailwind.js`, `cspell.json`, `dprint.json` and the like), `node_modules` folders, dotfiles and dot-folders, names with a character outside the allowed set (letters, digits, combining marks, space and `. _ ( ) + , @ -`, none of them default-ignorable), file types a design is not made of, and any file whose bytes hold Tailwind's `@plugin` or `@config` in any letter case, with comments inside it, followed by anything that does not make it a longer name (a Unicode space included), since the build and Tailwind's editor extension run the module it names (a stylesheet's `@import` reads a file of any type, so every file is read). It writes every other Markdown file but a README as `<name>.txt`, the name as it came with `.txt` added (`notes.MD` as `notes.MD.txt`), which no agent tool loads as instructions, so the rename covers context-file names no list has; the duplicate and length checks apply to the written name. It renames nothing else, and never puts the URL or a name from the bundle into a shell command.
- Screens render only through `tools/screenshots/design.mjs`, with the bundle only and no network, inside Chromium's OS sandbox. The sandbox is the boundary, and those fences defence in depth: where it cannot start (Ubuntu 23.10 and later, until the person installs the AppArmor profile `tools/screenshots/playwright-chromium.apparmor`), the renderer refuses, and never renders without it. JavaScript runs, but a screen loads only files inside its bundle directory, judged by resolved path, and reaches nothing else, by fetch, WebSocket, WebRTC or prefetch, since its browser resolves no host and has only a proxy that goes nowhere. The skill runs it as `capture.mjs --only screen`. A screen is never served from a local server, which would let its script read every file under the server's root, nor opened as a bare `file://` page, which can show any local file in a frame.

### 6.4 Content precedence

The brief wins over the design, and the design wins over the template's example content.

## 7. Contact form

### 7.1 Browser: `ContactForm.astro`

- **Markup:** a `<form>` that meets C5, with `required`, `type="email"` and `maxlength` attributes matching the server limits.
- **Honeypot:** `_gotcha` is visually hidden, `tabindex="-1"` and `autocomplete="off"`.
- **States:** the form's state is held in `data-state` on the form: `idle | sending | sent | error`. Messages go into the `[data-status]` live region (`role="status"`). Styling keys off `data-state`, so a redesign never edits the script.
- **Lazy Turnstile:**
  - An `IntersectionObserver` with a 200px `rootMargin`, or the first `focusin` on the form, injects `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` once.
  - It then calls `turnstile.render('[data-turnstile]', { sitekey, callback, 'expired-callback', 'error-callback' })`.
  - The submit button starts `disabled`. The callback enables it.
- **Submit:**
  - `fetch('/api/contact', { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })`.
  - On `ok`, the state becomes `sent`, the form resets and `turnstile.reset()` runs.
  - On an error, the state becomes `error`, the response `message` is shown, per-field `errors` are attached to the fields with `aria-invalid` and `aria-describedby`, and `turnstile.reset()` runs.
  - On a network failure, a generic message mentions `fallbackEmail` if it is set.
- **No JS:** the button stays disabled, and a `<noscript>` paragraph says the form needs JavaScript and gives `fallbackEmail` if it is set.

### 7.2 Worker: `src/worker.ts`

```ts
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DELIVERY_PROVIDER?: string; CONTACT_TO_EMAIL?: string; CONTACT_FROM_EMAIL?: string;
  TURNSTILE_FAIL_OPEN?: string; TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string; WEBHOOK_URL?: string;
}
```

The worker defines its own minimal `Env`, with no generated Workers types, so one tsconfig covers everything. Routing:

- `/api/contact` with `POST` calls `handleContact(request, env, { fetch })`.
- `/api/contact` with any other method returns 405 and `Allow: POST`.
- Any other `/api/*` path returns 404 JSON.
- Everything else returns `env.ASSETS.fetch(request)`.

### 7.3 Handler pipeline: `handleContact(request, env, deps)`

Every response is JSON: `{ ok: boolean, message: string, errors?: Record<string, string> }`, with `Cache-Control: no-store`.

| Step | Check | On failure |
|---|---|---|
| 1 | The `Origin` header equals `new URL(request.url).origin`, and the request URL is `https:` or its host is loopback (`localhost`, `127.x.x.x`, `[::1]`) | 403 "Forbidden" |
| 2 | `Content-Type` is `multipart/form-data` or `application/x-www-form-urlencoded`, and the body is ≤ 32 KB (checked on `Content-Length` and on the bytes actually read) | 400, or 413 when too large |
| 3 | `_gotcha` is empty | **200** `{ ok: true }`. Nothing is sent and the request is logged as spam. |
| 3a | Config: `readConfig(env)` succeeds (it also refuses a Turnstile test secret, `/^[123]x0{31}[A-Z]{2}$/`, with any provider but `log`) | 500, generic message, detail logged |
| 4 | Turnstile siteverify `POST`s `secret`, `response` (`cf-turnstile-response`) and `remoteip` (`CF-Connecting-IP` when present), with a 5 s timeout | Token missing or `success: false`: 403. Siteverify unreachable, timed out or 5xx: 503, unless `TURNSTILE_FAIL_OPEN === "true"`, which logs a warning and continues. |
| 5 | Validate after trimming, by whole Unicode categories: Cc is the C0 and C1 controls and DEL (NEL included), Cf the format characters (bidi controls, zero-width characters, the soft hyphen, tag characters), and Zl and Zp are U+2028 and U+2029. `name` is 1–100 characters, holds at least one letter (`\p{L}`), and is refused if it holds any Cc, Zl or Zp character; any Cf character but ZWNJ and ZWJ (U+200C, U+200D), which Persian and Indic names need; any other default-ignorable code point (U+034F, the Hangul fillers, unassigned ones) but the variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF) and the Mongolian free variation selectors (U+180B–U+180F); or more than 8 combining marks in a row. `email` is ≤ 254 characters, is refused if it holds any Cc, Cf, Zl or Zp character, and is a bare address: a dot-atom local part, `@`, and two or more domain labels, where letters, marks and digits may be non-ASCII. It has no quoted local part, comment, display name, angle brackets, group or list, so no whitespace, comma, semicolon or colon. Neither the name nor the email may hold `=?`, which opens an RFC 2047 encoded-word that a mail client would decode in the subject or Reply-To. `message` is 1–5,000 characters, measured after `\r\n` and a lone `\r` become `\n` and these are stripped, never refused: Cc but `\n` and `\t`, Zl, Zp, and the bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). Everything else is kept, ZWJ, ZWNJ, variation selectors and emoji tag sequences included. | 400 with per-field `errors`. An email holding a refused character gets its own error, because the address it hides in can look valid. |
| 6 | Deliver through the provider named by `DELIVERY_PROVIDER` | The provider rejects or is unreachable: 502. |
| 7 | Success | 200 `{ ok: true, message: "Thank you — your message has been sent." }`. The site's own success message is shown client-side. |

`readConfig(env)` validates the config for the chosen provider and lists everything that is missing:

| Provider | Needs |
|---|---|
| `resend` | `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `RESEND_API_KEY` |
| `slack` or `teams` | `WEBHOOK_URL` |
| `log` | nothing |

Every provider needs `TURNSTILE_SECRET_KEY`.

### 7.4 Providers

Each provider is a `Provider`, `(submission, config, { siteHost, fetch, log }) => Promise<void>`, and throws `DeliveryError` when it fails.

Every visitor field reaches the owner, in every channel, as literal text that can neither be read as markup nor change how the site's own text around it displays. Step 5 has already refused or stripped the characters that hide or reorder text. `providers/format.ts` is the one encoder for the rest: it turns a validated submission into each destination's text, and every provider sends what it returns without reading a visitor field itself. One hostile corpus in `tests/unit/contact/providers.test.ts` goes through validation and then through every provider, every field checked, and `tests/unit/contact/encoder-boundary.test.ts` fails a provider that reads a field.

- **resend:** `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and body `{ from, to: [to], reply_to: submission.email, subject: "New enquiry from <name> via <host>", text }`. Plain text only, so there's no HTML-injection surface. The subject and `reply_to` carry the name and the bare address as step 5 left them, so neither holds a control, bidi, zero-width or separator character, and `reply_to` holds no display name, group or list.
- **slack:** `POST WEBHOOK_URL` with `{ text }`. Three things keep each field literal. First, in every field `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`: Slack treats those three as control characters in any text, so this alone stops links and mentions whatever the formatting does, and the payload sets no `link_names`. Second, code formatting stops emphasis: the name and the email each sit in inline code, which Slack documents as applying no other formatting ("Text within inline code blocks will not use any other formatting", [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text)), and the message sits in a multi-line code block, for which the same page gives the syntax but makes no such statement. Third, nothing in a field can end its code: each backtick a visitor typed is shown as `ˋ` (U+02CB), distinct from an apostrophe, and the name and the email hold no newline, because step 5 refuses Cc.
- **teams:** `POST WEBHOOK_URL` with the payload the current Teams incoming-webhook mechanism expects. That is a Workflows webhook taking an Adaptive Card message, and it is verified during implementation (§16). The site's heading is a `TextBlock`. Each visitor field is `TextRun`s in a `RichTextBlock`, because Teams parses a Markdown subset in `TextBlock` and in a fact's title and value, and `RichTextBlock` "does not support markdown" ([Text features](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/text-features)). A run ends between two braces, so no run holds the `{{` that starts a `DATE()` or `TIME()` function.
- **log:** logs the submission's shape and nothing of its content: the email redacted to `j***@domain`, plus the name's and message's lengths. It returns successfully, so a visitor's words never sit in a log.

### 7.5 Config sources

**The template's top-level vars** make the example site deployable with no secrets at all, which is what the live demo and a new user's first CI deploy (§14.2) rely on:

```jsonc
"vars": {
  "DELIVERY_PROVIDER": "log",
  "TURNSTILE_SECRET_KEY": "1x0000000000000000000000000000000AA", // test secret; a real site moves this to a secret
  "TURNSTILE_FAIL_OPEN": "false",
  "CONTACT_TO_EMAIL": "hello@example.com",
  "CONTACT_FROM_EMAIL": "website@example.com"
}
```

**A real site** has the `new-site` skill edit these vars:
- set `DELIVERY_PROVIDER`, `CONTACT_TO_EMAIL` and `CONTACT_FROM_EMAIL` to real values;
- **delete** `TURNSTILE_SECRET_KEY` from `vars`, because a var and a secret cannot share a name.

Once CI's first deploy has created the Worker, the owner adds these in the Cloudflare dashboard (the Worker → Settings → Variables and Secrets), each as type Secret, never from a machine that runs the build (§10):
- `TURNSTILE_SECRET_KEY`;
- `RESEND_API_KEY` or `WEBHOOK_URL`, depending on the provider.

Type Secret matters: a later `wrangler deploy` keeps secrets, but replaces variables set in the dashboard with `wrangler.jsonc`'s. Until the secrets are there, the handler refuses every post, because `readConfig` finds them missing; that is expected.

Preflight (§11.3) refuses a live site (a custom domain, or real delivery) while the test secret is still in `vars`.

**Previews** need no secrets. Previews do not inherit production vars, so `previews.vars` sets everything they read:

```jsonc
"previews": {
  "vars": {
    "DELIVERY_PROVIDER": "log",
    "TURNSTILE_SECRET_KEY": "1x0000000000000000000000000000000AA", // Cloudflare's published always-pass test secret
    "TURNSTILE_FAIL_OPEN": "false"
  }
}
```

PR builds set `PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA`, the always-pass test site key.

**Local:** `scripts/dev-stack.mjs` builds with `PUBLIC_TURNSTILE_SITE_KEY` set to the test key, then runs `wrangler dev --var DELIVERY_PROVIDER:log --var TURNSTILE_SECRET_KEY:<test secret>`.
- `npm run preview`, Playwright's `webServer` and the screenshot tool all use this one script.
- A local run never sends a real message, whatever the site's production config says.
- Anyone who wants to try real delivery locally writes their own `.dev.vars`, with a real Turnstile secret from a widget whose hostnames include `localhost`, because the handler refuses a test secret with any provider but `log`. The README covers this.
- There is deliberately **no `.dev.vars.example`**. `npm run preview` needs no `.dev.vars` (it forces `log` delivery and the test secret). The one reason to write one, trying real delivery locally, puts real secrets in a file that any package the build or dev server runs can read, so the README describes it as an exception, not a step: a restricted, short-lived key, and the file deleted afterwards. A committed example would make that file look routine.

## 8. Styling, fonts, images and headers

- **Tailwind v4** comes through `@tailwindcss/vite`. `global.css` holds `@import "tailwindcss";` and an `@theme` block with the colour palette, font families (bound to the Fonts API CSS variables with `@theme inline`), radii and spacing.
- **Fonts:** the `fonts` array in `astro.config.mjs` uses `fontProviders.google()` or another provider, and Astro downloads the files at build time. `<Font cssVariable=… preload />` goes in `BaseLayout`.
- **Images:** content images live in `src/assets/` and render through `<Image>` or `<Picture>` (WebP or AVIF, with explicit dimensions).
- **Astro 7:** `compressHTML` stays at its default (`'jsx'`), and the skill warns about whitespace between inline elements.
- **`public/_headers`:**
  ```
  /*
    Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: strict-origin-when-cross-origin
    Permissions-Policy: camera=(), microphone=(), geolocation=()
    Strict-Transport-Security: max-age=31536000
  /_astro/*
    Cache-Control: public, max-age=31536000, immutable
  ```
  - The `/_astro/*` immutable rule applies to hashed files that exist. A missing one's 404 is served by the Worker with `Cache-Control: no-store` (and the `/*` security headers), so a browser never keeps it.
  - Enabling Cloudflare Web Analytics adds `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src`.
  - Whether Astro inlines small scripts, which this CSP would block, is verified during implementation (§16).
  - The Worker sets its own headers on `/api/*` responses, since `_headers` applies to static assets only.

## 9. SEO and compliance baseline

- **`BaseLayout` props:** `title?`, `description?`, `ogImage?`, `noindex?`, `jsonLd?`. Output includes:
  - the charset and viewport meta tags;
  - `<title>`, meta description and canonical (`new URL(Astro.url.pathname, site.url)`);
  - OpenGraph and Twitter card tags;
  - `<html lang>`;
  - the favicon;
  - the Fonts API `<Font>` tags;
  - JSON-LD;
  - the analytics beacon when `site.analytics.cloudflareToken` is set.
- **JSON-LD:** the home page emits `Organization` and `WebSite`.
- **Sitemap:** `@astrojs/sitemap`, with 404 excluded.
- **robots.txt:** `src/pages/robots.txt.ts` emits `User-agent: *`, `Allow: /` and `Sitemap: <site.url>/sitemap-index.xml`.
- **Privacy page:** generated from `site.ts` and the brief. It names:
  - the data collected (name, email, message);
  - why it is collected, and the lawful basis (replying to the enquiry);
  - who processes it: Cloudflare (hosting and Turnstile), the delivery provider, and Cloudflare Web Analytics if enabled;
  - retention, which the site owner states;
  - the contact (`legal.privacyEmail`).

  The README notes that the page is a starting point, not legal advice.
- **404 page:** uses `noindex`.

## 10. CI/CD: `.github/workflows/ci.yml`

**Triggers:** `push` to `main`, `pull_request` (`opened`, `synchronize`, `reopened`, `closed`), and `workflow_dispatch`.

**Runners:** every job installs Node itself with `actions/setup-node` and `.nvmrc`. `e2e` and `preview-build` use `runs-on: ${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}`. `verify` uses `runs-on: ${{ github.event_name == 'push' && 'ubuntu-latest' || vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}`: a push (only ever to `main`) builds the artifact that deploys, so it runs on a GitHub-hosted runner, while pull requests and dispatches keep the self-hosted one. The jobs that hold the token (`deploy`, `preview`, `preview-cleanup`) always use `runs-on: ubuntu-latest`. A persistent self-hosted runner keeps its workspaces, tool cache and home directory between jobs, and the other jobs run branch and lockfile code there as the same user. That code could replace `node` or `npx` in `$RUNNER_TOOL_CACHE`, or write `~/.npmrc`, for a token job to run, or for the next `main` build, which would ship its `worker.js` to production beside the Worker's own secrets. Each push to `main` therefore spends hosted minutes on `verify` as well as `deploy`, and a private repository with no hosted minutes left can't deploy that month: its deploys wait until the minutes return. A public repository's hosted minutes are free. That follows the `jleavers/ci-runners` rules: install every toolchain in the job, write only inside the workspace or `$RUNNER_TEMP`, publish no fixed host ports, and remove nothing you didn't create.

**Concurrency** is grouped per workflow and, by event: a pull request by its number (never by ref: a merged PR's `closed` run reports `main` as its ref), a `push` (only ever to `main`) by ref, and any other event, a `workflow_dispatch` run, by event and run ID, so it never shares a group with `main`'s push runs and cannot displace a pending one. Only a pull request's runs cancel one in progress, and only in that pull request's group. YAML cannot stop a fork's pull request, which runs its own workflow file, from naming `main`'s group; the repository's fork-approval setting does (§15 step 4b).

**The deploy gate.** `deploy` runs for a `push` to `main`, and its first step, once the token is present, reads `main`'s head with the job's own `GITHUB_TOKEN` (`gh api repos/<repo>/git/ref/heads/main`). A different SHA from the run's skips every later step with a notice saying to deploy from the newer push's run, or re-run it if it did not deploy; a failed read fails the job, so it never deploys on a check that did not happen. A re-run of an older push run therefore deploys nothing.

**Permissions:** `contents: read` by default. Only the `preview` job adds `pull-requests: write`.

**Supply chain:**
- Every action is pinned to a full commit SHA, with the version in a trailing comment (`uses: actions/checkout@<sha> # v5.0.0`). A moved or compromised tag then cannot change what runs.
- Jobs that receive the Cloudflare token use only GitHub's own `actions/*` and Cloudflare's `cloudflare/wrangler-action`.
- **Those jobs also run no code that the checked-out tree or the lockfile chose.** The boundary is the code executed while the token is present, not only the actions a job `uses:`:
  - no `npm ci`, build, test or preflight, and no wrangler resolved from the lockfile;
  - `wrangler.jsonc`, `.nvmrc`, the wrangler version (`package.json` → `devDependencies.wrangler`, an exact `x.y.z` only) and `scripts/trusted-config.mjs` come from the **trusted ref**, through a sparse checkout (`persist-credentials: false`) into a directory of their own: `github.sha` for `deploy`, and the default branch by name (`refs/heads/<default branch>`) for the previews, never the PR's head, and not its base commit, which goes stale if the PR's base changes;
  - `main`'s `wrangler.jsonc` is therefore part of the trust root, with the workflow: its `assets.directory`, `rules` and `tsconfig` steer what wrangler reads and uploads, so a change to it is reviewed like a change to `.github/workflows/`;
  - `trusted-config.mjs` refuses a `build` key, at the top level or in any `env.*`, because a custom build makes wrangler run a shell command. It also refuses a `__proto__` key, which wrangler's parser would read as an inherited `build`. A unit test applies the same check to the repository's own `wrangler.jsonc` in `npm run verify`. The next step fails the job if the script gave no version, in case it ever exits without running;
  - the site and the Worker bundle come from a tokenless job's artifact, as data. The job copies only `dist/` and `bundle/worker.js` out of it, into a fresh directory under `$RUNNER_TEMP` beside its config, so nothing else an artifact might carry (a `.env`, a `.npmrc`, a `node_modules`) reaches the directory wrangler runs in. That job's code can hold `ACTIONS_RUNTIME_TOKEN` and upload a crafted zip under the artifact's name, and so can any job's JavaScript actions on the self-hosted runner (`e2e` on `main`), which can also replace or delete the run's artifacts. So the builder hands on its upload's `artifact-id` as a job output, and the token job downloads with `artifact-ids:` from it, never by `name:`: a replaced or deleted artifact has another ID, or none, and the download fails. An empty `artifact-ids` would download every artifact in the run, so a step before the download fails unless the ID is non-empty and all digits. download-artifact v8.0.1 (v8 pairs with upload-artifact v7) extracts with `unzip-stream`, which rewrites every `..` path segment to `.`, joins each entry under the target directory and writes regular files only, so no entry lands outside it or becomes a symlink, and a step after the copy stops the job anyway if the site directory holds one, since wrangler `stat()`s, and so follows, each asset; and it fails on a digest mismatch, its default since v8 (v7 only warned). Only `worker.js` ships: a Worker whose bundle has more modules (a `.wasm`, text or data import) fails to deploy until that copy step, and the test that pins it, take them too. Wrangler inlines a dynamic `import()` of a local module into `worker.js`;
  - **"as data" means wrangler uploads `bundle/worker.js` byte for byte, never bundles it again.** Its bundler, esbuild, follows an import in the file to any file on the runner, an extensionless or `/proc` one included (`import x from '/proc/self/environ' with { type: 'text' }` would read the job's token), and inlines it into the Worker it uploads (sweep 20261027T190359Z, cluster 1). `deploy` passes `--no-bundle` and `--upload-source-maps=false`: its `worker.js` comes from `verify`, which runs `main`'s lockfile code, and with `upload_source_maps` on in `main`'s config a `//# sourceMappingURL=` comment in it could name any file on the runner (a JSON file is uploaded as the map; any other fails the deploy with its first bytes in the log; Ruling 96). `wrangler preview` has no `--no-bundle` flag, so the preview job copies no config: `trusted-config.mjs --preview-config` writes `wrangler.json` from the trusted `wrangler.jsonc`, with `no_bundle: true`, `upload_source_maps: false` (without a bundle, wrangler would upload as `worker.js.map` any JSON file with a `sources` array that a `//# sourceMappingURL=` comment in `worker.js` names) and `find_additional_modules: false`, and without `env` (the job targets the top-level Worker, so any environment wrangler were told to target inherits those settings) or `tsconfig` (read only to guess the module format). It refuses what the `build` check refuses, an `assets.directory` other than `./dist`, and a `previews` block holding any of those three settings, `build`, `define` (applied only when wrangler bundles) or `containers` (wrangler builds an image whose path names a file in the site directory, where the artifact's `dist/` is). The file is plain JSON serialised from the script's own parse, so wrangler reads exactly the settings the script checked, whatever its JSONC reader would make of the trusted file. The next step stops the job unless the file exists, so a default branch whose script predates `--preview-config` fails closed, never falling back to a copy. The dashboard's Preview base config cannot turn bundling back on: wrangler 4.149.0 builds the upload from the local config alone, takes anything from the base config into it only for a config with no `previews` block, and then only its bindings, and only at an interactive prompt, which in CI is an error;
  - wrangler-action gets the trusted `wranglerVersion`, `npm_config_ignore_scripts: 'true'` and `npm_config_min_release_age` equal to Dependabot's cooldown (`default-days`, 7). Its own install of that wrangler, about 35 packages resolved with no lockfile, then runs no install scripts and takes no release younger than the cooldown. Every command names its config with `--config` (the trusted `wrangler.jsonc`, or the preview's written `wrangler.json`): without it, wrangler looks for a config beside the entry first.
- **Every job that holds the token runs through an environment** (`production` or `preview`), so that, where the plan allows, the token is an environment secret behind a deployment-branch rule or required reviewers (below).
- No workflow uses `pull_request_target`.
- These rules protect every stamped-out site as well, because each one holds a token that can edit every Worker on its account.
- **They hold on every route, because CI is the only route.** Every deploy of every site goes through this split, a site's first included (store CI's token, push, and `deploy` creates the Worker). There is no "Deploy to Cloudflare" button, no Workers Builds and no `deploy` script: each runs the lockfile's code (npm's install, `astro build`, vite, the lockfile's wrangler) in the build that holds an account token (sweep cluster 3). Worker secrets are set in the dashboard, and the README tells the owner never to keep a Cloudflare login or API token on a machine that runs the site's build or dev server, whose code could read it.
- `tests/unit/ci-workflow.test.ts` holds every workflow file to these rules. It reads them without a YAML parser, so first it requires each file to be in a **canonical block-YAML subset**, naming `file:line` for any line outside it. A workflow holds only printable ASCII and LF, everywhere, comments and block scalars included: no CR (so no CRLF), tab, BOM or NBSP, and none of the other characters at which YAML also breaks a line (NEL, LS, PS), since a line one of them starts would be invisible to a reading that splits on LF. `.gitattributes` (`* text=auto eol=lf`) checks workflows out with LF, even under `core.autocrlf=true`. Indentation is spaces only. Outside block scalars, a line is blank, a comment, `key:` or `key: value` with a bare key, or `- ` followed by one of those or a value. Each nested block sits exactly two spaces under its key, and no mapping repeats a key. The subset refuses quoted keys, a space before the colon, tags, anchors, aliases, complex keys, flow collections, and any backslash in a double-quoted value. `env`, `with`, `secrets`, `outputs`, `services`, `container`, `strategy`, `defaults`, `inputs` and `permissions` must be a bare `key:` with their mapping on the lines below, never a value on the same line, such as an expression (`env: ${{ fromJSON(...) }}`) or `secrets: inherit`, whose entries no line-based check could see. The token jobs have no `container`, `services` or `strategy` at all. Any `secrets` reference in a job, in any form, block-scalar comments included, but `secrets.GITHUB_TOKEN`, makes it a token holder. Top-level keys are limited to `name`, `run-name`, `on`, `permissions`, `concurrency` and `jobs`: no workflow-level `env`, which would reach every job, the token jobs included.
- **The token jobs are pinned whole.** For `deploy`, `preview` and `preview-cleanup`, the test holds the exact job: its keys (an allow-list: `name`, `if`, `needs`, `runs-on`, `environment`, `permissions`, `env` and `steps`); its steps, in order, each by its action at its commit SHA or by its exact script, so none can be added, removed or reordered; every `if`, `id`, `with` and `env` value as written, `github-script`'s script and `PREVIEW_URL` included; and step keys from `name`, `id`, `if`, `uses`, `with`, `env` and `run` only, so no `background`, `continue-on-error` or `timeout-minutes`. Only the names are free. `secrets` may appear in an expression only on the `HAS_CLOUDFLARE` line and in wrangler-action's `apiToken` and `accountId`. Any change to a token job therefore changes the test too, and so does Dependabot's monthly Actions update when it moves the SHA of an action a token job uses: that pull request fails `verify` until the SHA in the test's `TOKEN_ACTIONS` moves with it, after a look at the new commit.

| Job | When | Steps |
|---|---|---|
| `verify` | Every event except `closed` | `setup-node`, with the npm cache on pull requests and dispatches only (`cache: ${{ github.event_name != 'push' && 'npm' \|\| '' }}`, `package-manager-cache: false`), since `e2e` on `main` can save one from the self-hosted runner → `npm ci` → `npm run verify` (check, unit tests, build, dist contracts) → `npm run preflight`. On a push to `main`, then `npx wrangler deploy --dry-run --outdir bundle`, and an upload of `dist/` and `bundle/`, hidden files included (`dist/.well-known/`), as the artifact `site` (one-day retention): the `dist/` that preflight just checked. The upload step's `artifact-id` is the job output `site-artifact-id`. |
| `e2e` | Same as `verify` | `npm ci` → on a GitHub-hosted runner, `PLAYWRIGHT_BROWSERS_PATH` set to `$HOME/.cache/ms-playwright`, where the AppArmor profile looks → `npx playwright install chromium`, adding `--with-deps` when `runner.environment == 'github-hosted'` → on a GitHub-hosted runner whose kernel restricts user namespaces (`kernel.apparmor_restrict_unprivileged_userns` is `1`), the profile step: `tools/screenshots/playwright-chromium.apparmor` installed and loaded, which Chromium's sandbox needs → `npm run test:e2e` → `npm run lighthouse:ci` |
| `deploy` | `push` to `main` | Needs `verify` and `e2e`. Environment `production`, on `ubuntu-latest`. Detects whether `CLOUDFLARE_API_TOKEN` is set, and if not prints a notice and skips the rest. Then the head check (stop, with a notice, unless `github.sha` is `main`'s head now; every later step runs only if it is; see the deploy gate above) → the sparse checkout of `github.sha` → `setup-node` with its `.nvmrc` and `package-manager-cache: false` → `node trusted/scripts/trusted-config.mjs trusted` → stop unless it gave a version → stop unless `npm --version` is 11.10.0 or later, the release that added `min-release-age` (an older npm only warns, and installs with no floor; `npm config get` can't tell the two apart: with the floor set, npm 11.9.0 and npm 11.16+ both print `7` for the setting and `null` for its `before` date) → stop unless `needs.verify.outputs.site-artifact-id` is non-empty and all digits → download the artifact with `artifact-ids: ${{ needs.verify.outputs.site-artifact-id }}` (download-artifact v8.0.1) → copy into a fresh directory → stop if that directory holds a symlink → `cloudflare/wrangler-action@v4` with `command: deploy bundle/worker.js --no-bundle --upload-source-maps=false --config wrangler.jsonc`. In this repo, that is what keeps the live demo current (§14.1). |
| `preview-build` | PR opened, synchronized or reopened, from a branch in the same repo, into the default branch, with `CI_PREVIEWS` set to `true` | Needs `verify`. No token. `npm ci` → build with `PUBLIC_TURNSTILE_SITE_KEY` set to the test key → `npx wrangler deploy --dry-run --outdir bundle` → upload `dist/` and `bundle/`, hidden files included, as the artifact `preview-site`, its `artifact-id` the job output `site-artifact-id`. |
| `preview` | Same as `preview-build` | Needs `preview-build`. Environment `preview`, on `ubuntu-latest`. **It uploads `bundle/worker.js` byte for byte, as `preview-build` handed it over, with the artifact's `dist/` as its assets, and nothing in the artifact makes wrangler read another file on the runner or run anything.** The same steps as `deploy`, from the default branch and the `preview-site` artifact, downloaded by `needs.preview-build.outputs.site-artifact-id`, but the copy step takes no config → stop if the site directory holds a symlink → `node trusted/scripts/trusted-config.mjs --preview-config trusted "$RUNNER_TEMP/site/wrangler.json"` writes one from the trusted `wrangler.jsonc`, with `no_bundle` set, source maps and additional modules off (`wrangler preview` has no `--no-bundle`, and its bundler would follow an import in `worker.js` to any file on the runner, the token's `/proc/self/environ` included) → stop unless that file exists → wrangler-action with `command: preview bundle/worker.js --name pr-<number> --config wrangler.json` → upsert a single PR comment (marked with a hidden HTML marker) holding the `preview-url` output, using `actions/github-script`. |
| `preview-cleanup` | PR `closed`, with the same gate | Environment `preview`, on `ubuntu-latest`. The sparse checkout of the default branch → `trusted-config.mjs` → stop unless it gave a version → stop unless npm is 11.10.0 or later → wrangler-action with `command: preview delete --name pr-<number> --config wrangler.jsonc`, from a directory holding only the trusted `wrangler.jsonc`. |

**Environments.** A job that names an environment which does not exist still runs: GitHub creates the environment with no protection rules, and a repository secret resolves inside it (checked on a private repository). What an environment can add depends on the plan. For a private repository, Free has no environment secrets, deployment-branch rules or required reviewers; Pro and Team have the first two; Enterprise has all three. A public repository has all three on any plan.
- **`production`:** the token as an environment secret, with deployment branches limited to `main`, wherever the plan has environment secrets. Every push to `main` deploys, running that commit's `trusted-config.mjs` before wrangler, so **anyone who can merge into `main`, or push a workflow change, can read the token**. A pull-request rule alone doesn't change that: it requires no approval by default, so a token with Contents and Pull requests write can open a pull request and merge it. To keep coding agents out:
  - they get a separate GitHub identity (a machine user or a GitHub App installation) with write access, never the owner's credential, with which an agent can approve nothing but merge whatever the owner could;
  - where the plan has rulesets (a public repository, or a private one on a paid plan), a ruleset on `main` requires one approval, dismisses approvals on new commits, and keeps that identity off its bypass list.

  On a private Free repository, which has neither environment secrets nor rulesets, the token stays a repository secret, and any identity with Contents write can push to `main`.
- **`preview`:** the token as an environment secret behind required reviewers, so on a public repository or on Enterprise only. A pull request's run uses that PR's own workflow file, so the reviewer is the gate. Each preview waits for an approval, and so does each deletion of one when its PR closes.
- **The `CI_PREVIEWS` gate:** `preview-build`, `preview` and `preview-cleanup` run only when the repository variable `CI_PREVIEWS` is `'true'`, whatever the visibility, because an environment that does not exist yet would be created unprotected. They also run only for a PR into the default branch, whose tip, by name, is the ref the token jobs trust. Previews are off by default; a private site previews locally with `npm run preview`.

- **Secrets:** `CLOUDFLARE_API_TOKEN` (Account → Workers Scripts → Edit, and Account → Account Settings → Read; preview permissions are verified in §16; a custom-domain site's token adds Zone → Workers Routes → Write on that site's zone only, D16) and `CLOUDFLARE_ACCOUNT_ID`. Where they go:
  - public repository (any plan), or private on Enterprise: environment secrets in `production` (deployment branches: `main`) and, for previews, in `preview` (required reviewers), with no repository-level copies;
  - private on Pro or Team: environment secrets in `production`; previews stay off;
  - private on Free: repository secrets.
- **Optional repo variables:** `CI_LINUX_RUNNER`, and `CI_PREVIEWS` (`true` turns previews on).
- **Fork PRs** never see secrets, so they run `verify` and `e2e` only. That is exactly what the public template needs.
- **Dependabot** (`.github/dependabot.yml`) opens monthly, grouped updates for npm, GitHub Actions and pre-commit hooks, with a 7-day cooldown and TypeScript held below 7. Stamped-out sites inherit it.
- **Workflow linting:** `actionlint` and `zizmor` run as pre-commit hooks. The `actionlint-py` hook is pinned by SHA and its build verifies the downloaded actionlint binary's SHA-256 against `_custom_build/checksums.cfg` (checked against upstream's release checksums), so the pin fixes the hook's own code and the binary's checksum. Its build requirements (`setuptools`, `wheel`, `requests`, `semver`) still come unpinned from PyPI, with no cooldown, when pre-commit first installs the hook: a residual.
- **Admission test:** `tests/unit/supply-chain.test.ts`, in `npm run verify` and so inherited by every stamped-out site, admits upstream code only on pins the repository verifies, whichever path introduced it (Dependabot, a hand install, a lockfile edit, a hook). It asserts that (a) every `package-lock.json` entry's `name` field (an alias) is refused unless on an allow-list in the test (empty today), because honouring it would let an entry carry another package's tarball; every entry's `resolved` is exactly `https://registry.npmjs.org/<name>/-/<unscoped-name>-<version>.tgz` for the entry's own name (its `name` field if an alias) and version, with `sha512-` integrity and no link, `git+`, `file:` or `http:` source (a host check alone would let an entry point at another package's tarball); (b) npm runs no install scripts in this repository: `.npmrc` sets `ignore-scripts=true`, so no `npm ci` or `npm install` (CI's `verify`, `e2e` and `preview-build`, and the owner's machine) runs a package's lifecycle scripts, nor the `node-gyp rebuild` npm infers from a root `binding.gyp`; no workflow, `package.json` script, README, AGENTS.md or skill turns them back on (`--ignore-scripts=false`, `--no-ignore-scripts`, `npm_config_ignore_scripts` set to anything but `'true'`, `npm config set`, or a rebuild with no package list); and `package.json` has no install script and no `pre` or `post` hook of a script or an npm event, which npm would then silently skip. No package needs its script (esbuild, workerd and sharp take their binaries from per-platform packages; fsevents ships its own), so no package is rebuilt with scripts on; one that did would be rebuilt by name, on an allow-list in the test (empty). The lockfile's `hasInstallScript` cannot be the gate: npm writes none for a package that ships a `binding.gyp` and declares `"gypfile": false`, and `npm ci` builds it anyway (sweep cluster 3). So (b2), the entries with `hasInstallScript` being exactly `esbuild`, `fsevents` and `workerd`, is kept only as an early warning, an allow-list a new entry needs the owner's approval to change; (c) every `rev:` in `.pre-commit-config.yaml` is a 40-hex commit SHA followed by a `# vX.Y.Z` comment, read with a regex because no YAML parser is a dependency; and (d) `.npmrc`'s `min-release-age` equals every `default-days` in `dependabot.yml`; and (e) no file the repository ships (workflow, `package.json` script, README, AGENTS.md, skill) runs a global npm install or an `npx` outside the lockfile, and every `wrangler logout` carries `--no`, so it uses the lockfile's wrangler and downloads none.
- **Pre-commit pins:** Dependabot's `pre-commit` ecosystem keeps those SHA-pinned revs current, monthly, in one group, under the same 7-day cooldown.
- **Release-age floor:** `.npmrc` sets `min-release-age=7`, so a hand `npm install` takes no release younger than the cooldown. `npm ci` is unaffected: it installs the lockfile's versions whatever their age. npm 11.10 added the setting; Node 22's npm 10.x ignores it, so the README tells Node 22 users to use Node 24.14.1 or later, the first release whose bundled npm applies it, and not to upgrade npm from the registry, which is outside the lockfile.
- **Self-hosted runners** may serve this repository only while it is private, and only its jobs without the token, and not `verify` on a push to `main`: `deploy`, `preview`, `preview-cleanup` and that `verify` run always use GitHub-hosted runners (see "Runners"). Self-hosted runners are removed before the repository goes public, per the ci-runners Trust rule.

**One-off VM change, made by the owner.** jl-dev-02 needs Chromium's system libraries for `e2e`, and, if its kernel restricts user namespaces, the AppArmor profile `tools/screenshots/playwright-chromium.apparmor` (installed once, as `tools/screenshots/README.md` says; the self-hosted runner gets no profile step). Jobs have no sudo, so they cannot install either.
1. Run `npx playwright install-deps --dry-run chromium` on an Ubuntu 24.04 machine to list the packages.
2. Pass the list to `setup-linux-runner.sh --apt-packages` in the same run that registers this repository's runner.
3. Record it in the ci-runners Deployments table.

Playwright then downloads Chromium itself into the runner account's cache, without sudo. jl-dev-03 (Windows) is not used: the ci-runners README says neither VM has a browser, and a Windows job would need a second runner registration for no extra coverage.

## 11. Tooling and verification

### 11.1 Versions

Pin each version to the current release at implementation time, with an exact entry in package-lock.

| Package | Version |
|---|---|
| `astro` | 7.3.x |
| `@astrojs/sitemap` | 3.7.x |
| `@astrojs/check` | 0.9.x |
| `typescript` | ^6 |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.x |
| `vitest` | 5.x |
| `wrangler` | ≥ 4.149 (Previews need ≥ 4.135) |
| `@playwright/test` | 1.64.x |
| `lighthouse`, `chrome-launcher` | 13.5.0 and 1.2.1 (exact), driven by `scripts/lighthouse.mjs` |
| `jsonc-parser` | used by tests that read `wrangler.jsonc` |
| `sharp`, `gifenc` | `tools/screenshots/` only |

### 11.2 npm scripts

| Script | Does |
|---|---|
| `dev` | `astro dev`: pages only, no `/api` |
| `build` | `astro build` |
| `preview` | `node scripts/dev-stack.mjs`: the full stack locally, with test keys and `log` delivery (§7.5) |
| `check` | `astro check`: covers `.astro` and `.ts`, including the worker |
| `test` | vitest `unit` and `sweep` projects |
| `test:dist` | vitest `dist` project (needs `build`) |
| `test:e2e` | Playwright, whose `webServer` is `scripts/dev-stack.mjs`. The run works the same in the template and in a stamped-out site whose production values are real. |
| `verify` | `check` → `test` → `build` → `test:dist` |
| `preflight` | vitest `preflight` project |
| `lighthouse` / `lighthouse:ci` | Lighthouse 13 driven by `scripts/lighthouse.mjs` against `wrangler dev` with Playwright's Chromium; budgets in `lighthouse-budgets.json`, median of three runs per path, reports in `.lighthouse/`. The local run asserts performance = 1. The CI run asserts deterministic audits only (§11.4). |
| `screenshots` | `node tools/screenshots/capture.mjs`: README media (§14.3). Local only, never run in CI. |

All helper scripts are Node (`.mjs`) or TypeScript, so they behave the same on Windows and Linux.

### 11.3 Preflight: "is this still the template?"

`npm run preflight` picks its mode from `wrangler.jsonc`.

**Demo mode** applies only when there is no `route` and `routes` is absent or empty, at the top level **and** in every `env.*` block, so the deploy goes to workers.dev only, and `vars.DELIVERY_PROVIDER` is not `resend`, `slack` or `teams`, so nothing reaches a real recipient.
- It passes, and prints which example values and `[bracketed]` placeholders are still present, so a demo deploy is never blocked.
- This is how the live demo and a new user's first deploy (§14.2) work.
- It fails only if `workers_dev` is `false`, because then the deploy would have no URL at all.
- It **warns** (never fails) when `site.url` is still on `example.com` but `site.name` is not `Example Co.` or the Worker `name` is not the template's: the site has been customised but still advertises the template's address (canonical and OpenGraph URLs, sitemap).

**Production mode** applies when `vars.DELIVERY_PROVIDER` is `resend`, `slack` or `teams` (a live site, with or without a route), or when a route of any kind exists: a custom domain, a zone route string, a `{ pattern, zone_name }` object, the singular `route`, or any of these under an `env.*` block. It fails, naming each problem, when any of these hold:
- `wrangler.jsonc` `name` is `cloudflare-site-template`;
- `site.url` is on `example.com`, or, when there is a route, its host is not the host of any route (a route string's host is the part before the first `/`; an object's is its `pattern`; comparison is case-insensitive);
- `site.contact.turnstileSiteKey` is a Turnstile test key (`1x…`, `2x…` or `3x…`);
- `TURNSTILE_SECRET_KEY` is still in the top-level `vars`;
- `DELIVERY_PROVIDER` is `log` or missing in the top-level `vars`;
- `CONTACT_TO_EMAIL` or `CONTACT_FROM_EMAIL` is on `example.com` while the provider is `resend`;
- `site.name` is still `Example Co.`;
- a built page (`dist/**/*.html`) has a `[bracketed]` placeholder in its visible text, which a design leaves for a fact it did not know (for example `[Phone number]`); the error names the page and the placeholder. Script, style, comment and attribute text is ignored. If `dist/` is missing, the error says to run `npm run build` first.

A `CONTACT_FROM_EMAIL` may carry a display name (`Example Co. <hello@example.com>`); the check reads the address inside `<…>`.

Without a route, production mode skips only the "host of a route" check, and still fails when `workers_dev` is `false`, because the deploy would have no URL.

It only warns when `design/SOURCE.md` and `design/bundle/` are both absent.

### 11.4 Tests

- **Unit** (`tests/unit/`, plain Node, no Workers runtime):
  - `validate`: each rule and each boundary length.
  - `turnstile`: success, failure, missing token, timeout, 5xx, and fail-open against fail-closed.
  - Each provider: exact request URL, headers and body; non-2xx becomes `DeliveryError`.
  - `readConfig`: missing values are reported per provider.
  - `handleContact`: every row of §7.3, plus the honeypot sending nothing.
  - `worker.ts` routing, with a stub `ASSETS`.
  - C6: no file under `src/contact/` imports a `cloudflare:` specifier, any package, or any module outside `src/contact/`.
- **Dist contracts** (`tests/dist/`) cover C2 to C5 over every HTML file in `dist/`. They also check that `sitemap-index.xml`, `robots.txt`, `404.html` and `_headers` exist, and that `robots.txt` names the sitemap with an absolute URL.
- **Preflight** (`tests/preflight/`): §11.3.
- **E2E** (`tests/e2e/`, Chromium):
  1. The happy path: scroll to the form, the Turnstile test widget passes, the button enables, fill and submit, and `data-state="sent"` shows the success message.
  2. A server-side error is surfaced in the UI. For example, a long name gets past client validation once `maxlength` is removed in the test, and the server's 400 appears.
  3. With JS disabled, the button is disabled and the `<noscript>` text is visible.
  4. An unknown path returns the 404 page with status 404.
  5. A missing hashed asset under `/_astro/` is a 404 with the 404 page, the CSP and `Cache-Control: no-store`, never cached as immutable.
  6. The success message names the address that was sent, even when the email field changes while the request is in flight.
  7. On a 375px viewport, the `<details>` mobile nav opens and its links are reachable.
- **Lighthouse:**
  - Local: performance = 1, accessibility ≥ 0.95, best-practices ≥ 0.95, SEO = 1.
  - CI: accessibility and SEO are errors, because they are deterministic. Performance and best practices only warn, because a shared VM's CPU contention makes those scores noisy. These audits are also errors: `render-blocking-insight` (was `render-blocking-resources`), `unsized-images`, `cumulative-layout-shift` ≤ 0.01, `total-byte-weight` ≤ 300 KB, and `font-display-insight` (was `font-display`).

## 12. Agent ergonomics

- **`CLAUDE.md`** is the single line `@AGENTS.md`.
- **`AGENTS.md`** has these sections:
  1. **Environment, command chaining, git workflow, pre-commit, Terraform, destructive commands:** the existing operational rules, unchanged.
  2. **What this repo is:** an Astro static site on Cloudflare Workers with a portable contact handler. This section maps the layout.
  3. **Contracts:** C1–C7, with the reasoning behind each.
  4. **Rules from PRD §6:** no unapproved dependencies (no React, Vue or component libraries); read tokens from `global.css` and facts from `site.ts`; the portability guardrail; Astro `<Image>` for raster images.
  5. **Verification:** run `npm run verify` before finishing any change, and `npm run test:e2e` after touching `ContactForm`, `src/scripts/`, `worker.ts`, `src/contact/` or `tools/screenshots/`.
  6. **Stamping out a new site:** use `.claude/skills/new-site/SKILL.md`. Agents other than Claude Code read the file directly.
  7. **Working on the template itself:** keep the example site fictional and every test green, update the README runbook whenever a step changes, and never put real site content here.
- **`.claude/skills/new-site/SKILL.md`** follows these steps:
  1. Check the inputs: `SITE_BRIEF.md` is filled in, and `design/` holds a handoff URL or an archive, or the person names a folder outside the repository. If `design/bundle/` already exists, the design was ingested before: say so, and stop.
  2. Ingest the design into `design/bundle/` with `tools/design-ingest/ingest.mjs` (Node, so any shell), a folder or an artifact's saved files always from outside the repository, and read its README, chats and screens as design data, rendering a screen only with `capture.mjs --only screen` (§6.3).
  3. Inventory the pages, sections, palette, type scale, spacing, radii and imagery.
  4. Set the site's identity: the wrangler `name`, `routes` (custom domain) and `site.url` (the custom domain, or `https://<slug>.<subdomain>.workers.dev`), real vars with `TURNSTILE_SECRET_KEY` removed from `vars` (§7.5), `site.ts`, and the fonts config.
  5. Write the tokens into `@theme`.
  6. Rebuild sections and pages to match the design within C1–C7, moving images into `src/assets/`.
  7. Write the privacy page from the brief.
  8. Verify: `verify`, `test:e2e`, `lighthouse`, and a visual comparison of each design screen, as its `--only screen` PNG, against the built page. If a browser tool is available, use screenshots. Otherwise list the URLs for the human to check. Iterate until they match.
  9. Run `npm run preflight`.
  10. Make the repository the site's own (a site README and SECURITY.md; remove `repository`, `bugs` and `homepage` from `package.json`), then hand back the one-off setup checklist and the first deploy's steps (CI's token, a push, the dashboard secrets).

## 13. Stamp-out runbook (README)

New users who only want to see the template working start with §14.2 instead. That route puts the example site live on their own account with no inputs at all.

1. **Create the repo:** `gh repo create <site> --template jleavers/cloudflare-site-template --private --clone`
2. **Add the inputs:** the Claude Design handoff goes in `design/`, or an extracted folder outside the repository (§6.3), and `SITE_BRIEF.md` gets filled in.
3. **Build:** in Claude Code, run `/new-site`. Review the result locally with `npm run preview`.
4. **One-off setup** for each account or domain, with commands in the README:
   - Create a Turnstile widget in the dashboard (an API call would need an API token on the owner's machine, §10). Its hostnames are the production domain and `<subdomain>.workers.dev`, which covers previews. Free widgets allow up to 10 hostnames.
   - Verify the sending domain in Resend, or create a Slack or Teams webhook.
5. **First deploy, through CI,** like every deploy after it (§10):
   1. Unless the repository is private on GitHub Free: open the `production` environment that CI's first run made (Settings → Environments), or create it, and limit its deployment branches to `main`. On a repository with no runs yet, `gh secret set --env production` fails with a 404 until the environment exists.
   2. `gh secret set CLOUDFLARE_API_TOKEN --env production`, or a repository secret on a private Free repository (§10, "Secrets"). A custom-domain site's token also has Zone → Workers Routes → Write on that site's zone only (D16).
   3. `gh secret set CLOUDFLARE_ACCOUNT_ID --env production`, likewise
   4. Push. CI's `deploy` job creates the Worker and, with a custom domain, attaches it from `routes`, which provisions DNS and TLS; the domain switches at that push. In CI, wrangler asks nothing: it takes over an existing DNS record for the hostname, or the hostname from another Worker. It also won't register a workers.dev subdomain, so an account that has never had a Worker first gets one in the dashboard (Workers & Pages, "Your subdomain"). A domain that already serves a site elsewhere moves in two pushes, so the form works the moment it moves: first without `routes`, then the secrets (5.5), then with `routes`.
   5. Add `TURNSTILE_SECRET_KEY`, and `RESEND_API_KEY` or `WEBHOOK_URL`, as type Secret in the dashboard (the Worker → Settings → Variables and Secrets, §7.5). Until then the handler refuses every post, which is expected.
   6. Turn on **Always Use HTTPS** for the domain's zone (SSL/TLS → Edge Certificates). Preflight can't check it, and without it the pages can be fetched over http.
   7. Send a test message from the live site.
6. **Optionally**, `gh variable set CI_LINUX_RUNNER` plus a runner registration (see ci-runners), removed again before the repository is made public (a fork's pull request runs its own workflow file, which can name the runner's label directly, so removing the variable alone protects nothing); and `CI_PREVIEWS` once a `preview` environment with required reviewers holds the token (§10). Pull-request previews are opt-in.

The "under 5 minutes" target covers steps 1 and 5 for an account where step 4 has already been done once. Step 3 depends on the design.

## 14. Live demo and README media

### 14.1 The live demo

- **What it is:** the template's example site, deployed from this repo's `main` by the `deploy` job to `https://cloudflare-site-template.<demo-subdomain>.workers.dev`.
  - It has fabricated content ("Example Co."), `log` delivery and Turnstile's test keys.
  - Preflight passes in demo mode (§11.3).
- **Where it runs:** a **dedicated free Cloudflare account** that holds nothing but the demo.
  - This repo's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` belong to that account.
  - The token is scoped to Workers Scripts:Edit and Account Settings:Read on it.
  - The demo deploys from CI only, through the `deploy` job, like every site (§10): never from the owner's machine.
- **It is honest about being a demo:**
  - A `DemoNotice` strip renders whenever `site.url` is on `example.com`. It says the site is a demo of cloudflare-site-template, that the content is fictional and that the form sends nothing, and links to the repo.
  - Any site that sets its own URL loses the strip automatically, and the `new-site` skill deletes the component.
  - The form works end to end: Turnstile's test widget shows its "testing only" label, and the success message appears.
- **Risk is bounded:**
  - With test keys, the demo form has no real bot protection. But `log` sends nothing, so the worst case is using up the Worker's free daily request quota. Static pages are unaffected either way.
  - Fork PRs never receive secrets, and no workflow uses `pull_request_target`.
  - If the token leaked anyway, through a compromised action or a careless workflow edit, it could reach only the demo account. Actions are SHA-pinned (§10) to make such a leak less likely.

### 14.2 Try it yourself (README "Quick start")

One route puts the example site live on the user's own workers.dev with no Worker secrets and no inputs: **"Use this template"**, then `gh secret set CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (in a `production` environment where the plan has environment secrets, or repository secrets, §10), then push (an empty commit, or a re-run of the first CI run). The `deploy` job does the rest, once the account has a workers.dev subdomain: CI's wrangler won't register one (§13). `npm run preview` tries the site locally with no account at all.

There is no "Deploy to Cloudflare" button and no local deploy. The button builds and deploys with Workers Builds, which installs the lockfile and runs its code (install scripts, `astro build`, vite, the lockfile's wrangler) in the build that holds an account token, and a local deploy runs the same code beside a login or token. Either way one malicious package version could change every Worker on the account, where CI's split (§10) keeps the token away from that code.

### 14.3 README media: `tools/screenshots/`

The capture tools are Node scripts using Playwright (already a dev dependency), `sharp` for compositing and `gifenc` for GIF encoding.
- By default they capture `scripts/dev-stack.mjs` locally. `--url` points them at the live demo instead.
- They write to `docs/images/`.
- Each script prints the file size, and exits non-zero when a file is over its limit.
- The media captures run on the owner's machine only, never in CI.
- A design screen renders only through `design.mjs` and `fence.mjs` (§6.3): `--only design` for `design-to-site.png`, and `--only screen`, which needs no site and writes one PNG where `--out` says, for the new-site skill's comparisons (steps 2 and 8). `tests/e2e/design-fence.spec.ts` attacks that renderer with a hostile screen in CI's `e2e` job.

| File | Content | Limit |
|---|---|---|
| `hero.png` | The example site's desktop view (1440 wide) beside its mobile view (390 wide), composited through a small HTML page | 600 KB |
| `contact-form.gif` | Scroll to the form, Turnstile passes, type, submit, success state | 500 KB |
| `design-to-site.png` | A Claude Design screen beside the page built from it, taken from the end-to-end throwaway site. Captured with `--design <bundle html> --site <url>`. | 600 KB |
| `social-preview.png` | The 1280×640 GitHub card, drawn from the site's own CSS and uploaded by hand under Settings → General → Social preview | 1 MB |
| `linkedin-header.png` | 1920×1080, laid out like issuebot's: copy on the left, the site in a browser frame on the right | 1 MB |

- **`tools/screenshots/README.md`** follows codervis's: what is fabricated, how to regenerate each file, the dials (width, colour count), and the fact that Playwright's browser downloads are not hash-verified.
- **Alt text** on every image describes what it shows and ends "The content shown is fabricated."
- **The README** follows the issuebot and codervis structure:
  1. the title, with CI and licence badges;
  2. a bold one-line pitch;
  3. `hero.png`;
  4. a live-demo link;
  5. Contents;
  6. How it works, with `design-to-site.png` and `contact-form.gif`;
  7. Quick start (§14.2);
  8. Stamp out a site (§13);
  9. Configuration reference;
  10. Development;
  11. Escape hatches;
  12. Licence.

## 15. Public release

1. Add `LICENSE` with the Apache-2.0 text and `Copyright 2026 James Leavers`, as in `codervis`.
2. Write the README per §14.3. Include the escape hatches (S3 or Caddy for `dist/`; wrapping `handleContact` in FastAPI or Lambda), and a note that the template code is Apache-2.0 while each site's content belongs to its owner.
3. Check for personal data: no real emails or keys in the example. `site.ts` and `SITE_BRIEF.md` use example.com.
4. Before flipping visibility, remove the jl-dev-02 runners and the `CI_LINUX_RUNNER` variable from this repo, together, and update the ci-runners Deployments table. A `CI_LINUX_RUNNER` that outlives its runners leaves `e2e` queued forever, and `deploy`, which needs `e2e`, never runs. Confirm that this repo's Cloudflare secrets belong to the demo account (§14.1), not the main one.
4a. Run the security sweep (§18) with `baseline` and then `public`, and fix every critical and high cluster before the flip.
4b. Move this repo's token to where the README tells every public repository to keep it (§10, "Environments"). Do it before the flip if the plan gives a private repository environment secrets, deployment-branch rules and rulesets (Pro, Team or Enterprise); on GitHub Free, which gives a private one none of them, do it straight after step 5, before anything else merges into `main`.
   - Limit the `production` environment's deployment branches to `main`. A probe run created it, with no rules.
   - Set both secrets in it: `gh secret set CLOUDFLARE_API_TOKEN --env production` and `gh secret set CLOUDFLARE_ACCOUNT_ID --env production`.
   - Delete the repository-level copies: `gh secret delete CLOUDFLARE_API_TOKEN` and `gh secret delete CLOUDFLARE_ACCOUNT_ID`.
   - Leave `CI_PREVIEWS` unset, unless a `preview` environment with required reviewers holds the token.
   - Set Settings → Actions → General → "Approval for running fork pull request workflows from contributors" to "Require approval for all external contributors", and read any change under `.github/workflows/` in the pull request's diff before approving its run: a fork's pull request runs its own workflow file.
   - Add the ruleset the README describes ("Coding agents"): one approval on `main`, approvals dismissed when new commits are pushed, and no agent's identity on its bypass list.
5. Set "Template repository" (`gh api -X PATCH repos/jleavers/cloudflare-site-template -F is_template=true`), and make the repo public.
6. Confirm, after the first public push, that CI is green on GitHub-hosted runners and that the `deploy` job redeployed the live demo.
7. Upload `social-preview.png` under Settings → General → Social preview.

## 16. To verify during implementation

These are facts the design depends on that could not be fully confirmed from documentation. Each gets a short spike at the start of the task that needs it, and the spec is updated if reality differs.

1. **Previews:**
   - that `env.ASSETS` and the uploaded `dist/` are served in a Preview;
   - that `previews.vars` reach the Worker;
   - the exact `wrangler preview` flags and output;
   - that wrangler-action v4 passes `preview --name …` through and sets `preview-url`;
   - the API-token permissions Previews need.
2. **Teams:** the current incoming-webhook payload format (Workflows plus an Adaptive Card).
3. **Astro 7 and CSP:** whether small `<script>`s are inlined (which would break the CSP), and whether Astro's built-in CSP support makes hashes unnecessary.
4. **`astro check`:** that it runs cleanly with TypeScript 6 on Astro 7.3.
5. **Chromium on jl-dev-02:** the package list from `playwright install-deps --dry-run chromium`, and that Playwright's Chromium starts there without sudo.
6. **Lighthouse:** that Lighthouse 13 (via `chrome-launcher`) runs against Playwright's Chromium through `chromePath`.
7. **First deploy:** that CI's first `deploy` job, with `routes: [{ pattern, custom_domain: true }]`, creates the Worker and attaches the domain with the token D16 describes (Workers Scripts Edit and Account Settings Read, plus Workers Routes Write on that zone only).
8. **Media capture:** that `sharp` and `gifenc` together produce a form GIF under 500 KB at a readable width, and that the Turnstile test widget renders under headless Chromium (the e2e tests rely on this too).

## 17. Out of scope for v1

- AWS SES and a generic JSON webhook provider: a new provider is one module behind the same interface.
- Rate limiting and HTTP 429.
- Alpine.js, or any client framework.
- Blog, CMS or content collections, and multiple languages.
- Workers Builds, for any site: it runs the lockfile's code in the build that holds the account token (§10). `ci.yml` is the only pipeline.
- A Windows CI job.
- A custom domain for the live demo. Preflight's production mode would rightly reject the example values there.

## 18. Security sweep before release

The owner's public repositories (`codervis`, `issuebot`) were each swept before going public with a Claude Code workflow. This repository ports `jleavers/codervis`'s version, pinned at `1871374e`, because it has four safeguards issuebot's lacks:
- a data-not-instructions fence around everything relayed between stages;
- per-stage tool profiles;
- a tracker listing filtered to maintainer-authored items;
- private-advisory filing.

**What carries over unchanged:** the generic engine (schemas, the fence, `launch`, the scan, verify, escalate, triage, critic and report prompts, the pipeline) and three of the five agent profiles.

**What is rewritten:**
- the hands-off rules (Wrangler logins, `.dev.vars`, the live sites, and the Cloudflare, Resend, Slack and Teams APIs);
- the "where you are" preamble;
- recon;
- three GitHub-side read bounds;
- the lanes.

**Lanes, in two sets:**

| Set | Lane | Attacker or question | Web |
|---|---|---|---|
| `baseline` | `contact-handler` | an anonymous POST to `/api/contact` | yes |
| | `served-surface` | what a deployed site serves, and what a browser may do with it | yes |
| | `ci-workflow` | a pull request, a fork, or a compromised action | yes |
| | `npm-supply-chain` | the dependencies, and history GitHub serves by SHA | yes |
| | `design-ingest` | the author of a Claude Design bundle | no |
| `public` | `disclosure` | everything that flipping to public publishes | yes |
| | `outsiders` | any GitHub account, once the repository is public | yes |
| | `shipped-text` | what the agent text tells a stranger's agent; which controls fail open (by mutation) | no |

**Rules for running it:**
- It runs in a fresh session, so that the agent profiles are registered, with a read-only `gh` credential.
- Each run ends with the post-run audit of the transcripts.
- **While the repository is private, findings are held in the run directory, not filed.** Repository security advisories need a public repository, and an issue filed now would become public at the flip, before its fix.
- Critical and high clusters block the release.
- After the flip, approved clusters are filed as draft security advisories.
- Every agent's scratch lies outside the repository: a new folder in the session's own scratch directory, or one `mktemp -d` makes, which phase 0 checks is writable. The workflow refuses to start without one, or with one at, under or above the repository, since an editor extension that scans the workspace loads what a probe leaves there.
- The skill never removes a directory tree. The owner deletes the scratch directory.

**Tests:**
- `tests/sweep/` pins that the workflow compiles, its lane sets and web flags, and that nothing of codervis remains.
- It pins the stage tool profiles, the relay fence (ported from codervis's relay test to ESM vitest), and the exact set of files shipped under `.claude/`.
