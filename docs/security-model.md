# Security model

What keeps a site built from this template, and the Cloudflare account behind it, safe, and the
parts that are yours to do. This file ships unchanged with every site made from the template.
[`SECURITY.md`](../SECURITY.md) is how to report a way round it.

## The Cloudflare API token

CI deploys with one token: **Account → Workers Scripts → Edit** and **Account → Account Settings →
Read**, limited to one account, and for a custom domain **Zone → Workers Routes → Edit** on that
site's zone alone ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)).
A token with Workers Scripts → Edit can change **every** Worker on its account, so keep the
repositories that hold one to yourself.

## Every deploy goes through CI

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

## A GitHub credential on the build machine

**A GitHub credential on that machine is one step from CI's token.** Code the build runs, which
`ignore-scripts` does not stop (a vite or Astro plugin, say), or an agent working on that machine,
can use any GitHub credential there: your `gh` token, an SSH key, a Git credential helper. And
one that can push to `main` reaches CI's token, because every push to `main` deploys, running that
commit's `scripts/trusted-config.mjs` in the job that holds the token. So build where no such
credential is (a dev container or a VM), or give that machine a credential that can only open pull
requests, with a ruleset requiring another identity's approval on `main` (as for
[coding agents](#coding-agents); a private Free repository has no rulesets). If you work alone and
push to `main` from the machine you build on, this is a residual risk: one bad package version in
your build could deploy through CI.

## What CI trusts

CI hands the token only to jobs that run no code from the branch or the lockfile. They take
`wrangler.jsonc` and the wrangler version from `main` (for a pull request, from the default
branch by name), deploy what a job without the token built, and always run on GitHub-hosted
runners, as does the `verify` run on each push to `main` that builds what deploys. That makes
`main`'s `wrangler.jsonc` part of what you trust: its `assets.directory`, `rules` and `tsconfig`
steer what wrangler reads and uploads, so review a change to it as you would a change to
`.github/workflows/`. Only the bundle's `worker.js` ships: a Worker whose bundle has more modules
(a `.wasm`, text or data import) fails to deploy until the copy step in `ci.yml`, and the test that
pins it, take them too. Wrangler never bundles that file again, nor uploads a source map for it:
its bundler would follow an import in the file to any file on the runner, the token included, and
a source-map comment could name any file there too. The deploy passes `--no-bundle` and
`--upload-source-maps=false`, and a preview runs with a config that `scripts/trusted-config.mjs`
writes from `main`'s, with bundling, source maps and additional modules off. Both jobs also stop if
the directory they upload from holds a symlink.

The jobs that hold the token, and `verify` on each push to `main`, need GitHub-hosted minutes, so
each push to `main` spends them twice. A private repository that has used up its minutes can't
deploy that month: its deploys wait until the minutes return. A public repository's hosted
minutes are free ([Short of GitHub Actions minutes?](operations.md#short-of-github-actions-minutes)).

## Who can reach the token

**Anyone who can merge into `main`, or push a workflow change, can read the token**: every push to
`main` deploys, running that commit's `scripts/trusted-config.mjs` before wrangler. A deploy runs
only for the commit that is `main`'s head when its job starts: the job asks GitHub, with its own
`GITHUB_TOKEN`, and skips (or, if it cannot ask, fails) otherwise, so re-running an older push run
deploys nothing. Only `main`'s own push runs share its concurrency group; a manual run and a pull
request each get a group of their own. Where you store the token decides who else can reach it.

## Where the token lives

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

## Fork pull requests on a public repository

**On every public repository,** set Settings → Actions → General →
"Approval for running fork pull request workflows from contributors" to
**"Require approval for all external contributors"**, and read any change under
`.github/workflows/` in the pull request's diff before approving its run. A fork's pull request
runs its own workflow file, which can name the group that main's runs share and cancel or displace
main's run and its deploy. The workflow cannot stop that; this setting does.

## Previews

**Previews** are off unless you set the repository variable `CI_PREVIEWS` to `true`
(`gh variable set CI_PREVIEWS --body true`). Do that only once the `preview` environment has
required reviewers and holds the token, because a pull request's run uses that pull request's own
workflow file. Each preview then waits for an approval, and so does each deletion of one when
its pull request closes. Previews don't inherit production secrets; don't add any to the
Previews base config. A private site previews locally with `npm run preview` (`log` delivery,
test keys). What a preview does once it runs: [Pull-request previews](operations.md#pull-request-previews).

## Coding agents

If an agent can push branches to the repository ([AGENTS.md](../AGENTS.md#git-workflow) lets it),
give it a **separate GitHub identity**, a machine user or a GitHub App installation, and **never
your own credential**: with yours, an agent can approve nothing, but can merge whatever you could.
Give that identity write access through an **HTTPS token without workflow permission**:
fine-grained with Contents and Pull requests read and write, no Workflows and no Actions write (or
a GitHub App with the same). Not a classic token: with repository access it can re-run workflows.
Don't give it an SSH key either: GitHub refuses a workflow change only from a token that lacks that
permission, and an SSH key, yours or a deploy key, can push anything. Then, where the plan has
rulesets (a public repository, or a private one on a paid plan), require one approval on `main` in a
ruleset (Settings → Rules → Rulesets), dismissing approvals when new commits are pushed, and keep
the agent's identity off its bypass list. On a private Free repository there are no rulesets, so
the agent's Contents write can push to `main`.

## Supply chain

`.npmrc` sets `min-release-age=7`, the same seven days as the Dependabot cooldown, so a hand
`npm install` takes no release younger than a week (`npm ci` installs what the lockfile says,
whatever its age). The setting needs npm 11.10 or later: Node 22's bundled npm (10.x) doesn't know
it and ignores it (silently: npm 10.9.9 printed no warning, and installed the newest versions), so
use Node 24 (`.nvmrc`), whose bundled npm applies it: Node 24.14.1 is the first release that
bundles npm 11.10 or later (24.14.0 bundles 11.9.0). `nvm install` resolves `.nvmrc` to the newest,
but `nvm use` picks the newest 24 already installed, so check that `node --version` prints 24.14.1
or later. Don't upgrade npm itself from the registry, which is outside the lockfile and this
`.npmrc`. Other npm 10 releases may warn about an unknown config key; the floor is still not
applied. CI's token jobs apply the same floor to wrangler-action's install (design spec §10).

**npm runs no install scripts in this repository.** `.npmrc` sets `ignore-scripts=true`, so no
`npm ci` or `npm install`, in CI or on your machine, runs a package's lifecycle scripts, nor the
`node-gyp` build npm infers from a package's `binding.gyp` (which the lockfile does not always
flag). Nothing here needs them: esbuild, workerd and sharp take their binaries from per-platform
packages, and fsevents (macOS only) ships its own, so no package is rebuilt with its scripts on.
`npm run <script>` still runs that script, but never a `pre` or `post` hook of it.

`tests/unit/supply-chain.test.ts`, part of `npm run verify`, checks that every lockfile entry is
the registry tarball for its own name and version with sha512 integrity; that `.npmrc` keeps
`ignore-scripts=true`, that no command in the workflows, `package.json`, the README, these docs,
AGENTS.md or the skills turns install scripts back on, and that `package.json` has no hook script
for npm to skip; that only `esbuild`, `fsevents` and `workerd` declare install scripts (an early
warning: none of them runs, but a new one needs the owner's approval); that every pre-commit `rev`
is a commit SHA; and that the `.npmrc` floor equals the Dependabot cooldown. What a Dependabot pull
request needs before it merges: [Dependency updates](operations.md#dependency-updates).
