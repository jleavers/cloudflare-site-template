# Security policy

## Reporting a vulnerability

**Please report privately, through [GitHub's private vulnerability
reporting](https://github.com/jleavers/cloudflare-site-template/security/advisories/new).** The
report becomes a draft advisory that only you and the maintainer can see. Please don't open a
public issue for a vulnerability.

Include the commit, what an attacker can reach, and the smallest sequence that shows it. A clear
description of the mechanism is worth more than a working exploit. There is no bounty and no
guaranteed response time; this is a personal project, and you can expect an acknowledgement
within a few days.

## In scope

- **The contact handler** (`src/contact/`, `src/worker.ts`): a way past the same-origin check, the
  honeypot or Turnstile; a submission that injects headers, mentions or markup into what the
  site owner receives; a request that makes the Worker read unbounded input or leak
  configuration, secrets or another visitor's data in a response or a log.
- **The template's defaults**: a CSP or header in `public/_headers` that lets third-party script
  run; a default that ships Turnstile test keys or `log` delivery to a live site (a custom domain,
  or real delivery) past `npm run preflight`.
- **The CI workflow**: a way for a pull request from a fork to obtain the Cloudflare token, write
  to the repository, or run on a self-hosted runner; or a preview job that uploads anything but
  the handed-over `worker.js` bytes, with the pull request's built `dist/` as its assets, such as
  a file that a pull request's build makes wrangler read from the runner.
- **The design tools**: a Claude Design bundle that gets past `tools/design-ingest/ingest.mjs`
  (a link, an unsafe path, agent instructions or another entry outside its allow-list written into
  `design/bundle/`, or a file written there that an editor or build tool loads as code, such as a
  stylesheet whose `@plugin` Tailwind runs); a design screen that, rendered through
  `tools/screenshots/design.mjs`, reaches a file outside its bundle, or any network.
- **The agent instructions** (`AGENTS.md`, `.claude/`): text in a Claude Design bundle, a site
  brief or an issue that makes an agent following them widen its own authority: run commands
  the instructions forbid, change CI, secrets or deploy settings, or exfiltrate data.

## Not in scope

- Sites built from this template. Each belongs to its owner; report to them.
- Spam that passes Turnstile: that is Cloudflare's to judge, and the honeypot and validation are
  best-effort extras.
- Anything that needs the site owner's Cloudflare, GitHub or email-provider credentials.
- The live demo's form accepting messages: it uses Turnstile's public test keys and sends nothing,
  by design (README "Live demo").
