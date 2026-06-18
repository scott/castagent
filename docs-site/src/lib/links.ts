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
 * Both single (`'`) and double (`"`) quotes are accepted around the
 * anchor so authors can use whichever they prefer without worrying
 * about shell-escape gymnastics in code fences.
 *
 * Anything else is left untouched so the manifest can grow new anchor kinds
 * without breaking content.
 */

import { findCliCommand, findProvider, findSlashCommand } from './manifest.ts'

/**
 * Matches `{% ref "<anchor>" %}` or `{% ref '<anchor>' %}`.
 * Captured group 1 is the anchor (e.g. `cli:edit`, `slash:mode`).
 */
export const ANCHOR_RE = /\{%\s*ref\s+["']([^"']+)["']\s*%\}/g

/**
 * Resolve a single anchor to a base-relative URL.
 * Returns `null` for unknown kinds or unresolvable targets.
 */
export function resolveAnchor(anchor: string): string | null {
  const [kind, ...rest] = anchor.split(':')
  const target = rest.join(':')
  switch (kind) {
    case 'cli': {
      const cmd = findCliCommand(target)
      if (!cmd) return null
      const slug = cmd.full.replace(/^cast /, '').replace(/\s+/g, '-')
      return `cli/reference#${slug}`
    }
    case 'slash': {
      const cmd = findSlashCommand(target)
      if (!cmd) return null
      return `tui/slash-commands#${cmd.name.replace(/[^a-z0-9]/gi, '-')}`
    }
    case 'provider': {
      if (!findProvider(target)) return null
      return `deployment/providers#${target}`
    }
    case 'page': {
      return target.replace(/^\/+/, '')
    }
    default:
      return null
  }
}

/**
 * Display label for an anchor — uses the part after the colon
 * (e.g. `cli:edit` -> `edit`, `slash:mode` -> `mode`).
 */
export function anchorLabel(anchor: string): string {
  const idx = anchor.indexOf(':')
  return idx >= 0 ? anchor.slice(idx + 1) : anchor
}

export function resolveRefTags(markdown: string): { md: string; missing: string[] } {
  const missing: string[] = []
  const md = markdown.replace(ANCHOR_RE, (_, anchor: string) => {
    const resolved = resolveAnchor(anchor)
    if (!resolved) {
      missing.push(anchor)
      return `[missing: ${anchor}]`
    }
    return `[${anchorLabel(anchor)}](${resolved})`
  })
  return { md, missing }
}
