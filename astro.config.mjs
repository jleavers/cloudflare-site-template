import { defineConfig, fontProviders } from 'astro/config';
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
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-inter',
      weights: [400, 600, 700],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'Fraunces',
      cssVariable: '--font-fraunces',
      weights: [600],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['Georgia', 'serif'],
    },
  ],
  vite: {
    plugins: [tailwindcss()],
    // Never inline a script or an image as a data: URI. The CSP allows no inline script, and
    // contract C2 expects every raster under /_astro/.
    build: { assetsInlineLimit: 0 },
  },
});
