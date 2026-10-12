// Cloudflare's published always-pass Turnstile test keys. They are safe to commit: they pass
// every challenge and so protect nothing. Never use them for a real site's production config;
// `npm run preflight` refuses a custom-domain deploy that does.
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
