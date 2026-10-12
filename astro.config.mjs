import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { site } from './src/config/site.ts';

export default defineConfig({
  site: site.url,
  output: 'static',
  // 'always' inlines the CSS, so no stylesheet blocks rendering; that is Lighthouse's best case
  // for a site of a few pages. The CSP allows inline styles for this (public/_headers).
  build: { format: 'directory', inlineStylesheets: 'always' },
  integrations: [sitemap({ filter: (page) => !/\/404\/?$/.test(new URL(page).pathname) })],
  vite: { plugins: [tailwindcss()] },
});
