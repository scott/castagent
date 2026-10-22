#!/usr/bin/env tsx
/**
 * extract-providers.ts — read deployment provider metadata and known models,
 * and write data/providers.json + data/models.json.
 *
 * Sources:
 *   - typescript/cast-cli/src/lib/deploy/providers.manifest.json
 *   - python/cast/providers/manifest.json (`knownModels` on each row)
 *
 * supportsWithTui comes from the manifest. Do not infer it from deploy.ts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const MANIFEST = join(REPO, 'typescript', 'cast-cli', 'src', 'lib', 'deploy', 'providers.manifest.json')
const INFERENCE_MANIFEST = join(REPO, 'python', 'cast', 'providers', 'manifest.json')
const DATA = join(REPO, 'docs-site', 'data')

if (!existsSync(MANIFEST) || !existsSync(INFERENCE_MANIFEST)) {
  console.error(`source files not found`)
  process.exit(1)
}

interface ProviderInfo {
  key: string
  name: string
  description: string
  cliCommand: string
  cliInstallUrl: string
  authCommand?: string
  authEnvVar?: string
  supportsWithTui: boolean
}

interface ModelInfo {
  id: string
  /** Vendor segment of the id. Same split as typescript/cast-cli/src/lib/models.ts. */
  provider: string
  family: string
  /** Manifest row key, for example `openrouter`. */
  inferenceProvider: string
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '')
}

interface ManifestEntry {
  key: string
  name: string
  description: string
  cliCommand: string
  cliInstallUrl: string
  authCommand?: string
  authEnvVar?: string
  supportsWithTui?: boolean
}

// --- providers ---

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[]
const providers: ProviderInfo[] = manifest.map(entry => {
  const info: ProviderInfo = {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    cliCommand: entry.cliCommand,
    cliInstallUrl: entry.cliInstallUrl,
    supportsWithTui: entry.supportsWithTui === true,
  }
  if (entry.authCommand) info.authCommand = entry.authCommand
  if (entry.authEnvVar) info.authEnvVar = entry.authEnvVar
  return info
})

providers.sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(join(DATA, 'providers.json'), JSON.stringify(providers, null, 2) + '\n')
console.log(`extracted ${providers.length} providers -> data/providers.json`)

// --- models ---
// Built-in known ids only. External providers are not written into the docs site.

interface ManifestRow {
  key: string
  knownModels?: string[]
}

const inferenceManifest = JSON.parse(readFileSync(INFERENCE_MANIFEST, 'utf8')) as ManifestRow[]
const models: ModelInfo[] = []
for (const row of inferenceManifest) {
  for (const raw of row.knownModels ?? []) {
    // Format is "openrouter/<provider>/<model>" or "anthropic/claude-sonnet-4.6".
    // Strip one leading openrouter/ and split on the first slash, matching
    // modelInfo() in typescript/cast-cli/src/lib/models.ts.
    // inferenceProvider is the manifest row key so the site can label the
    // catalog that owns the id.
    const stripped = raw.replace(/^openrouter\//, '')
    const slash = stripped.indexOf('/')
    let provider: string
    let family: string
    if (slash === -1) {
      provider = stripped
      family = stripped
    } else {
      provider = stripped.slice(0, slash)
      family = stripped.slice(slash + 1)
    }
    models.push({ id: raw, provider, family, inferenceProvider: row.key })
  }
}
models.sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(join(DATA, 'models.json'), JSON.stringify(models, null, 2) + '\n')
console.log(`extracted ${models.length} known models -> data/models.json`)
