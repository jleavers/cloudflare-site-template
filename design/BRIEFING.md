# Briefing Claude Design

Claude Design never needs to know about hosting, the form backend or the build: the `new-site`
skill turns whatever it produces into the template's shape. But a short brief that states the
template's constraints up front makes the design map cleanly onto the template, instead of
`/new-site` having to work around a JavaScript carousel, three font families or a form with
fields the handler doesn't take.

Copy the brief below into Claude Design and fill in the `<placeholders>`.

```markdown
Design a small marketing website for **<business name>**, <one sentence: what it is and what it
offers>. Audience: <who visits, and on what device>. Tone: <three or four adjectives>; <what to
avoid>.

**Pages and sections**
- Home, one page with anchored sections: <hero; section; section; …; questions (4–5); contact>.
- Privacy page: a simple text page.
- 404 page: "page not found", with a link home.
- Header with the name and links to the sections; footer with legal line, privacy link and
  social links.

**Constraints (the site is a fast static site)**
- No app-style interactivity. Use anchor links, an accordion for the questions, and a
  simple mobile menu. No carousels, sliders, modals or animation that depends on JavaScript.
- Contact form: exactly three fields (name, email, message) and a submit button. Leave a
  space about 300×65 px above the button for a spam-check widget. Show how the form looks
  while sending, after success, and with an error under a field.
- Type: at most two Google Fonts families (one display, one body), with as few weights as
  you need.
- Colour: a small palette, each colour with a stated role: page background, card or field
  surface, text, muted text, brand, text on brand, accent, borders, error. Text must meet
  WCAG AA contrast.
- Imagery: original illustration or abstract artwork you create. No stock photos or
  logos you don't own. Give each image's aspect ratio.
- Show every page at 390 px (phone) and 1440 px (desktop).
- Where you don't know a fact (phone number, address, opening hours, a customer's name), show
  it as a `[Bracketed placeholder]`; don't invent it.

**Handoff:** when it's done, share it. Use Handoff to Claude Code if Claude Design offers it;
otherwise Share → copy private link. I'll build it with an existing Astro template that keeps
your layout, colours and type exactly.
```

When the design is done, put its handoff or private link on the first line of `design/SOURCE.md`
(see [README.md](README.md)).

## Why each constraint

- **No JavaScript widgets:** C3, no client framework.
- **Three form fields and space for the widget:** C5, plus Turnstile.
- **Google Fonts only:** C2. The Astro Fonts API self-hosts them at build time.
- **A palette with roles:** C1. `/new-site` writes each role straight into the `@theme` tokens.
- **`[Bracketed placeholders]` for unknown facts:** the design never invents a phone number or a
  customer. Production preflight (C7) refuses any `[bracketed]` text left in the built pages, so
  none goes live by accident.
- **Original art:** keeps the repository and the site free of licensing questions.
- **Both widths:** gives `/new-site` something to compare its result against at each width.
