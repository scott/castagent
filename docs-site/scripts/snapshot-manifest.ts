#!/usr/bin/env tsx
/**
 * snapshot-manifest.ts — combine the four extracted JSON files into a
 * single "next" manifest. The committed manifest.json is the baseline;
 * the "next" file is what the docs would render right now. `validate`
 * compares the two and surfaces a diff.
 *
 * The committed manifest.json is the source of truth for the docs build,
 * so the build reads only the "current" data; the "next" file is purely
 * for the sync check.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const DATA = join(REPO, 'docs-site', 'data')

function load<T>(file: string): T {
  const p = join(DATA, file)
  if (!existsSync(p)) {
    throw new Error(`missing ${p} — run npm run extract first`)
  }
  return JSON.parse(readFileSync(p, 'utf8')) as T
}

interface Manifest {
  generatedAt: string
  cli: { id: string; full: string; description: string }[]
  slash: { name: string; category: string; description: string }[]
  providers: { key: string; name: string }[]
  models: { id: string; provider: string; family: string; inferenceProvider: string }[]
  changelog: { version: string; date: string }[]
}

const cli       = load<any[]>('cli.json')
const slash     = load<any[]>('slash.json')
const providers = load<any[]>('providers.json')
const models    = load<any[]>('models.json')
const changelog = load<any[]>('changelog.json')

const manifest: Manifest = {
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  cli:       cli.map((c) => ({ id: c.id, full: c.full, description: c.description })),
  slash:     slash.map((c) => ({ name: c.name, category: c.category, description: c.description })),
  providers: providers.map((p) => ({ key: p.key, name: p.name })),
  models:    models.map((m) => ({
    id: m.id,
    provider: m.provider,
    family: m.family,
    inferenceProvider: m.inferenceProvider,
  })),
  changelog: changelog.map((c) => ({ version: c.version, date: c.date })),
}

writeFileSync(join(DATA, 'manifest.next.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote next manifest with ${manifest.cli.length} CLI + ${manifest.slash.length} slash + ${manifest.providers.length} providers + ${manifest.models.length} models + ${manifest.changelog.length} releases`)

