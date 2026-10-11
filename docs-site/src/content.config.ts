import { defineCollection, z } from 'astro:content'
import { proseLoader } from './lib/proseLoader.ts'

/**
 * Section-keyed frontmatter for prose pages.
 *
 * Every prose page belongs to exactly one section. The `section` value
 * also drives the sidebar nav order; `order` is the position within
 * the section. `ref` is an optional list of `{% ref %}` anchors that
 * this page documents — used by the /status page to compute coverage.
 *
 * `{% ref "..." %}` tags inside the page body are resolved against the
 * extracted manifest by `proseLoader` (a thin wrapper around the stock
 * `glob` loader) before the markdown reaches `render()`. We do this in
 * the loader because Astro's `glob` loader does not honor
 * `markdown.remarkPlugins` for content collections, and there is no
 * public `transform` hook on the loader — the only supported way to
 * pre-process glob-loaded bodies is to wrap the loader.
 */
const prose = defineCollection({
  loader: proseLoader(),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    section: z.enum([
      'getting-started',
      'building-agents',
      'configuration',
    ]),
    group: z.string().optional(),
    order: z.number().default(100),
    ref: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),
})

export const collections = { prose }

