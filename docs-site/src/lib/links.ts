/**
 * Resolves `{% ref "..." %}` tags in Markdown before rendering.
 *
 * Anchors supported:
 *   cli:<command-id>      -> /cli/reference#<id>
 *   cli:<topic> <id>      -> /cli/reference#<topic>-<id>
 *   slash:<name>          -> /tui/slash-commands#<name>
 *   provider:<key>        -> /deployment/providers#<key>
 *   page:<section>/<slug> -> /<section>/<slug>
 *
 * Anything else is left untouched so the manifest can grow new anchor kinds
 * without breaking content.
 */

import { findCliCommand, findProvider, findSlashCommand } from './manifest.ts'

const ANCHOR_RE = /\{%\s*ref\s+"([^"]+)"\s*%\}/g

export function resolveRefTags(markdown: string): { md: string; missing: string[] } {
  const missing: string[] = []
  const md = markdown.replace(ANCHOR_RE, (_, anchor: string) => {
    const resolved = resolveOne(anchor)
    if (!resolved) {
      missing.push(anchor)
      return `[missing: ${anchor}]`
    }
    return `[${anchor.split(':').pop()}](${resolved})`
  })
  return { md, missing }
}

function resolveOne(anchor: string): string | null {
  const [kind, ...rest] = anchor.split(':')
  const target = rest.join(':')
  switch (kind) {
    case 'cli': {
      const cmd = findCliCommand(target)
      if (!cmd) return null
      const slug = cmd.full.replace(/^cast /, '').replace(/\s+/g, '-')
      return `/cli/reference#${slug}`
    }
    case 'slash': {
      const cmd = findSlashCommand(target)
      if (!cmd) return null
      return `/tui/slash-commands#${cmd.name.replace(/[^a-z0-9]/gi, '-')}`
    }
    case 'provider': {
      if (!findProvider(target)) return null
      return `/deployment/providers#${target}`
    }
    case 'page': {
      return `/${target.replace(/^\/+/, '')}`
    }
    default:
      return null
  }
}
