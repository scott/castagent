/**
 * Loads the extracted docs data and provides typed accessors.
 * Files are read at build time only — never at runtime in the browser.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type {
  CliCommand,
  Manifest,
  ModelInfo,
  ProviderInfo,
  SlashCommand,
  ChangelogEntry,
} from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
// src/lib/manifest.ts -> docs-site/
const ROOT = resolve(here, '..', '..')
const DATA = join(ROOT, 'data')

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `Missing data file: ${path}\n` +
      `Run \`npm --prefix docs-site run extract\` to regenerate.`
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

let _cli: CliCommand[] | null = null
let _slash: SlashCommand[] | null = null
let _providers: ProviderInfo[] | null = null
let _models: ModelInfo[] | null = null
let _changelog: ChangelogEntry[] | null = null
let _manifest: Manifest | null = null

export function getCliCommands(): CliCommand[] {
  return (_cli ??= readJson<CliCommand[]>(join(DATA, 'cli.json')))
}

export function getSlashCommands(): SlashCommand[] {
  return (_slash ??= readJson<SlashCommand[]>(join(DATA, 'slash.json')))
}

export function getProviders(): ProviderInfo[] {
  return (_providers ??= readJson<ProviderInfo[]>(join(DATA, 'providers.json')))
}

export function getModels(): ModelInfo[] {
  return (_models ??= readJson<ModelInfo[]>(join(DATA, 'models.json')))
}

export function getChangelog(): ChangelogEntry[] {
  return (_changelog ??= readJson<ChangelogEntry[]>(join(DATA, 'changelog.json')))
}

export function getManifest(): Manifest {
  return (_manifest ??= readJson<Manifest>(join(DATA, 'manifest.json')))
}

// --- Lookups ---

export function findCliCommand(idOrFull: string): CliCommand | undefined {
  const all = getCliCommands()
  if (idOrFull.includes(' ')) {
    return all.find(c => c.full === idOrFull)
  }
  // Try topic-qualified first (e.g. "git" — match full starting with "cast git")
  const topicMatch = all.find(c => c.topic === idOrFull && c.full.endsWith(' ' + idOrFull))
  if (topicMatch) return topicMatch
  return all.find(c => c.id === idOrFull)
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  return getSlashCommands().find(c => c.name === name)
}

export function findProvider(key: string): ProviderInfo | undefined {
  return getProviders().find(p => p.key === key)
}
