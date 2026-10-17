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

    node tools/screenshots/capture.mjs --only design --design <bundle>/project/<artboard>.dc.html --site https://<site>

The script prints each file's size and exits non-zero if one is over its limit. The dials are
`--width` (the GIF's width, 800) and `--colours` (its palette, 64).

**The social preview is uploaded by hand**: GitHub takes it only through the web interface, under
Settings → General → Social preview.

## What is not pinned

`npx playwright install chromium` downloads browser builds that Playwright names by revision but
does not verify against a hash. The pinned `@playwright/test` version fixes *which* builds are
requested, not what arrives. Only TLS to Playwright's CDN stands behind them. They are needed
only to regenerate these images or to run the browser tests.
