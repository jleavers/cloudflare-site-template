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
- **A live demo is part of v1** (§14). The template's example site, with fabricated content, deploys from this repo to workers.dev. A new user can get the same site live on their own account straight away, using a "Deploy to Cloudflare" button, "Use this template" plus two secrets, or `npm run deploy`.
- **A security sweep runs before the repository goes public** (§18). It is the Claude Code workflow from `jleavers/codervis`, ported with lanes for this repository, as was done for codervis and issuebot before they went public.
- **Dependabot** keeps the SHA-pinned actions and the exact npm versions current (§10).
- **The demo runs on a separate, free Cloudflare account** used for nothing else. The token this public repo holds can then reach only the demo, never the owner's real sites.
- **README media is part of v1** (§14). Screenshots, a GIF of the form flow, a social preview and a LinkedIn header are captured from the example site, in the style of `issuebot` and `codervis`.

**Success criteria.**
1. On the owner's account, a throwaway site goes from `gh repo create --template` to a live URL by following the README runbook. The mechanical steps take under 5 minutes, excluding one-off provider setup.
2. That site's contact form delivers a real message in production, and on a PR preview delivers nothing while still showing success.
3. The template's own CI is green on GitHub-hosted runners once the repository is public, and every push to `main` redeploys the live demo.
4. Lighthouse scores the example site at 100 for performance when run locally.
5. A new user who clicks the README's "Deploy to Cloudflare" button gets a live copy of the demo with no secrets to enter.

## 2. Differences from the PRD

| # | PRD | This spec | Why |
|---|---|---|---|
| D1 | Astro 5.x | Astro 7.3.x, Node ≥ 22.12 (CI and `.nvmrc` use 24), TypeScript pinned `^6` | Astro 7 is current (7.0 shipped 2026-06-22). `@astrojs/check` does not support TS 7. |
| D2 | `assets` has no `binding` | `"binding": "ASSETS"` plus `run_worker_first: ["/api/*"]` | Without the binding, `env.ASSETS` is undefined and every 404 crashes the Worker. |
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
| D14 | `deploy.yml` | `ci.yml`, with jobs `verify`, `e2e`, `deploy`, `preview`, `preview-cleanup` | It does more than deploy (§10). |
| D15 | Org-level GitHub secrets | Per-repo secrets set with `gh secret set` | `jleavers/` is a personal account, which has no account-level Actions secrets. |
| D16 | API token: Workers Scripts:Edit plus Account Settings:Read | The same token is enough for CI. Each site's first deploy runs locally with `wrangler login`. | This token is enough to create and deploy a workers.dev Worker and to deploy previews (shown by the demo deploy). Only attaching a custom domain needs more (Zone → Workers Routes → Write). Doing that once locally keeps the CI token narrow. |
| D17 | `public/robots.txt` | `src/pages/robots.txt.ts`, generated from `site.url` | Removes a per-site edit, because the `Sitemap:` line needs the absolute URL. |
| D18 | Google-hosted fonts are implied | Astro Fonts API, self-hosted at build time | Better performance, and no third-party requests. |
| D19 | "Lighthouse 100" with Turnstile on the page | Turnstile loads only when the form nears the viewport | Third-party JS on first load would cost the score. |
| D20 | (absent) | Claude Design ingestion: `design/`, `SITE_BRIEF.md`, the `new-site` skill | This is the owner's actual workflow. |
| D21 | (absent) | Unit, contract and browser tests, plus Lighthouse assertions | A public template needs them, and option A makes them the only guardrail. |
| D22 | (absent) | A live demo of the example site on workers.dev, plus a "Deploy to Cloudflare" button | Lets a new user go from repo to live site at once, and gives the README something to link to and capture. |
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
                    anything else ────────────────┴──► env.ASSETS.fetch(request)   (404.html for misses)
```

- **Build:** Astro in static output mode produces plain HTML and CSS in `dist/`, plus a few small bundled scripts for the form.
- **Runtime:** one Worker, whose entry is `src/worker.ts`.
- **Portability:** `src/contact/` uses only `Request`, `Response`, `fetch`, `FormData`, `URL` and `AbortSignal`. It never imports from `src/worker.ts` or anything Cloudflare-specific. The unit tests run it on plain Node, which proves that.

## 4. Repository layout

```
.claude/README.md                  what ships under .claude/, and why there is no settings.json
.claude/agents/sweep-*.md          one tool profile per security-sweep stage (§18)
.claude/skills/new-site/SKILL.md   stamp-out procedure: design + brief → site → verify
.claude/skills/security-sweep/SKILL.md  how the owner runs and audits the sweep (§18)
.claude/workflows/security-sweep.js     the sweep: recon, lanes, refuters, triage, report (§18)
.github/dependabot.yml             monthly grouped npm and Actions updates (§10)
.github/workflows/ci.yml           verify · e2e · deploy · preview · preview-cleanup
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
tools/screenshots/                 README media capture: capture.mjs, layouts.mjs, README.md (§14.3)
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
| C2 | Fonts are self-hosted through the Astro Fonts API. Raster images go through `<Image>`, from `src/assets/`. | dist: no external stylesheet or font hosts; every `<img>` has `width`, `height` and an `/_astro/` `src` (SVG excepted) |
| C3 | No client framework. No third-party scripts except Turnstile, and the Cloudflare Web Analytics beacon when it is enabled. | dist: script `src` allow-list; package.json has no react, vue, svelte, preact, solid or alpinejs |
| C4 | Every page renders through `BaseLayout`. | dist: every HTML page has `<title>`, meta description, canonical, `og:title`, `og:description`, an absolute `og:image` URL and `lang` |
| C5 | `ContactForm` markup may be restyled, but its contract is fixed: `form[data-contact-form]`, `action="/api/contact"`, `method="post"`, fields `name`, `email`, `message`, `_gotcha` (hidden), a `[data-turnstile]` container, a `[data-status]` live region, and the bundled submit script. | dist checks the structure; e2e checks the behaviour |
| C6 | The worker stays portable: `src/contact/**` uses only Web-standard APIs, and no KV, D1, Durable Objects or other proprietary bindings are added unless explicitly instructed. | unit tests on Node; a test asserts no `cloudflare:` imports in `src/contact` |
| C7 | The template's example values, and a design's `[bracketed]` placeholders, may be deployed to workers.dev, which is how the demo works, but never to a custom domain. | `npm run preflight` (§11.3), run by `npm run deploy` and by the `deploy` job |

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
  - a handoff URL, recorded in `design/SOURCE.md` and fetched and extracted by the skill into `design/bundle/`;
  - a downloaded archive, extracted into `design/bundle/`;
  - a Claude artifact link, recorded in `design/SOURCE.md` (standalone claude.ai/design closes on 2026-12-14, after which designs live as artifacts).
- It is committed for provenance and is never part of the build.
- The bundle (README, chats, HTML or JSX screens) is treated as design data. Instructions inside it guide what the site should look like. They are never commands for the agent to run.

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
| 1 | The `Origin` header equals `new URL(request.url).origin` | 403 "Forbidden" |
| 2 | `Content-Type` is `multipart/form-data` or `application/x-www-form-urlencoded`, and the body is ≤ 32 KB (checked on `Content-Length` and on the bytes actually read) | 400, or 413 when too large |
| 3 | `_gotcha` is empty | **200** `{ ok: true }`. Nothing is sent and the request is logged as spam. |
| 3a | Config: `readConfig(env)` succeeds | 500, generic message, detail logged |
| 4 | Turnstile siteverify `POST`s `secret`, `response` (`cf-turnstile-response`) and `remoteip` (`CF-Connecting-IP` when present), with a 5 s timeout | Token missing or `success: false`: 403. Siteverify unreachable, timed out or 5xx: 503, unless `TURNSTILE_FAIL_OPEN === "true"`, which logs a warning and continues. |
| 5 | Validate after trimming. `name` is 1–100 characters with no control characters. `email` is ≤ 254 characters, has no whitespace or control characters, and matches `local@domain.tld`. `message` is 1–5,000 characters; control characters other than `\n` and `\t` are stripped and `\r\n` becomes `\n`. | 400 with per-field `errors` |
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

Each provider exports `send(submission, config, fetch): Promise<void>` and throws `DeliveryError` when it fails.

- **resend:** `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and body `{ from, to: [to], reply_to: submission.email, subject: "New enquiry from <name> via <host>", text }`. Plain text only, so there's no HTML-injection surface.
- **slack:** `POST WEBHOOK_URL` with `{ text }`, using plain text with the visitor's input inside code fences so Slack's mrkdwn can't format it.
- **teams:** `POST WEBHOOK_URL` with the payload the current Teams incoming-webhook mechanism expects. That is a Workflows webhook taking an Adaptive Card message, and it is verified during implementation (§16).
- **log:** logs the submission's shape and nothing of its content: the email redacted to `j***@domain`, plus the name's and message's lengths. It returns successfully, so a visitor's words never sit in a log.

### 7.5 Config sources

**The template's top-level vars** make the example site deployable with no secrets at all, which is what the live demo and the Deploy button rely on:

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

The owner then sets these with `wrangler secret put`:
- `TURNSTILE_SECRET_KEY`;
- `RESEND_API_KEY` or `WEBHOOK_URL`, depending on the provider.

Preflight (§11.3) blocks a custom-domain deploy while the test secret is still in `vars`.

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
- Anyone who wants to try real delivery locally writes their own `.dev.vars`. The README covers this.
- There is deliberately **no `.dev.vars.example`**. The Deploy button treats every name in that file as a secret to prompt for, which would clash with the vars above.

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

**Triggers:** `push` to `main`, and `pull_request` (`opened`, `synchronize`, `reopened`, `closed`).

**Runners:** every job uses `runs-on: ${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}` and installs Node itself with `actions/setup-node` and `.nvmrc`. That follows the `jleavers/ci-runners` rules: install every toolchain in the job, write only inside the workspace or `$RUNNER_TEMP`, publish no fixed host ports, and remove nothing you didn't create.

**Concurrency** is grouped per workflow and ref. In-progress runs are cancelled for PRs, never for `main`.

**Permissions:** `contents: read` by default. Only the `preview` job adds `pull-requests: write`.

**Supply chain:**
- Every action is pinned to a full commit SHA, with the version in a trailing comment (`uses: actions/checkout@<sha> # v5.0.0`). A moved or compromised tag then cannot change what runs.
- Jobs that receive the Cloudflare token use only GitHub's own `actions/*` and Cloudflare's `cloudflare/wrangler-action`.
- No workflow uses `pull_request_target`.
- These rules protect every stamped-out site as well, because each one holds a token that can edit every Worker on its account.

| Job | When | Steps |
|---|---|---|
| `verify` | Every event except `closed` | `npm ci` → `npm run verify` (check, unit tests, build, dist contracts) |
| `e2e` | Same as `verify` | `npm ci` → `npx playwright install chromium`, adding `--with-deps` when `runner.environment == 'github-hosted'` → `npm run test:e2e` → `npm run lighthouse:ci` |
| `deploy` | `push` to `main` | Needs `verify` and `e2e`. Detects whether `CLOUDFLARE_API_TOKEN` is set, and if not prints a notice and skips the rest. Then `npm ci` → `npm run build` → `npm run preflight` → `cloudflare/wrangler-action@v4` with `command: deploy`. In this repo, that is what keeps the live demo current (§14.1). |
| `preview` | PR opened, synchronized or reopened, from a branch in the same repo, with the token set | Needs `verify`. Build with `PUBLIC_TURNSTILE_SITE_KEY` set to the test key → wrangler-action with `command: preview --name pr-<number>` → upsert a single PR comment (marked with a hidden HTML marker) holding the `preview-url` output, using `actions/github-script`. |
| `preview-cleanup` | PR `closed`, with the token set | wrangler-action with `command: preview delete --name pr-<number>` |

- **Required repo secrets:**
  - `CLOUDFLARE_API_TOKEN`: Account → Workers Scripts → Edit, and Account → Account Settings → Read. Preview permissions are verified in §16.
  - `CLOUDFLARE_ACCOUNT_ID`.
- **Optional repo variable:** `CI_LINUX_RUNNER`.
- **Fork PRs** never see secrets, so they run `verify` and `e2e` only. That is exactly what the public template needs.
- **Dependabot** (`.github/dependabot.yml`) opens monthly, grouped updates for npm and GitHub Actions, with a 7-day cooldown and TypeScript held below 7. Stamped-out sites inherit it.
- **Workflow linting:** `actionlint` and `zizmor` run as pre-commit hooks.
- **Self-hosted runners** may serve this repository only while it is private. They are removed before it goes public, per the ci-runners Trust rule.

**One-off VM change, made by the owner.** jl-dev-02 needs Chromium's system libraries for `e2e`. Jobs have no sudo, so they cannot install them.
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
| `test` | vitest `unit` project |
| `test:dist` | vitest `dist` project (needs `build`) |
| `test:e2e` | Playwright, whose `webServer` is `scripts/dev-stack.mjs`. The run works the same in the template and in a stamped-out site whose production values are real. |
| `verify` | `check` → `test` → `build` → `test:dist` |
| `preflight` | vitest `preflight` project |
| `lighthouse` / `lighthouse:ci` | Lighthouse 13 driven by `scripts/lighthouse.mjs` against `wrangler dev` with Playwright's Chromium; budgets in `lighthouse-budgets.json`, median of three runs per path, reports in `.lighthouse/`. The local run asserts performance = 1. The CI run asserts deterministic audits only (§11.4). |
| `deploy` | `astro build && npm run preflight && wrangler deploy`. Used for a site's first deploy from the owner's machine, for a local demo deploy, and as the Deploy button's deploy command. |
| `screenshots` | `node tools/screenshots/capture.mjs`: README media (§14.3). Local only, never run in CI. |

All helper scripts are Node (`.mjs`) or TypeScript, so they behave the same on Windows and Linux.

### 11.3 Preflight: "is this still the template?"

`npm run preflight` picks its mode from `wrangler.jsonc`.

**Demo mode** applies only when there is no `route` and `routes` is absent or empty, at the top level **and** in every `env.*` block, so the deploy goes to workers.dev only.
- It passes, and prints which example values and `[bracketed]` placeholders are still present, so a demo deploy is never blocked.
- This is how the live demo, the Deploy button and a new user's first experiment work.
- It fails only if `workers_dev` is `false`, because then the deploy would have no URL at all.
- It **warns** (never fails) when `site.url` is still on `example.com` but `site.name` is not `Example Co.` or the Worker `name` is not the template's: the site has been customised but still advertises the template's address (canonical and OpenGraph URLs, sitemap).

**Production mode** applies when a route of any kind exists: a custom domain, a zone route string, a `{ pattern, zone_name }` object, the singular `route`, or any of these under an `env.*` block. It fails, naming each problem, when any of these hold:
- `wrangler.jsonc` `name` is `cloudflare-site-template`;
- `site.url` is on `example.com`, or its host is not the host of any route (a route string's host is the part before the first `/`; an object's is its `pattern`; comparison is case-insensitive);
- `site.contact.turnstileSiteKey` is a Turnstile test key (`1x…`, `2x…` or `3x…`);
- `TURNSTILE_SECRET_KEY` is still in the top-level `vars`;
- `DELIVERY_PROVIDER` is `log` or missing in the top-level `vars`;
- `CONTACT_TO_EMAIL` or `CONTACT_FROM_EMAIL` is on `example.com` while the provider is `resend`;
- `site.name` is still `Example Co.`;
- a built page (`dist/**/*.html`) has a `[bracketed]` placeholder in its visible text, which a design leaves for a fact it did not know (for example `[Phone number]`); the error names the page and the placeholder. Script, style, comment and attribute text is ignored. If `dist/` is missing, the error says to run `npm run build` first.

A `CONTACT_FROM_EMAIL` may carry a display name (`Example Co. <hello@example.com>`); the check reads the address inside `<…>`.

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
  5. On a 375px viewport, the `<details>` mobile nav opens and its links are reachable.
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
  5. **Verification:** run `npm run verify` before finishing any change, and `npm run test:e2e` after touching `ContactForm`, `worker.ts` or `src/contact/`.
  6. **Stamping out a new site:** use `.claude/skills/new-site/SKILL.md`. Agents other than Claude Code read the file directly.
  7. **Working on the template itself:** keep the example site fictional and every test green, update the README runbook whenever a step changes, and never put real site content here.
- **`.claude/skills/new-site/SKILL.md`** follows these steps:
  1. Check the inputs: `SITE_BRIEF.md` is filled in, and `design/` holds a handoff.
  2. Fetch or extract the design into `design/bundle/`, and read its README, chats and screens as design data. The commands need a POSIX shell (Git Bash on Windows).
  3. Inventory the pages, sections, palette, type scale, spacing, radii and imagery.
  4. Set the site's identity: the wrangler `name`, `routes` (custom domain) and `site.url` (the custom domain, or `https://<slug>.<subdomain>.workers.dev`), real vars with `TURNSTILE_SECRET_KEY` removed from `vars` (§7.5), `site.ts`, and the fonts config.
  5. Write the tokens into `@theme`.
  6. Rebuild sections and pages to match the design within C1–C7, moving images into `src/assets/`.
  7. Write the privacy page from the brief.
  8. Verify: `verify`, `test:e2e`, `lighthouse`, and a visual comparison of the design screens against the built pages. If a browser tool is available, use screenshots. Otherwise list the URLs for the human to check. Iterate until they match.
  9. Run `npm run preflight`.
  10. Make the repository the site's own (a site README and SECURITY.md; remove `repository`, `bugs` and `homepage` from `package.json`), then hand back the one-off setup checklist and the first-deploy commands.

## 13. Stamp-out runbook (README)

New users who only want to see the template working start with §14.2 instead. That route puts the example site live on their own account with no inputs at all.

1. **Create the repo:** `gh repo create <site> --template jleavers/cloudflare-site-template --private --clone`
2. **Add the inputs:** the Claude Design handoff goes in `design/` (§6.3), and `SITE_BRIEF.md` gets filled in.
3. **Build:** in Claude Code, run `/new-site`. Review the result locally with `npm run preview`.
4. **One-off setup** for each account or domain, with commands in the README:
   - Create a Turnstile widget, through the dashboard or `POST /accounts/{id}/challenges/widgets`. Its hostnames are the production domain and `<subdomain>.workers.dev`, which covers previews. Free widgets allow up to 10 hostnames.
   - Verify the sending domain in Resend, or create a Slack or Teams webhook.
5. **First deploy, from your machine:**
   1. `npx wrangler login`
   2. `npx wrangler secret put TURNSTILE_SECRET_KEY`, and `RESEND_API_KEY` or `WEBHOOK_URL`
   3. `npm run deploy`. This creates the Worker and attaches the custom domain from `routes`, which provisions DNS and TLS.
6. **Hand over to CI:**
   1. `gh secret set CLOUDFLARE_API_TOKEN`
   2. `gh secret set CLOUDFLARE_ACCOUNT_ID`
   3. Optionally, `gh variable set CI_LINUX_RUNNER` plus a runner registration (see ci-runners).
   4. Push. CI deploys `main` and builds a preview for each PR.

The "under 5 minutes" target covers steps 1, 5 and 6 for an account where step 4 has already been done once. Step 3 depends on the design.

## 14. Live demo and README media

### 14.1 The live demo

- **What it is:** the template's example site, deployed from this repo's `main` by the `deploy` job to `https://cloudflare-site-template.<demo-subdomain>.workers.dev`.
  - It has fabricated content ("Example Co."), `log` delivery and Turnstile's test keys.
  - Preflight passes in demo mode (§11.3).
- **Where it runs:** a **dedicated free Cloudflare account** that holds nothing but the demo.
  - This repo's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` belong to that account.
  - The token is scoped to Workers Scripts:Edit and Account Settings:Read on it.
  - Until the repo is public and the `deploy` job runs, the owner deploys the demo locally with that account's credentials. For example, a terminal with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exported for the demo account, then `npm run deploy`. A `wrangler login` session belongs to whichever account is logged in, so a mix-up would put the demo on the main account.
- **It is honest about being a demo:**
  - A `DemoNotice` strip renders whenever `site.url` is on `example.com`. It says the site is a demo of cloudflare-site-template, that the content is fictional and that the form sends nothing, and links to the repo.
  - Any site that sets its own URL loses the strip automatically, and the `new-site` skill deletes the component.
  - The form works end to end: Turnstile's test widget shows its "testing only" label, and the success message appears.
- **Risk is bounded:**
  - With test keys, the demo form has no real bot protection. But `log` sends nothing, so the worst case is using up the Worker's free daily request quota. Static pages are unaffected either way.
  - Fork PRs never receive secrets, and no workflow uses `pull_request_target`.
  - If the token leaked anyway, through a compromised action or a careless workflow edit, it could reach only the demo account. Actions are SHA-pinned (§10) to make such a leak less likely.

### 14.2 Try it yourself (README "Quick start")

There are three routes. Each puts the example site live on the user's own workers.dev with no secrets and no inputs.

1. **Deploy to Cloudflare button**
   - Markup: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jleavers/cloudflare-site-template)`
   - Cloudflare clones the repo into the user's GitHub account and creates the Worker under a name they choose. It builds and deploys with Workers Builds, using the `build` and `deploy` scripts.
   - The copy's own GitHub Actions run `verify` and `e2e` only, because the copy has no Cloudflare secrets.
   - It requires the repo to be public.
2. **"Use this template"**, then `gh secret set CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then push. The `deploy` job does the rest.
3. **Locally:** `npm ci`, then `npx wrangler login`, then `npm run deploy`.

### 14.3 README media: `tools/screenshots/`

The capture tools are Node scripts using Playwright (already a dev dependency), `sharp` for compositing and `gifenc` for GIF encoding.
- By default they capture `scripts/dev-stack.mjs` locally. `--url` points them at the live demo instead.
- They write to `docs/images/`.
- Each script prints the file size, and exits non-zero when a file is over its limit.
- They run on the owner's machine only, never in CI.

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
  4. a live-demo link and the Deploy button;
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
4. Before flipping visibility, remove the jl-dev-02 runners and the `CI_LINUX_RUNNER` variable from this repo, and update the ci-runners Deployments table. Confirm that this repo's Cloudflare secrets belong to the demo account (§14.1), not the main one.
4a. Run the security sweep (§18) with `baseline` and then `public`, and fix every critical and high cluster before the flip.
5. Set "Template repository" (`gh api -X PATCH repos/jleavers/cloudflare-site-template -F is_template=true`), and make the repo public.
6. Confirm, after the first public push, that CI is green on GitHub-hosted runners and that the `deploy` job redeployed the live demo.
7. Upload `social-preview.png` under Settings → General → Social preview.
8. Test the Deploy button from the public README. Confirm the copy goes live with no secrets prompted. Then the owner deletes the copy's repo and Worker.

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
7. **First deploy:** that a first `wrangler deploy` with `routes: [{ pattern, custom_domain: true }]` succeeds under `wrangler login` (OAuth).
8. **Deploy button.** This can only be checked once the repo is public (§15.8). Check:
   - that Workers Builds accepts the `build` and `deploy` scripts, `run_worker_first` and the `previews` block;
   - that, with no `.dev.vars.example` or `.env.example`, it prompts for nothing;
   - how it applies the user's chosen Worker name to `wrangler.jsonc`.
9. **Media capture:** that `sharp` and `gifenc` together produce a form GIF under 500 KB at a readable width, and that the Turnstile test widget renders under headless Chromium (the e2e tests rely on this too).

## 17. Out of scope for v1

- AWS SES and a generic JSON webhook provider: a new provider is one module behind the same interface.
- Rate limiting and HTTP 429.
- Alpine.js, or any client framework.
- Blog, CMS or content collections, and multiple languages.
- Workers Builds as the CI for stamped-out sites. The Deploy button uses it for a visitor's copy, and the README mentions it in one paragraph as an alternative for anyone short of Actions minutes, but `ci.yml` remains the supported pipeline.
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
- The skill never removes a directory tree. The owner deletes the scratch directory.

**Tests:**
- `tests/sweep/` pins that the workflow compiles, its lane sets and web flags, and that nothing of codervis remains.
- It pins the stage tool profiles, the relay fence (ported from codervis's relay test to ESM vitest), and the exact set of files shipped under `.claude/`.
