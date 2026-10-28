# cloudflare-site-template

[![CI](https://github.com/jleavers/cloudflare-site-template/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jleavers/cloudflare-site-template/actions/workflows/ci.yml?query=branch%3Amain)
[![Licence: Apache 2.0](https://img.shields.io/badge/licence-Apache%202.0-blue.svg)](LICENSE)

**A Claude Design handoff in, a fast website with a working contact form out.** This template
turns a design from [Claude Design](https://claude.ai) and a one-page brief into a static site on
Cloudflare's network: 100 on Lighthouse, no client-side framework, a spam-protected contact form
that emails you or posts to Slack or Teams, and optional previews of pull requests.

![The example site, a fictional garden-design studio called Example Co., shown in a desktop browser window with a cream background, a large serif headline reading "Small gardens, designed to be lived in" and an illustration of green hills under a yellow sun; beside it, the same page on a phone. The content shown is fabricated.](docs/images/hero.png)

**[Open the live demo](https://cloudflare-site-template.84cde4841472e658.workers.dev)**

## Contents

- [How it works](#how-it-works): the pieces, and what the template guarantees
- [Live demo](#live-demo): what it runs, and why its form sends nothing
- [Quick start](#quick-start): the example site live on your own account in a few minutes
- [Stamp out a site](#stamp-out-a-site): design and brief in, live site out
- [One-off setup](#one-off-setup): Turnstile, email, Cloudflare token
- [Configuration reference](#configuration-reference)
- [Development](#development)
- [No lock-in](#no-lock-in)
- [Security](SECURITY.md) · [Licence](#licence)

## How it works

- **The site** is [Astro](https://astro.build) in static mode with [Tailwind CSS](https://tailwindcss.com):
  plain HTML and CSS in `dist/`, fonts and images self-hosted and optimised, no client framework.
- **The Worker** (`src/worker.ts`) serves `dist/` from Cloudflare's edge and handles one route,
  `POST /api/contact`. A request for a file in `dist/` never touches it, so those are free and
  unlimited. A miss (an unknown page, a missing asset) does: the Worker answers it with the 404
  page, uncached, and it counts as a Worker request.
- **The contact form** loads [Turnstile](https://developers.cloudflare.com/turnstile/) only
  when it scrolls into view, then checks a honeypot, the origin, Turnstile and every field before
  delivering through Resend, Slack or Teams. That logic (`src/contact/`) is Web-standard
  TypeScript with no Cloudflare APIs.
- **CI** checks every change and deploys `main`. Once you [turn previews on](#cloudflare-api-token),
  it also gives each pull request its own preview URL, where the form works and sends nothing.
- **A Claude Code skill** (`/new-site`) rebuilds the pages from a Claude Design handoff, and then
  holds the result to the template's contracts.

![On the left, a Claude Design screen for a fictional bakery; on the right, the live page the new-site skill built from it, matching its layout, colours and type. The content shown is fabricated.](docs/images/design-to-site.png)

![Filling in and sending the example site's contact form: the name, email and message fields are typed in, the Turnstile check passes, and the form shows its thank-you message. The content shown is fabricated.](docs/images/contact-form.gif)

**What every site keeps, whatever its design.** The components are yours to rewrite; these are
not, and the tests enforce them (details in [AGENTS.md](AGENTS.md#contracts)):

| | Contract |
|---|---|
| C1 | Design tokens in `global.css`, site facts in `site.ts`, copy in the pages |
| C2 | Fonts and images self-hosted and sized |
| C3 | No client framework; no third-party script but Turnstile |
| C4 | Title, description, canonical and OpenGraph on every page |
| C5 | The contact form's hooks |
| C6 | The form handler uses Web-standard APIs only |
| C7 | Example values and design placeholders never reach a live site (a custom domain, or real delivery) |

## Live demo

[The live demo](https://cloudflare-site-template.84cde4841472e658.workers.dev) runs the example site from this repository's `main`, on a Cloudflare
account used for nothing else. It uses Turnstile's public test keys and `log` delivery, so the
contact form works end to end and sends nothing. The strip at the top of every page says so. The
strip disappears by itself once a site sets its own URL in `src/config/site.ts`; the example content is replaced by the `new-site` skill.

## Quick start

Put the example site live on **your own** Cloudflare account, with no Worker secrets (nothing
for Turnstile or email delivery). The form works and sends nothing until you configure delivery.

1. **Use this template** on GitHub.
2. Open the `production` environment that CI's first run made (Settings → Environments), or
   create it, and limit it to `main`. Store the [CI token](#cloudflare-api-token) and account ID
   in it: `gh secret set CLOUDFLARE_API_TOKEN --env production` and the same for
   `CLOUDFLARE_ACCOUNT_ID`. On a private Free repository, use repository secrets instead
   ([which token, and where, by plan](#cloudflare-api-token)).
3. Check the account's workers.dev subdomain. An account that has never had a Worker may have no
   workers.dev subdomain yet, and CI's wrangler won't register one, so the deploy fails. In the
   Cloudflare dashboard, go to the **Workers & Pages** page and make sure it shows
   **Your subdomain** ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).
   If **Your subdomain** isn't there, choose one there, or open the link the failed deploy prints.
4. Push a commit (`git commit --allow-empty -m "Deploy"` and `git push` will do), or, if you
   made the repository on GitHub's web page, re-run its first CI run from the Actions tab (Re-run
   all jobs). CI's `deploy` job creates the Worker and puts the site on your workers.dev subdomain.

To try it without deploying, `npm ci` and `npm run preview` run the whole site and Worker locally,
with no Cloudflare account at all. Every deploy goes through CI ([why](#cloudflare-api-token)).

## Stamp out a site

You need: a Claude Design handoff (or an archive or artifact link), the facts in
[`SITE_BRIEF.md`](SITE_BRIEF.md), and [Claude Code](https://claude.ai/code).

1. `gh repo create <site> --template jleavers/cloudflare-site-template --private --clone`
   The new repository's first CI run starts straight away. With Actions minutes it passes:
   preflight runs in demo mode, and the deploy skips with a notice until step 5. Dependabot is on
   for the new repository too. On a private repository with no hosted minutes left, the run is
   red, which is harmless: the checks on pull requests can use a self-hosted runner
   (see [Short of GitHub Actions minutes?](#development)), but every push to `main` builds and
   deploys on GitHub-hosted minutes, so until they return, deploys wait.
2. Brief Claude Design with [`design/BRIEFING.md`](design/BRIEFING.md), put its design in
   `design/`, or an extracted folder of it outside the repository ([how](design/README.md)), and
   fill in `SITE_BRIEF.md`.
3. In Claude Code, run `/new-site`. It rebuilds the pages to match the design, then runs every
   check. Review it with `npm run preview`.
4. [One-off setup](#one-off-setup) for the account and domain, if you haven't done it before.
5. First deploy, through CI, like every deploy after it:
   1. Store the CI token and account ID ([which token, and where, by plan](#cloudflare-api-token);
      a custom domain needs one more permission on its zone). First open the `production`
      environment that CI's first run made (Settings → Environments), or create it, and limit it
      to `main`; then `gh secret set CLOUDFLARE_API_TOKEN --env production` and the same for
      `CLOUDFLARE_ACCOUNT_ID`. On a private Free repository, use repository secrets. Check, too,
      that the account has a workers.dev subdomain ([Quick start](#quick-start), step 3).
   2. Push. CI's `deploy` job creates the Worker. With a custom domain, the deploy also attaches
      the domain, DNS record and certificate included, so the domain switches at that push.
      Wrangler asks nothing in CI: it takes over a DNS record that already exists for that
      hostname, or the hostname from another Worker. If the domain already serves a site
      elsewhere, deploy in two pushes, so the form works the moment the domain moves: a first push
      without `routes` in `wrangler.jsonc` (the site goes live on workers.dev only), the secrets
      (step 3), then put `routes` back and push again.
   3. Add the Worker's secrets in the Cloudflare dashboard: the Worker → Settings → Variables and
      Secrets → Add, type **Secret**, for `TURNSTILE_SECRET_KEY` and `RESEND_API_KEY` (or
      `WEBHOOK_URL`), then Deploy. Use type Secret, not Text: the next deploy from CI keeps
      secrets, but replaces every other variable with `wrangler.jsonc`'s. Until this step the form
      refuses every message, because the handler finds its secrets missing. That is expected.
   4. Turn on **Always Use HTTPS** for the domain's zone (dashboard → SSL/TLS → Edge
      Certificates). Preflight can't check that setting, and without it the pages can be fetched
      over http. (The form refuses a cleartext post either way.)
   5. Send yourself a test message from the live site.

   From now on every push to `main` deploys, so anyone who can merge into `main` can read the
   token: give a coding agent its own GitHub identity ([how](#cloudflare-api-token)). Pull-request
   previews are [opt-in](#cloudflare-api-token).

Steps 1 and 5 take under five minutes once step 4 is done. Step 3 depends on the design.

## One-off setup

### HTTPS and HSTS

The template sends `Strict-Transport-Security: max-age=31536000` (`public/_headers`). Turn on
**Always Use HTTPS** for a custom domain's zone, as in step 5 of [Stamp out a site](#stamp-out-a-site).
HSTS preload (`includeSubDomains; preload` in that header, then a submission at hstspreload.org) is a
per-domain choice, not a template default, because it binds every subdomain to HTTPS for a long
time and is slow to undo. Only a preloaded domain is protected on a visitor's very first visit.

### Turnstile

Create a widget in the Cloudflare dashboard (Turnstile → Add widget, managed mode). Its hostnames
are your domain and `<your-subdomain>.workers.dev`, which covers every
preview. A free widget takes up to ten hostnames. Put the **site key** in
`src/config/site.ts`. Keep the **secret** for the Worker's `TURNSTILE_SECRET_KEY`, which you add
in the dashboard once CI's first deploy has made the Worker (step 5 of
[Stamp out a site](#stamp-out-a-site)).

### Delivery

- **Resend:** verify your sending domain (it adds DNS records), create an API key, and set
  `CONTACT_FROM_EMAIL` to an address on that domain. It may carry a display name, as
  `Example Co. <website@example.com>`; preflight reads the domain from inside the `<…>`.
- **Slack:** create an incoming webhook for a channel.
- **Teams:** create a Workflows webhook ("When a Teams webhook request is received") for a
  channel.

### Cloudflare API token

For CI: My Profile → API Tokens → Create Custom Token with **Account → Workers Scripts → Edit**
and **Account → Account Settings → Read**, limited to one account. That is enough to create and
deploy a workers.dev Worker and to deploy previews. A site with a **custom domain** adds
**Zone → Workers Routes → Edit** (Cloudflare's permissions page calls it Write), with the token's
zone resources limited to that site's zone alone: Cloudflare requires it, on each affected zone,
for a deploy that adds, changes or removes a custom domain
([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)).
A token with Workers Scripts → Edit can change **every** Worker on its account, so keep the
repositories that hold one to yourself.

**Every deploy goes through CI, a site's first included.** There is no Deploy to Cloudflare
button, no Workers Builds and no deploy from your own machine, because each of them runs the
lockfile's code (npm's install, `astro build`, vite, the lockfile's own wrangler) beside a
credential that can change every Worker on the account: one bad package version would get that
credential. CI builds without the token, and deploys with no code from the lockfile. The same
goes for your machines: **keep no Cloudflare login or API token on a machine that runs the site's
build or dev server**, since any package the build runs could read it. That is also why Worker
secrets are set in the dashboard. The CI token passes through your machine only once, into
`gh secret set`, which prompts for it: paste it there, and don't save it in a file or your
shell's environment. To clear an old login, run `npx --no wrangler logout` in an installed
checkout of the template (`npm ci` first), so it uses the lockfile's wrangler and downloads none.
It invalidates the OAuth token and deletes the stored credentials. Or delete Wrangler's saved login:
`~/.config/.wrangler/config/default.toml` on Linux,
`~/Library/Preferences/.wrangler/config/default.toml` on macOS,
`%APPDATA%\xdg.config\.wrangler\config\default.toml` on Windows, or
`.wrangler/config/default.toml` under `$XDG_CONFIG_HOME` on any OS where that is set. Where a
legacy `~/.wrangler/` folder exists, on any OS, Wrangler uses it instead, so delete
`~/.wrangler/config/default.toml` too. With keychain storage, delete `default.enc` beside the
file and the keychain entry as well
([Wrangler's login and logout](https://developers.cloudflare.com/workers/wrangler/commands/general/)).
Unset any `CLOUDFLARE_API_TOKEN` your shell profile exports, too.

**A GitHub credential on that machine is one step from CI's token.** Code the build runs, which
`ignore-scripts` does not stop (a vite or Astro plugin, say), or an agent working on that machine,
can use any GitHub credential there: your `gh` token, an SSH key, a Git credential helper. And
one that can push to `main` reaches CI's token, because every push to `main` deploys, running that
commit's `scripts/trusted-config.mjs` in the job that holds the token. So build where no such
credential is (a dev container or a VM), or give that machine a credential that can only open pull
requests, with a ruleset requiring another identity's approval on `main` (as for coding agents,
below; a private Free repository has no rulesets). If you work alone and push to `main` from the
machine you build on, this is a residual risk: one bad package version in your build could deploy
through CI.

CI hands the token only to jobs that run no code from the branch or the lockfile. They take
`wrangler.jsonc` and the wrangler version from `main` (for a pull request, from the default
branch by name), deploy what a job without the token built, and always run on GitHub-hosted
runners, as does the `verify` run on each push to `main` that builds what deploys. That makes `main`'s `wrangler.jsonc` part of what you trust: its `assets.directory`,
`rules` and `tsconfig` steer what wrangler reads and uploads, so review a change to it as you
would a change to `.github/workflows/`. Only the bundle's `worker.js` ships: a Worker whose
bundle has more modules (a `.wasm`, text or data import) fails to deploy until the copy step in
`ci.yml`, and the test that pins it, take them too. Wrangler never bundles that file again, nor
uploads a source map for it: its bundler would follow an import in the file to any file on the
runner, the token included, and a source-map comment could name any file there too. The deploy
passes `--no-bundle` and `--upload-source-maps=false`, and a preview runs with a config that
`scripts/trusted-config.mjs` writes from `main`'s, with bundling, source maps and additional
modules off. Both jobs also stop if the directory they upload from holds a symlink.

**Anyone who can merge into `main`, or push a workflow change, can read the token**: every push to
`main` deploys, running that commit's `scripts/trusted-config.mjs` before wrangler. A deploy runs
only for the commit that is `main`'s head when its job starts: the job asks GitHub, with its own
`GITHUB_TOKEN`, and skips (or, if it cannot ask, fails) otherwise, so re-running an older push run
deploys nothing. Only `main`'s own push runs share its concurrency group; a manual run and a pull
request each get a group of their own. Where you store the token decides who else can reach it:

- **Public repository (any plan), or private on GitHub Enterprise:** in Settings → Environments,
  open the environment `production` that CI's first run made (with no rules), or create it, and
  limit its deployment branches to `main`. Then give it the token and account ID as environment
  secrets: `gh secret set CLOUDFLARE_API_TOKEN --env production` and
  `gh secret set CLOUDFLARE_ACCOUNT_ID --env production`. On a repository with no runs yet, that
  command fails with a 404 until you create the environment. For previews, put the same two secrets
  in an environment `preview` with required reviewers. Then delete the repository-level copies
  (`gh secret delete CLOUDFLARE_API_TOKEN`, and the same for `CLOUDFLARE_ACCOUNT_ID`).
- **Private on Pro or Team:** the `production` environment as above. Leave previews off: these
  plans have no required reviewers for a private repository.
- **Private on Free:** there are no environment secrets, so the token stays a repository secret
  (`gh secret set CLOUDFLARE_API_TOKEN`). The deploy still runs: its job names `production`, and
  the repository secret resolves there (checked on a private repository). There are no rulesets
  either, so any identity with Contents write can push to `main`.

**On every public repository,** set Settings → Actions → General →
"Approval for running fork pull request workflows from contributors" to
**"Require approval for all external contributors"**, and read any change under
`.github/workflows/` in the pull request's diff before approving its run. A fork's pull request
runs its own workflow file, which can name the group that main's runs share and cancel or displace
main's run and its deploy. The workflow cannot stop that; this setting does.

The jobs that hold the token, and `verify` on each push to `main`, need GitHub-hosted minutes, so
each push to `main` spends them twice. A private repository that has used up its minutes can't
deploy that month: its deploys wait until the minutes return. A public repository's hosted
minutes are free.

**Previews** are off unless you set the repository variable `CI_PREVIEWS` to `true`
(`gh variable set CI_PREVIEWS --body true`). Do that only once the `preview` environment has
required reviewers and holds the token, because a pull request's run uses that pull request's own
workflow file. Each preview then waits for an approval, and so does each deletion of one when
its pull request closes. Previews don't inherit production secrets; don't add any to the
Previews base config. A private site previews locally with `npm run preview` (`log` delivery,
test keys).

**Coding agents:** if an agent can push branches to the repository
([AGENTS.md](AGENTS.md#git-workflow) lets it), give it a **separate GitHub identity**, a machine
user or a GitHub App installation, and **never your own credential**: with yours, an agent can
approve nothing, but can merge whatever you could. Give that identity write access through an
**HTTPS token without workflow permission**: fine-grained with Contents and Pull requests read and
write, no Workflows and no Actions write (or a GitHub App with the same). Not a classic token: with
repository access it can re-run workflows. Don't give it an SSH key either: GitHub refuses a
workflow change only from a token that lacks that permission, and an SSH key, yours or a deploy key,
can push anything. Then, where the plan has rulesets (a public repository, or a private one on a
paid plan), require one approval on `main` in a ruleset (Settings → Rules → Rulesets), dismissing
approvals when new commits are pushed, and keep the agent's identity off its bypass list. On a
private Free repository there are no rulesets, so the agent's Contents write can push to `main`.

## Configuration reference

| Where | Name | What |
|---|---|---|
| `src/config/site.ts` | `site` | name, title, description, URL, language, navigation, contact, legal, privacy, analytics |
| `src/styles/global.css` | `@theme` | colours, fonts, radii |
| `astro.config.mjs` | `fonts` | font families and weights (self-hosted at build) |
| `wrangler.jsonc` vars | `DELIVERY_PROVIDER` | `resend`, `slack`, `teams` or `log` |
| | `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL` | Resend's recipient and sender |
| | `TURNSTILE_FAIL_OPEN` | `true` lets messages through when Turnstile is unreachable (default `false`) |
| Worker secrets, set in the dashboard | `TURNSTILE_SECRET_KEY` | always |
| | `RESEND_API_KEY` or `WEBHOOK_URL` | for the provider |
| GitHub secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | for CI deploys and previews: in the `production` and `preview` environments, or repository secrets on a private Free repository ([where](#cloudflare-api-token)) |
| GitHub variables | `CI_LINUX_RUNNER` | optional: a self-hosted runner label (private repositories only: remove the runner itself before going public, [why](#development)) for `e2e`, `preview-build`, and the pull-request and dispatch runs of `verify` |
| | `CI_PREVIEWS` | optional: `true` turns on pull-request previews, once the `preview` environment has required reviewers ([why](#cloudflare-api-token)) |

## Development

| Command | Does |
|---|---|
| `npm run dev` | Astro's dev server, pages only |
| `npm run preview` | the whole site and Worker locally, with Turnstile's test keys and `log` delivery |
| `npm run verify` | type check, unit tests, build, contract tests on the build |
| `npm run test:e2e` | the browser tests (Playwright, Chromium). On Ubuntu 23.10 or later, install the AppArmor profile first (`tools/screenshots/README.md`, "Chromium's sandbox"), or its six design-fence tests refuse; where that isn't possible (no `sudo`), CI's e2e is the check |
| `npm run lighthouse` | the Lighthouse budgets; performance must score 100 |
| `npm run preflight` | is this checkout still the template, or does a built page still have a `[bracketed]` design placeholder? Example values are refused once the site is live: a custom domain, or `DELIVERY_PROVIDER` set to `resend`, `slack` or `teams` (CI runs it to decide whether a deploy may go ahead; build first) |

`npm run build` downloads the site's fonts from Google Fonts at build time, through the Astro
Fonts API, so building needs network access, while visitors never contact Google.

`npm run preview` never sends a real message. To try real delivery locally, put the settings in
a `.dev.vars` file (gitignored) with a real `TURNSTILE_SECRET_KEY`: the handler refuses a test
secret with any provider but `log`. That secret's widget needs `localhost` among its hostnames, and
`site.ts` its site key. Then run `npm run build` and `npx wrangler dev` yourself. Any package the
build or dev server runs can read that file, so use a restricted, short-lived key for delivery (a
Resend key with sending access only, or a webhook for a test channel, deleted when you're done),
and delete `.dev.vars` afterwards.

**Pull-request previews**, once [turned on](#cloudflare-api-token), use Cloudflare
[Previews](https://developers.cloudflare.com/workers/previews/): each gets its own URL,
Turnstile's test keys and `log` delivery, and is deleted when the pull request closes. On a Resend site, `wrangler preview` warns that
`CONTACT_TO_EMAIL` and `CONTACT_FROM_EMAIL` are configured for production but not for Previews:
that is intended, because a preview without the addresses cannot send. Leave it. A preview
uploads the pull request's `worker.js` exactly as its build made it, never bundled again, so the
`previews` block in `wrangler.jsonc` can hold bindings and `vars`, but not `define`, which only a
bundle would apply, or `containers`, whose image path could name a file in the directory that holds
the pull request's `dist/`: the preview job refuses both ([why](#cloudflare-api-token)).

**Short of GitHub Actions minutes?** CI's checks can run on a self-hosted runner (set
`CI_LINUX_RUNNER`, private repositories only). On an Ubuntu 23.10 or later runner, install the
AppArmor profile on that machine once (`tools/screenshots/README.md`, "Chromium's sandbox"), or its
design-fence tests refuse and deploys wait. Before the repository goes public, remove the
runner's registration (Settings → Actions → Runners), not only the variable: on a public
repository a fork's pull request runs the fork's own workflow file, which can name the runner's
`self-hosted` label directly. The deploy and preview jobs always run on
GitHub-hosted runners, because they hold the Cloudflare token, and so does `verify` on a push to
`main`, because it builds what deploys: each push to `main` spends hosted minutes twice. With none
left, a private repository's deploys wait until the minutes return; a public repository's hosted
minutes are free. There is no other way to deploy ([why](#cloudflare-api-token)).

**Supply chain.** `.npmrc` sets `min-release-age=7`, the same seven days as the Dependabot
cooldown, so a hand `npm install` takes no release younger than a week (`npm ci` installs what the
lockfile says, whatever its age). The setting needs npm 11.10 or later: Node 22's bundled npm
(10.x) doesn't know it and ignores it (silently: npm 10.9.9 printed no warning, and installed the
newest versions), so use Node 24 (`.nvmrc`), whose bundled npm applies it: Node 24.14.1 is the
first release that bundles npm 11.10 or later (24.14.0 bundles 11.9.0). `nvm install` resolves
`.nvmrc` to the newest, but `nvm use` picks the newest 24 already installed, so check that
`node --version` prints 24.14.1 or later. Don't upgrade npm itself from the registry, which is
outside the lockfile and this `.npmrc`. Other npm 10 releases may warn
about an unknown config key; the floor is still not applied. CI's token jobs apply the same floor
to wrangler-action's install (design spec §10).

**npm runs no install scripts in this repository.** `.npmrc` sets `ignore-scripts=true`, so no
`npm ci` or `npm install`, in CI or on your machine, runs a package's lifecycle scripts, nor the
`node-gyp` build npm infers from a package's `binding.gyp` (which the lockfile does not always
flag). Nothing here needs them: esbuild, workerd and sharp take their binaries from per-platform
packages, and fsevents (macOS only) ships its own, so no package is rebuilt with its scripts on.
`npm run <script>` still runs that script, but never a `pre` or `post` hook of it.

`tests/unit/supply-chain.test.ts`, part of `npm run verify`, checks that every lockfile entry is
the registry tarball for its own name and version with sha512 integrity; that `.npmrc` keeps
`ignore-scripts=true`, that no command in the workflows, `package.json`, this README, AGENTS.md or
the skills turns install scripts back on, and that `package.json` has no hook script for npm to
skip; that only `esbuild`, `fsevents` and `workerd` declare install scripts (an early warning: none
of them runs, but a new one needs the owner's approval); that every pre-commit `rev` is a commit
SHA; and that the `.npmrc` floor equals the Dependabot cooldown.
`tests/unit/ci-workflow.test.ts` pins each job that holds the token whole, each action's commit SHA
included, so Dependabot's monthly Actions update fails `verify` when it moves one of those actions:
look at the new commit, then move its SHA in the test's `TOKEN_ACTIONS` in the same pull request.

## No lock-in

- **The site** is `dist/`: plain HTML, CSS and images. `aws s3 sync dist s3://<bucket>`, or
  any static server (Caddy, Nginx) serves it unchanged.
- **The form handler** is `handleContact(request, env, { fetch })` in `src/contact/handler.ts`:
  Web-standard `Request` in, `Response` out, about 300 lines with no dependencies. On any runtime
  that speaks those APIs it is a one-liner, for example on Deno:
  `Deno.serve((request) => handleContact(request, Deno.env.toObject(), { fetch }))`. On AWS
  Lambda, put it behind a Request/Response adapter, or translate it: it is a pipeline of seven
  plain steps ([spec §7.3](docs/superpowers/specs/2026-10-12-cloudflare-site-template-design.md)).

## Licence

The template is licensed under the [Apache License 2.0](LICENSE). A site you build from it is
yours: its content, design and copy belong to you.
