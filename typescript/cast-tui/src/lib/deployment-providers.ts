import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {createRequire} from 'module'
import yaml from 'yaml'

export interface DeploymentProviderChoice {
  key: string
  name: string
  desc: string
}

interface ManifestEntry {
  key: string
  name: string
  description: string
  order?: number
}

const KEY_PATTERN = /^[a-z0-9-]+$/

function truncate(description: string): string {
  if (description.length > 50) return description.slice(0, 50) + '...'
  return description
}

function choice(key: string, name: string, description: string): DeploymentProviderChoice {
  return {key, name, desc: truncate(description)}
}

function manifestPath(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '../../../cast-cli/src/lib/deploy/providers.manifest.json'),
    path.resolve(__dirname, '../../../../cast-cli/src/lib/deploy/providers.manifest.json'),
    path.resolve(process.cwd(), 'typescript/cast-cli/src/lib/deploy/providers.manifest.json'),
  ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

function readManifest(): ManifestEntry[] {
  const file = manifestPath()
  if (!file) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestEntry[]
    return [...parsed].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  } catch {
    return []
  }
}

function nodeRequire(): NodeRequire {
  const base = fs.existsSync(path.join(process.cwd(), 'package.json'))
    ? path.join(process.cwd(), 'package.json')
    : __filename
  return createRequire(base)
}

function expandHome(entry: string): string {
  if (entry === '~') return os.homedir()
  if (entry.startsWith('~/')) return path.join(os.homedir(), entry.slice(2))
  return entry
}

function resolveConfigEntry(entry: string, require: NodeRequire): string | undefined {
  try {
    const isPath =
      entry.startsWith('~/') ||
      entry === '~' ||
      path.isAbsolute(entry) ||
      entry.startsWith('./') ||
      entry.startsWith('../') ||
      entry.endsWith('.cjs') ||
      entry.endsWith('.js')
    if (!isPath) return require.resolve(entry)
    const expanded = expandHome(entry)
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  } catch {
    return undefined
  }
}

function unwrap(loaded: unknown): {key?: string; name?: string; description?: string; deploy?: unknown} | undefined {
  if (!loaded || typeof loaded !== 'object') return undefined
  const record = loaded as {key?: string; name?: string; description?: string; deploy?: unknown; default?: unknown}
  if (typeof record.key === 'string' && typeof record.deploy === 'function') return record
  const inner = record.default
  if (inner && typeof inner === 'object') {
    const candidate = inner as {key?: string; name?: string; description?: string; deploy?: unknown}
    if (typeof candidate.key === 'string' && typeof candidate.deploy === 'function') return candidate
  }
  return undefined
}

/**
 * External providers append after the manifest. A bad file or a key that
 * collides with a built-in is skipped so the picker still opens. The CLI
 * commands fail the whole command instead.
 */
function discoverExternals(seen: Set<string>): DeploymentProviderChoice[] {
  const extras: DeploymentProviderChoice[] = []
  const require = nodeRequire()

  const accept = (filePath: string, folderName?: string) => {
    let loaded: unknown
    try {
      loaded = require(filePath)
    } catch {
      return
    }
    const provider = unwrap(loaded)
    if (!provider?.key || !KEY_PATTERN.test(provider.key)) return
    if (folderName && provider.key !== folderName) return
    if (seen.has(provider.key)) return
    seen.add(provider.key)
    extras.push(choice(provider.key, provider.name || provider.key, provider.description || ''))
  }

  const root = path.join(os.homedir(), '.cast', 'providers')
  if (fs.existsSync(root)) {
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      names = []
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      const filePath = path.join(root, name, 'provider.cjs')
      if (!fs.existsSync(filePath)) continue
      accept(filePath, name)
    }
  }

  const configPath = path.join(os.homedir(), '.cast', 'config.yaml')
  if (fs.existsSync(configPath)) {
    try {
      const config = yaml.parse(fs.readFileSync(configPath, 'utf8')) || {}
      const entries = config.deploymentProviders
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (typeof entry !== 'string' || !entry.trim()) continue
          const resolved = resolveConfigEntry(entry, require)
          if (!resolved || !fs.existsSync(resolved)) continue
          accept(resolved)
        }
      }
    } catch {
      // A broken config must not hide the built-in picker.
    }
  }

  return extras
}

function loadProviders(): DeploymentProviderChoice[] {
  const builtins = readManifest().map(entry => choice(entry.key, entry.name, entry.description))
  const seen = new Set(builtins.map(provider => provider.key))
  return [...builtins, ...discoverExternals(seen)]
}

export const DEPLOYMENT_PROVIDERS: DeploymentProviderChoice[] = loadProviders()

/** Display name for a stored provider key. Unknown keys are shown as stored. */
export function providerDisplayName(key: string | null | undefined): string {
  if (!key) return '-'
  const match = DEPLOYMENT_PROVIDERS.find((provider) => provider.key === key)
  return match ? match.name : key
}

/** Map a number key to a provider index. 1 selects the first entry. */
export function providerIndexForNumberKey(keyName: string | undefined, count = DEPLOYMENT_PROVIDERS.length): number | null {
  if (!keyName || !/^[0-9]+$/.test(keyName)) return null
  const num = parseInt(keyName, 10)
  if (num < 1 || num > count) return null
  return num - 1
}
