// @ts-check
import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'

// Cast docs site — Astro static output for GitHub Pages.
// `site` is the production URL; the workflow overwrites it via env if needed.
const SITE = process.env.PUBLIC_SITE_URL ?? 'https://cast.dev'

export default defineConfig({
  site: SITE,
  base: process.env.PUBLIC_SITE_BASE ?? '/',
  trailingSlash: 'ignore',
  integrations: [mdx()],
  output: 'static',
  build: {
    format: 'directory',
  },
  vite: {
    // The extraction scripts run via `tsx`; keep the docs site itself
    // self-contained and don't share the cast-cli node_modules.
    ssr: { noExternal: [] },
  },
})
