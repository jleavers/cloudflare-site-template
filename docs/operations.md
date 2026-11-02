# Operations

Running a site built from this template, beyond `npm run preview` and `npm run verify`: what the
build needs, trying real delivery locally, pull-request previews, CI's runners and minutes, and
what a dependency update needs. This file ships unchanged with every site made from the template.
Why every deploy goes through CI, and where its token lives: [the security model](security-model.md).

## Building needs the network

`npm run build` downloads the site's fonts from Google Fonts at build time, through the Astro
Fonts API, so building needs network access, while visitors never contact Google.

## Trying real delivery locally

`npm run preview` never sends a real message. To try real delivery locally, put the settings in
a `.dev.vars` file (gitignored) with a real `TURNSTILE_SECRET_KEY`: the handler refuses a test
secret with any provider but `log`. That secret's widget needs `localhost` among its hostnames, and
`site.ts` its site key. Then run `npm run build` and `npx wrangler dev` yourself. Any package the
build or dev server runs can read that file, so use a restricted, short-lived key for delivery (a
Resend key with sending access only, or a webhook for a test channel, deleted when you're done),
and delete `.dev.vars` afterwards.

## Pull-request previews

Once [turned on](security-model.md#previews), previews use Cloudflare
[Previews](https://developers.cloudflare.com/workers/previews/): each gets its own URL,
Turnstile's test keys and `log` delivery, and is deleted when the pull request closes. On a Resend
site, `wrangler preview` warns that
`CONTACT_TO_EMAIL` and `CONTACT_FROM_EMAIL` are configured for production but not for Previews:
that is intended, because a preview without the addresses cannot send. Leave it. A preview
uploads the pull request's `worker.js` exactly as its build made it, never bundled again, so the
`previews` block in `wrangler.jsonc` can hold bindings and `vars`, but not `define`, which only a
bundle would apply, or `containers`, whose image path could name a file in the directory that holds
the pull request's `dist/`: the preview job refuses both ([why](security-model.md#what-ci-trusts)).

## Short of GitHub Actions minutes?

CI's checks can run on a self-hosted runner (set `CI_LINUX_RUNNER`, private repositories only). On
an Ubuntu 23.10 or later runner, install the AppArmor profile on that machine once, for the
runner's account (`tools/screenshots/README.md`, "Chromium's sandbox"), or its design-fence tests
refuse and deploys wait. Before the repository goes public, remove the runner's registration
(Settings → Actions → Runners), not only the variable: on a public repository a fork's pull
request runs the fork's own workflow file, which can name the runner's `self-hosted` label
directly. The deploy and preview jobs always run on GitHub-hosted runners, because they hold the
Cloudflare token, and so does `verify` on a push to `main`, because it builds what deploys: each
push to `main` spends hosted minutes twice. With none left, a private repository's deploys wait
until the minutes return; a public repository's hosted minutes are free. There is no other way to
deploy ([why](security-model.md#every-deploy-goes-through-ci)).

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens one grouped pull request a month for each of npm,
GitHub Actions and pre-commit, with a seven-day cooldown, the same as `.npmrc`'s release-age floor
([Supply chain](security-model.md#supply-chain)). It updates direct dependencies only. Two kinds of
update fail `npm run verify` by design, so that someone looks before it merges:

- **An action that a job holding the token uses moves.** `tests/unit/ci-workflow.test.ts` pins
  each job that holds the token whole, each action's commit SHA included. Look at the new commit,
  then move its SHA in the test's `TOKEN_ACTIONS` in the same pull request.
- **wrangler moves.** `tests/unit/preview-upload.test.ts` runs wrangler's preview command against
  a stub of Cloudflare's API that answers one wrangler version's requests. In the template it fails
  until `STUB_WRANGLER` names the new version, and the preview runs then fail on any request the
  stub does not expect, so a pass means the preview path still fits. In a site made from the
  template, those preview runs skip instead.

A fix that is only in a transitive dependency (an alert on a package nothing lists directly) needs
a hand update: `npm update <package>` takes the newest release the dependency ranges allow, under
the same release-age floor, and changes only the lockfile. When a dependency raises its Node floor,
raise `engines.node` in `package.json` to match.
