#!/usr/bin/env tsx
/**
 * validate-manifest.ts — sanity check the extracted data.
 *
 * Steps:
 *   1. Load the committed manifest.json (the baseline) and the fresh
 *      manifest.next.json (what the docs would render right now).
 *   2. Compute added / removed sets across each section.
 *   3. If anything changed, print a markdown diff and exit 0 (CI surfaces
 *      this as a PR comment). Exits 1 only on a hard error.
 *   4. Verify every ref tag in content markdown resolves against the
 *      fresh manifest. Missing targets are hard errors (exit 1).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const DATA = join(REPO, 'docs-site', 'data')
const CONTENT = join(REPO, 'docs-site', 'content')

const HEAD = process.env.GITHUB_STEP_SUMMARY
const summary: string[] = []

function load(file: string): any {
  return JSON.parse(readFileSync(join(DATA, file), 'utf8'))
}

const current = load('manifest.json')
const next    = load('manifest.next.json')

// --- diff ---

function diff<T extends { [k: string]: any }>(
  label: string,
  keyOf: (item: any) => string,
  describe: (item: any) => string,
  cur: T[],
  nxt: T[],
) {
  const curSet = new Map(cur.map((c) => [keyOf(c), c]))
  const nxtSet = new Map(nxt.map((c) => [keyOf(c), c]))
  const added   = [...nxtSet.keys()].filter((k) => !curSet.has(k))
  const removed = [...curSet.keys()].filter((k) => !nxtSet.has(k))
  if (added.length === 0 && removed.length === 0) return

  summary.push(`### ${label}`)
  if (added.length > 0) {
    summary.push(`**Added (${added.length}):**`)
    for (const k of added) summary.push(`- \`${k}\` — ${describe(nxtSet.get(k))}`)
  }
  if (removed.length > 0) {
    summary.push(`**Removed (${removed.length}):**`)
    for (const k of removed) summary.push(`- \`${k}\` — ${describe(curSet.get(k))}`)
  }
  summary.push('')
}

diff('CLI commands',
  (c) => c.full,
  (c) => c.description,
  current.cli, next.cli,
)
diff('TUI slash commands',
  (c) => '/' + c.name,
  (c) => c.description,
  current.slash, next.slash,
)
diff('Deployment providers',
  (c) => c.key,
  (c) => c.name,
  current.providers, next.providers,
)
diff('Known models',
  (c) => c.id,
  () => '',
  current.models, next.models,
)
diff('Changelog',
  (c) => 'v' + c.version,
  (c) => c.date,
  current.changelog, next.changelog,
)

if (summary.length > 0) {
  const md = `## Docs manifest diff\n\n${summary.join('\n')}`
  console.log(md)
  if (HEAD) writeFileSync(HEAD, md + '\n', { flag: 'a' })
}

// --- ref-tag validation ---

if (existsSync(CONTENT)) {
  const files = walk(CONTENT)
  const missing: string[] = []
  const RE = /\{%\s*ref\s+"([^"]+)"\s*%\}/g
  for (const f of files) {
    if (!f.endsWith('.md') && !f.endsWith('.mdx')) continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(RE)) {
      const anchor = m[1]
      if (!refExists(anchor)) missing.push(`${f}: ${anchor}`)
    }
  }
  if (missing.length > 0) {
    console.error('\nMissing {% ref %} targets:')
    for (const m of missing) console.error('  ' + m)
    process.exit(1)
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true } as any) as any) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function refExists(anchor: string): boolean {
  const [kind, target] = anchor.split(':')
  switch (kind) {
    case 'cli':       return next.cli.some((c: any) => c.id === target || c.full === 'cast ' + target || c.full.endsWith(' ' + target))
    case 'slash':     return next.slash.some((c: any) => c.name === target)
    case 'provider':  return next.providers.some((p: any) => p.key === target)
    case 'page': {
      const slug = target.replace(/^\/+/, '').replace(/\/$/, '')
      return existsSync(join(CONTENT, slug + '.md')) || existsSync(join(CONTENT, slug + '.mdx'))
        || existsSync(join(REPO, 'docs-site', 'src', 'pages', slug + '.astro'))
        || existsSync(join(REPO, 'docs-site', 'src', 'pages', slug, 'index.astro'))
    }
    default: return false
  }
}
