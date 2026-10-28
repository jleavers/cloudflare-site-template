# README media

`docs/images/` holds the README's pictures. They are captured from the template's example
site, **whose content is fabricated**: Example Co., its testimonials and the message typed into
the form are invented, and the form runs with `log` delivery, so nothing is sent anywhere.

| File | What it shows | Limit |
|---|---|---|
| `hero.png` | the example site at desktop and phone width | 600 KB |
| `contact-form.gif` | filling in and sending the contact form | 500 KB |
| `design-to-site.png` | a Claude Design screen beside the site built from it (the end-to-end test site) | 600 KB |
| `social-preview.png` | GitHub's 1280×640 card | 1 MB (GitHub's) |
| `linkedin-header.png` | a 1920×1080 header for a post about the project | 1 MB |

## Regenerating

Regenerate after a change to the example site's look. The script starts the local stack itself
(`scripts/dev-stack.mjs`):

    npm run screenshots                                  # all but design-to-site
    npm run screenshots -- --only gif --width 720        # one file, smaller
    npm run screenshots -- --url https://<live demo>     # from the deployed demo instead

`design-to-site.png` needs a design screen and the site built from it:

    node tools/screenshots/capture.mjs --only design --design <bundle>/project/<artboard>.dc.html --bundle <bundle> --site https://<site>

The script prints each file's size and exits non-zero if one is over its limit. The dials are
`--width` (the GIF's width, 800) and `--colours` (its palette, 64).

## One design screen

`--only screen` photographs a single design screen into a PNG of its own, for the new-site
skill's comparisons (`.claude/skills/new-site/SKILL.md`, steps 2 and 8). It needs no `--site`,
starts no stack, and writes nothing to `docs/images/`:

    node tools/screenshots/capture.mjs --only screen --design "design/bundle/<screen>" --bundle design/bundle --out tools/screenshots/out/<name>.png
    node tools/screenshots/capture.mjs --only screen --design "design/bundle/<screen>" --bundle design/bundle --width 390 --height 844 --out tools/screenshots/out/<name>-390.png

`--width` and `--height` set the viewport here (1440 × 900 by default). `--bundle` names the
bundle's folder, which must hold the screen. It defaults to the screen's own folder, so name the
bundle's root when the screen uses files in a sibling folder (`../assets/`).

A design screen is untrusted. `--only screen` and `--only design` render it with JavaScript on,
only inside Chromium's OS sandbox (below), in a browser of its own (`design.mjs`). There it may
load only files inside `--bundle`, judged by resolved path with symlinks followed, and reaches no
network at all: no `https:` or `http:` URL, no WebSocket, WebTransport or WebRTC, no speculative
prefetch. Its browser resolves no host name or address and has only a proxy that goes nowhere,
and it refuses to run if `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set. A screen
that loads React or Babel from a CDN renders without them. `tests/e2e/design-fence.spec.ts`
attacks the renderer with a hostile screen, behind that proxy and behind a live one.

**The social preview is uploaded by hand**: GitHub takes it only through the web interface, under
Settings → General → Social preview.

## Chromium's sandbox

The OS sandbox is the boundary: the fences above live inside Chromium, and stop nothing once a
screen's script finds a bug in the renderer. So `design.mjs` launches Chromium with its sandbox
required. Where the sandbox cannot start, `--only screen` and `--only design` refuse and say why;
they never render without it.

Windows and macOS need nothing. Ubuntu 23.10 and later restrict unprivileged user namespaces
(`sysctl -n kernel.apparmor_restrict_unprivileged_userns` prints `1`), which the sandbox needs,
unless an AppArmor profile grants them to the browser. `playwright-chromium.apparmor` in this
folder is that profile, in the shape of Ubuntu's own for Google Chrome. The person installs it,
once per machine, from the repository root (an agent never runs `sudo`):

    sudo install -m 0644 tools/screenshots/playwright-chromium.apparmor /etc/apparmor.d/playwright-chromium
    sudo apparmor_parser -r /etc/apparmor.d/playwright-chromium

It names Playwright's default browser folder, `~/.cache/ms-playwright/`, so it does not cover
browsers installed elsewhere, with `PLAYWRIGHT_BROWSERS_PATH` or under an `XDG_CACHE_HOME` of
their own. The trade-off: it lets any program at those paths, which the person's own account can
write, create user namespaces, so it gives back part of what Ubuntu's restriction takes away for
that account. Without it, design screens are read as source on that machine. Chromium also
refuses its sandbox to root, on any Linux: run as an ordinary user, not as root in a container.
CI's `e2e` job installs the same profile on a GitHub-hosted runner, and keeps the browsers in the
folder it names; on a self-hosted runner without it, the design-fence tests refuse, and so deploys
wait.

## What is not pinned

`npx playwright install chromium` downloads browser builds that Playwright names by revision but
does not verify against a hash. The pinned `@playwright/test` version fixes *which* builds are
requested, not what arrives. Only TLS to Playwright's CDN stands behind them. They are needed to
regenerate these images, to render a design screen with `--only screen` (the new-site skill does,
in steps 2 and 8), and to run the browser tests.
