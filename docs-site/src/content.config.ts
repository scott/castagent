import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

/**
 * Section-keyed frontmatter for prose pages.
 *
 * Every prose page belongs to exactly one section. The `section` value
 * also drives the sidebar nav order; `order` is the position within
 * the section. `ref` is an optional list of `{% ref %}` anchors that
 * this page documents — used by the /status page to compute coverage.
 */
const prose = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './content' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    section: z.enum([
      'getting-started',
      'agents',
      'versioning',
      'deployment',
      'tui',
      'configuration',
      'cli',
      'development',
      'guides',
    ]),
    order: z.number().default(100),
    ref: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),
})

export const collections = { prose }
