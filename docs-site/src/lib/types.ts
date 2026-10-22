/**
 * Shared types for the auto-generated docs data.
 * These mirror the shape of `data/*.json`, produced by the scripts/extract-* scripts.
 */

export interface FlagSpec {
  name: string
  char?: string
  description?: string
  type: 'boolean' | 'string' | 'integer'
  required?: boolean
  default?: unknown
  multiple?: boolean
  options?: string[]
}

export interface ArgSpec {
  name: string
  description?: string
  required?: boolean
  default?: string
}

export interface CliCommand {
  /** command id, e.g. "new", "deploy" */
  id: string
  /** full topic path, e.g. "git" or "meta test" */
  topic: string
  /** "cast new" or "cast git init" */
  full: string
  description: string
  examples: string[]
  flags: FlagSpec[]
  args: ArgSpec[]
  /** source file path, relative to repo root */
  source: string
}

export interface SlashCommand {
  name: string
  description: string
  category: 'chat' | 'agent' | 'session' | 'git'
  args?: string
  modes?: Array<'dev' | 'production' | 'on-host'>
  /** notes extracted from JSDoc/handler signature, free text */
  notes?: string
  source: string
}

export interface ProviderInfo {
  key: string
  name: string
  description: string
  cliCommand: string
  cliInstallUrl: string
  authCommand?: string
  authEnvVar?: string
  supportsWithTui: boolean
}

export interface ModelInfo {
  id: string
  /** Vendor segment of the id, matching `cast model --list --json`. */
  provider: string
  family: string
  /** Manifest row key from python/cast/providers/manifest.json. */
  inferenceProvider: string
}

export interface ChangelogEntry {
  version: string
  date: string
  added: string[]
  fixed: string[]
  changed: string[]
  deprecated: string[]
  removed: string[]
  security: string[]
  documentation: string[]
  /** raw markdown below the version heading, for verbatim rendering */
  raw: string
  /** the PR number this release was published under, if discoverable */
  pr?: number
}

export interface Manifest {
  generatedAt: string
  cli: { id: string; full: string; description: string }[]
  slash: { name: string; category: string; description: string }[]
  providers: { key: string; name: string }[]
  models: { id: string; provider: string; family: string; inferenceProvider: string }[]
  changelog: { version: string; date: string }[]
}
