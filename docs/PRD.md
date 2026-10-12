# 1. Purpose & Vision

> **Status:** the original requirements. The [design spec](superpowers/specs/2026-10-12-cloudflare-site-template-design.md) refines them, and where the two differ the spec wins; its §2 lists every difference and why.

Build out a reusable, zero-lock-in GitHub Template Repository (cloudflare-site-template) for stamping out high-performance marketing sites, micro-sites, and landing pages with integrated contact forms.

The template must optimize for **five core principles**:

-   **5-Minute Stamp-Out:** Cloning the repo to a live production URL takes under 5 minutes.

-   **Sub-50ms Edge Performance:** 100/100 Lighthouse performance out of the box (Zero client-side JS by default).

-   **GitOps Deployment:** Push-to-deploy via GitHub Actions with automatic PR preview environments.

-   **Infrastructure & Code Sovereignty:** Build outputs are standard static HTML/CSS (dist/) plus a single Web-Standards Fetch API handler (~60 lines) that can be lifted to AWS S3/Lambda, Caddy, or any host in under 30 minutes.

-   **AI-Assistant Native:** Structured specifically so AI coding agents (Claude Code, Codex, Cursor) can generate copy, create pages, adjust styling, and verify builds without hallucinating complex framework state.

# 2. Target Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Static Generator** | **Astro 5.x** (Static output mode) | Compiles .astro components to pure HTML/CSS with zero client JS by default; intuitive single-file component structure for AI assistants. |
| **Styling** | **Tailwind CSS v4** | Utility-first CSS co-located in markup; prevents AI assistants from creating fragmented CSS files. |
| **Client Interactivity** | **Vanilla JS / Alpine.js** (Optional) | Used strictly for progressive enhancement (mobile menu toggle, form submission state). No React runtime shipped. |
| **Hosting & Edge** | **Cloudflare Workers (Static Assets)** | Serves static dist/ from 300+ edge locations with unlimited free static requests and instant cache purge. |
| **Form Backend** | **Cloudflare Worker (src/worker.ts)** | Co-located edge handler routing POST /api/contact while serving static assets for all other routes. |
| **Spam Protection** | **Cloudflare Turnstile + Honeypot** | Free, privacy-preserving bot mitigation without annoying CAPTCHA puzzles. |
| **Email / Notification** | **Pluggable HTTP Provider** (AWS SES v2 API, Resend, or Slack/Teams Webhook) | Uses standard fetch() calls over HTTPS---zero Node.js SDK bloat required at the edge. |
| **CI/CD** | **GitHub Actions + Wrangler CLI** | Full control over the build and deployment pipeline inside .github/workflows/deploy.yml. |

# 3. Repository Directory Structure

The repository must strictly adhere to this flat, predictable tree so AI coding agents can navigate it with minimal token overhead:

```text
cloudflare-site-template/
├── .github/
│   └── workflows/
│       └── deploy.yml            # CI/CD: Lint, Astro build, Wrangler deploy (Prod + PR Previews)
├── public/
│   ├── favicon.svg
│   └── robots.txt
├── src/
│   ├── components/               # Reusable, stateless UI blocks
│   │   ├── Header.astro
│   │   ├── Hero.astro
│   │   ├── Features.astro
│   │   ├── Testimonials.astro
│   │   ├── FAQ.astro
│   │   ├── ContactForm.astro     # Pre-wired with Turnstile, honeypot, and fetch state
│   │   └── Footer.astro
│   ├── config/
│   │   └── site.ts               # Single source of truth for site metadata, nav, and theme tokens
│   ├── layouts/
│   │   └── BaseLayout.astro      # SEO meta tags, OpenGraph, canonical URLs, JSON-LD schema
│   ├── pages/
│   │   ├── index.astro           # Main landing page composed of components
│   │   ├── privacy.astro         # Standard privacy policy template
│   │   └── 404.astro             # Custom error page
│   ├── styles/
│   │   └── global.css            # Tailwind imports and custom font/theme variables
│   └── worker.ts                 # Edge entry point: intercepts POST /api/contact, falls back to static assets
├── AGENTS.md                     # Instructions and guardrails for AI coding assistants (symlinked to CLAUDE.md)
├── astro.config.mjs              # Configured for pure static build (`output: 'static'`)
├── package.json
├── tsconfig.json
└── wrangler.jsonc                # Cloudflare configuration-as-code (routes, bindings, static assets dir)
```

# 4. Functional Requirements

## 4.1 Centralized Site Configuration (src/config/site.ts)

To make stamping out a new site effortless, all site-specific variables must live in one strongly-typed file:

-   name, title, description, url (used automatically by BaseLayout.astro for SEO, OpenGraph, and sitemap.xml).

-   contact: Email recipient address, form success message, and public turnstileSiteKey.

-   navigation: Array of header and footer links.

-   socials & legal: Company registration details, copyright year, and privacy contact.

## 4.2 Contact Form Architecture (ContactForm.astro + src/worker.ts)

The contact form must work reliably, resist spam, and remain portable:

1.  **Frontend (ContactForm.astro):**

    -   Fields: name (required), email (required), message (required), \_gotcha (hidden CSS honeypot field), and cf-turnstile-response (injected by Cloudflare Turnstile script).

    -   Submits asynchronously via fetch('/api/contact', { method: 'POST', body: FormData }) with inline loading, success, and error banners, plus a graceful non-JS fallback.

2.  **Backend Edge Handler (src/worker.ts):**

    -   Intercepts POST /api/contact (returns 405 Method Not Allowed for non-POST requests to /api/\*).

    -   All other paths delegate directly to env.ASSETS.fetch(request) (served free from Cloudflare's edge cache).

    -   **Validation Pipeline:**

        i.  Verify Origin header matches allowed site domain.

        ii. Check honeypot field (\_gotcha must be empty).

        iii. Verify cf-turnstile-response token against the Cloudflare Turnstile siteverify endpoint (/turnstile/v0/siteverify) using secret env.TURNSTILE_SECRET_KEY. (Include a configurable fail-open/fail-closed flag in case Turnstile's verification API is unreachable).

        iv. Sanitize and validate name, email, and message length.

        v.  Dispatch notification via HTTPS fetch to the configured delivery provider (e.g., Resend API, AWS SES v2 endpoint, or a Slack/Teams incoming webhook).

        vi. Return structured JSON { ok: true, message: "\..." } with appropriate HTTP status (200, 400, 429, 500).

## 4.3 SEO, Performance & Compliance Baseline

-   **Automatic Sitemap & Robots:** Configured via \@astrojs/sitemap.

-   **Zero External Tracker Bloat:** No third-party analytics scripts by default (rely on Cloudflare Web Analytics at the edge, which requires zero client cookies or GDPR cookie banners).

-   **Asset Optimization:** Astro \<Image/\> component enforced for automatic WebP/AVIF conversion and explicit width/height attributes to eliminate Cumulative Layout Shift (CLS).

# 5. CI/CD & Infrastructure-as-Code Requirements

## 5.1 Configuration as Code (wrangler.jsonc)

All Cloudflare settings must reside in wrangler.jsonc in the repo root (no manual dashboard clicking required after project creation):

```jsonc
{
  "name": "REPLACE_WITH_SITE_SLUG",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page"
  },
  "vars": {
    "ALLOWED_ORIGIN": "YOUR_SITE_ORIGIN",
    "CONTACT_TO_EMAIL": "hello@yourdomain.tld"
  }
}
```

*Secrets (TURNSTILE_SECRET_KEY, EMAIL_API_KEY, WEBHOOK_URL) are never stored in wrangler.jsonc; they are injected via wrangler secret put or GitHub Actions encrypted secrets.*

## 5.2 GitHub Actions Workflow (.github/workflows/deploy.yml)

-   **Triggers:**

    -   push to main -\> Builds Astro and deploys to the **Production** route.

    -   pull_request to main -\> Builds Astro and deploys an isolated **Preview URL** (\<branch\>-\<site\>.\<subdomain\>.workers.dev), commenting the preview link onto the PR.

-   **Required GitHub Repository Secrets:**

    -   CLOUDFLARE_API_TOKEN (Scoped strictly to Workers Scripts:Edit and Account Settings:Read)

    -   CLOUDFLARE_ACCOUNT_ID

# 6. AI Coding Assistant Ergonomics (AGENTS.md / CLAUDE.md)

The template repository must include an AGENTS.md file (with CLAUDE.md pointing to it) containing explicit rules for AI coding assistants:

1.  **No Unapproved Dependencies:** Do not install React, Vue, or UI component libraries (shadcn, mui). Build all sections using standard .astro files and Tailwind classes.

2.  **Design Token Consistency:** Read brand colors, typography, and spacing from src/styles/global.css and src/config/site.ts.

3.  **Portability Guardrail:** Keep src/worker.ts strictly aligned with standard Web Fetch APIs (Request, Response, fetch, FormData). Do not introduce proprietary storage bindings (KV, D1, Durable Objects) unless explicitly instructed.

4.  **Verification Command:** Always run npm run check && npm run build after modifying any component to verify TypeScript and Astro static compilation before finishing a task.

# 7. "Stamp Out a New Site" Runbook (Target Workflow)

Once this template repo is built, launching a new site follows a deterministic 5-step checklist:

1.  **Create Repo:** Run gh repo create my-new-site \--template \<you\>/cloudflare-site-template \--private \--clone.

2.  **Update Identity:** Edit wrangler.jsonc (name, ALLOWED_ORIGIN) and src/config/site.ts (site name, domain, copy).

3.  **Prompt AI Assistant:** *"Using AGENTS.md, customize the landing page in src/pages/index.astro and src/config/site.ts for \[Brand X\], using a \[Color Palette\] theme."*

4.  **Set Secrets:** Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (can be set once at the GitHub Organization level) and run npx wrangler secret put TURNSTILE_SECRET_KEY + npx wrangler secret put EMAIL_API_KEY.

5.  **Push & Bind Domain:** Push to main. Attach the custom domain in wrangler.jsonc (routes: \[{ pattern: "newsite.tld", custom_domain: true }\])---Cloudflare automatically provisions the DNS record and edge TLS certificate.

# 8. Exit Strategy (De-Risking Lock-In)

To prove complete sovereignty, the repository must maintain two escape hatches:

-   **Static Hosting Escape:** npm run build outputs a pure static HTML/CSS bundle in ./dist that can be synced to an AWS S3 bucket (aws s3 sync ./dist s3://bucket) or served by a local Caddy/Nginx container with zero code changes.

-   **Form Backend Escape:** Because src/worker.ts uses only the standard Web Request/Response API and fetch(), the ~60 lines of validation and email dispatch logic can be wrapped in a standard Python FastAPI endpoint or AWS Lambda function in less than 15 minutes.
