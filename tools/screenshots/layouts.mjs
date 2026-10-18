// HTML layouts the capture script renders and photographs. Screenshots arrive as data: URLs, so
// a layout loads nothing from the network. Colours echo the example site's tokens.
const C = { paper: '#f7f8ef', ink: '#1a2e23', brand: '#2f5d46', accent: '#e3c25a', muted: '#4e6055' };

const page = (width, height, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:${width}px;height:${height}px;overflow:hidden;background:${C.paper};color:${C.ink};
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:700;letter-spacing:-0.01em}
.window{border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 30px 60px rgba(20,40,30,.25)}
.bar{height:34px;background:#e8ebdd;display:flex;align-items:center;gap:7px;padding:0 14px}
.bar i{display:block;width:11px;height:11px;border-radius:50%;background:#d1d9c9}
.window img,.phone img{display:block;width:100%}
.points li::before{content:'';display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.accent};margin-right:16px}
.phone{border-radius:34px;border:10px solid ${C.ink};overflow:hidden;background:#fff;box-shadow:0 30px 60px rgba(20,40,30,.3)}
</style></head><body>${body}</body></html>`;

const browserWindow = (src) => `<div class="window"><div class="bar"><i></i><i></i><i></i></div><img src="${src}" alt=""></div>`;

/** hero.png: the desktop site in a browser window, the mobile site in a phone beside it. */
export const hero = (desktop, mobile) =>
  page(1600, 1000, `<div style="position:relative;padding:60px 70px">
    <div style="width:1240px">${browserWindow(desktop)}</div>
    <div class="phone" style="position:absolute;right:70px;top:250px;width:300px"><img src="${mobile}" alt=""></div>
  </div>`);

/** design-to-site.png: a Claude Design screen beside the page built from it. */
export const sideBySide = (design, built) => {
  const column = (label, src) =>
    `<figure style="width:700px"><figcaption style="font-weight:600;margin-bottom:14px;color:${C.muted}">${label}</figcaption>${browserWindow(src)}</figure>`;
  return page(1600, 600, `<div style="display:flex;gap:40px;padding:40px 60px;align-items:flex-start">
    ${column('The Claude Design', design)}
    <div style="align-self:center;font-size:48px;color:${C.brand}">→</div>
    ${column('The site this template built from it', built)}
  </div>`);
};

/** social-preview.png: GitHub's 1280×640 card. */
export const social = (desktop) =>
  page(1280, 640, `<div style="display:flex;height:100%;align-items:center;gap:40px;padding-left:70px;background:${C.brand};color:${C.paper}">
    <div style="width:470px;flex:none">
      <h1 style="font-size:54px;line-height:1.05">cloudflare-site-template</h1>
      <p style="margin-top:22px;font-size:25px;line-height:1.4;opacity:.92">A Claude Design handoff in. A fast site with a working contact form out, on Cloudflare.</p>
    </div>
    <div style="width:820px;flex:none;transform:translateX(40px)">${browserWindow(desktop)}</div>
  </div>`);

/** linkedin-header.png: 1920×1080, copy on the left and the site on the right, as issuebot's. */
export const linkedin = (desktop) =>
  page(1920, 1080, `<div style="display:flex;height:100%;align-items:center;gap:50px;padding-left:100px;background:${C.brand};color:${C.paper}">
    <div style="width:780px;flex:none">
      <h1 style="font-size:76px;line-height:1.05">cloudflare-site-template</h1>
      <p style="margin-top:30px;font-size:34px;line-height:1.4;opacity:.92">A Claude Design handoff in. A fast site with a working contact form out.</p>
      <ul class="points" style="margin-top:40px;font-size:27px;line-height:1.9;list-style:none">
        <li>Static Astro, 100 on Lighthouse</li>
        <li>Turnstile-protected form to email, Slack or Teams</li>
        <li>Opt-in previews for pull requests</li>
        <li>No lock-in: plain HTML, standard handler</li>
      </ul>
    </div>
    <div style="width:1050px;flex:none">${browserWindow(desktop)}</div>
  </div>`);
