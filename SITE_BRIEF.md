# Site brief

The facts and copy for one site. Fill it in, put the site's Claude Design handoff in `design/`
(see `design/README.md`), then run `/new-site` in Claude Code. Other agents can follow
`.claude/skills/new-site/SKILL.md` directly.

**Where this brief and the design disagree, this brief wins.** Anything you leave blank is taken
from the design, and anything neither covers keeps the template's example. Leave a line blank
rather than deleting it.

This copy describes the template's own example site, **Example Co., which is fictional**.

## 1. Identity

- **Site name:** Example Co.
- **Slug** (the Worker's name and the first part of its workers.dev address: lowercase letters, digits and hyphens, at most 50 characters): cloudflare-site-template
- **Production domain** (for example `www.example.org`; leave blank to stay on workers.dev for now):
- **workers.dev subdomain** (your account's, from Workers & Pages; needed when there's no production domain):
- **Language** (BCP 47, for example `en-GB`): en-GB
- **One-sentence description** (search results and link previews): Example Co. is a fictional garden-design studio. It shows what cloudflare-site-template builds: a fast static site with a working contact form on Cloudflare.

## 2. Contact form

- **Delivery** (`resend`, `slack` or `teams`; the example uses `log`, which sends nothing): log
- **Send messages to** (Resend only):
- **Send from** (Resend only; an address on a domain you have verified in Resend, optionally with a display name, for example `Example Co. <website@example.com>`):
- **Message shown after sending** (optional `{email}` is replaced with the visitor's address): Thank you — your message is on its way. We’ll reply to {email} within two working days.
- **Public email address** (optional; shown if the form can't work):  hello@example.com

## 3. Legal and privacy

- **Company name:** Example Co. Ltd
- **Registration** (optional, for example "Registered in England & Wales no. 01234567"): A fictional company, used to demonstrate this template.
- **Registered address** (optional):
- **Privacy contact email:** privacy@example.com
- **How long you keep messages, and where:** This demonstration site keeps nothing: a message is discarded as soon as it arrives, and nobody reads it.
- **Who else handles visitors' data** (Cloudflare always does; add your email or chat provider): Cloudflare, Inc.

## 4. Business details (optional)

Facts a design for a shop or café often shows. Leave a line blank if the design doesn't show it.

- **Phone:**
- **Public address** (where customers come, as distinct from the registered address):
- **Opening hours:**

## 5. Navigation and socials

- **Header links** (label → target): Services → /#services; Stories → /#stories; Questions → /#faq; Contact → /#contact
- **Footer links:** Privacy → /privacy/
- **Social profiles** (label → URL): Source on GitHub → https://github.com/jleavers/cloudflare-site-template

## 6. Page copy (optional)

Leave any part blank to use the design's copy.

### Hero
### Services or features
### Testimonials (real ones only, with permission)
### Questions and answers
### Contact section

## 7. Notes

Audience, tone of voice, words to avoid, anything the design doesn't show. For example: "Warm
and plain-spoken; no jargon. Most visitors arrive on a phone."
