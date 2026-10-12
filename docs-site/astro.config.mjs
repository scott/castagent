// @ts-check
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'

// Cast docs site — Astro static output for GitHub Pages.
// `site` is the production URL; the workflow overwrites it via env if needed.
const SITE = process.env.PUBLIC_SITE_URL ?? 'https://castagent.dev'
const here = dirname(fileURLToPath(import.meta.url))

// Current builds read the root package.json. Snapshot builds set DOCS_VERSION
// to the release tag so the frozen pages keep that version.
function docsVersion() {
  const override = process.env.DOCS_VERSION
  if (override && override.trim()) return override.trim().replace(/^v/, '')
  const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'))
  if (!pkg.version) throw new Error('root package.json has no version')
  return String(pkg.version)
}

const DOCS_VERSION = docsVersion()
process.env.PUBLIC_DOCS_VERSION = DOCS_VERSION

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
    define: {
      'import.meta.env.PUBLIC_DOCS_VERSION': JSON.stringify(DOCS_VERSION),
    },
    // The extraction scripts run via `tsx`; keep the docs site itself
    // self-contained and don't share the cast-cli node_modules.
    ssr: { noExternal: [] },
  },
})
