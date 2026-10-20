import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Release and version helpers for the TUI slash-command modals.
 *
 * The arithmetic matches python/cast/releases.py `suggest_version` and
 * `validate_semver`. Two-part versions stay numeric, so 1.10 is minor 10
 * and sorts above 1.9. The `(latest)` row is the release whose version
 * equals `releases.json` `current.version`, which is not always index 0.
 */

const SEMVER = /^(?:(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)|(0|[1-9]\d*)\.(0|[1-9]\d*))$/

export interface ReleaseRecord {
  version: string
  message: string
  changelog: string
  created_at: string
  change_number?: number
}

export interface VersionSuggestions {
  patch: string
  minor: string
  major: string
  breaking?: boolean
}

export interface ReleasePickerRow {
  version: string
  message: string
  label: string
  latest: boolean
}

export interface ReleaseFormState {
  /** Text for the Current line. `none` when the agent has no release. */
  currentLabel: string
  suggestions: VersionSuggestions
  /** Preset version, or the patch suggestion when the user did not pass one. */
  version: string
}

export interface LoadedReleases {
  releases: ReleaseRecord[]
  currentVersion: string | null
}

/** Same rule as the CLI `isShaPattern`: 6 lowercase alphanumeric characters. */
export function isDeploymentSha(input: string): boolean {
  return /^[a-z0-9]{6}$/.test(input)
}

/**
 * Typed value from the `/connect` modal.
 *
 * A non-empty string is passed to `cast connect`, which accepts a deployment
 * SHA or an agent name. A partial SHA is included. An empty string means the
 * selected deployment row is used instead.
 */
export function connectTypedTarget(typed: string): string | null {
  return typed.length > 0 ? typed : null
}

/** Python `validate_semver`: `1.0`, `1.10`, and `1.4.1` are valid. `1` and `01.2` are not. */
export function validateSemver(version: string): boolean {
  return SEMVER.test(version)
}

/**
 * Pad a valid semver to (major, minor, patch). `1.10` is (1, 10, 0), which
 * is greater than `1.9` and is not the float 1.1.
 */
export function semverParts(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version)
  if (!match) return null
  if (match[1] !== undefined) {
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  return [Number(match[4]), Number(match[5]), 0]
}

/** Descending numeric semver. Invalid versions sort after valid ones. */
export function compareSemverDescending(left: string, right: string): number {
  const a = semverParts(left)
  const b = semverParts(right)
  if (a && b) {
    if (a[0] !== b[0]) return b[0] - a[0]
    if (a[1] !== b[1]) return b[1] - a[1]
    return b[2] - a[2]
  }
  if (a && !b) return -1
  if (!a && b) return 1
  if (left === right) return 0
  return left < right ? 1 : -1
}

export function sortReleasesDescending<T extends {version: string}>(releases: readonly T[]): T[] {
  return [...releases].sort((left, right) => compareSemverDescending(left.version, right.version))
}

/**
 * Next semver suggestions. Matches `cast.releases.suggest_version`.
 *
 * No current release yields patch and minor `0.1.0` and major `1.0.0`.
 * `1.4.1` yields patch `1.4.2`. `1.10` yields patch `1.10.1`, minor
 * `1.11.0`, and major `2.0.0`. A breaking change keeps those numbers and
 * sets `breaking`.
 */
export function suggestNextVersions(
  currentVersion: string | null | undefined,
  breaking = false,
): VersionSuggestions {
  const parts = currentVersion ? semverParts(currentVersion) : null
  if (!parts) {
    return {patch: '0.1.0', minor: '0.1.0', major: '1.0.0'}
  }
  const [major, minor, patch] = parts
  const suggestions: VersionSuggestions = {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  }
  if (breaking) suggestions.breaking = true
  return suggestions
}

/**
 * True when Python would set `breaking` on the suggestion.
 * A latest change number of 0 skips the scan. Otherwise any change message
 * containing remove, delete, or break counts.
 */
export function changesIndicateBreaking(latestChangeNumber: number, messages: readonly string[]): boolean {
  if (!(latestChangeNumber > 0)) return false
  return messages.some((message) => {
    const text = message.toLowerCase()
    return text.includes('remove') || text.includes('delete') || text.includes('break')
  })
}

export function releasePickerRows(
  releases: readonly {version: string; message?: string}[],
  currentVersion: string | null,
): ReleasePickerRow[] {
  return sortReleasesDescending(releases).map((release) => {
    const latest = currentVersion !== null && release.version === currentVersion
    return {
      version: release.version,
      message: release.message ?? '',
      latest,
      label: latest ? `${release.version} (latest)` : release.version,
    }
  })
}

/** Index of the current release. 0 when no row matches, including an empty list. */
export function latestReleaseIndex(rows: readonly {latest: boolean}[]): number {
  const index = rows.findIndex((row) => row.latest)
  return index >= 0 ? index : 0
}

export function releaseFormState(
  currentVersion: string | null | undefined,
  presetVersion = '',
  breaking = false,
): ReleaseFormState {
  const suggestions = suggestNextVersions(currentVersion, breaking)
  const current = currentVersion && currentVersion.length > 0 ? currentVersion : ''
  return {
    currentLabel: current || 'none',
    suggestions,
    version: presetVersion || suggestions.patch,
  }
}

export function releasesJsonPath(agentName: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.cast', 'agents', agentName, '.cast', 'releases', 'releases.json')
}

function normalizeRelease(entry: unknown): ReleaseRecord | null {
  if (!entry || typeof entry !== 'object') return null
  const version = (entry as {version?: unknown}).version
  if (typeof version !== 'string' || version.length === 0) return null
  const record = entry as {
    message?: unknown
    changelog?: unknown
    created_at?: unknown
    change_number?: unknown
  }
  const normalized: ReleaseRecord = {
    version,
    message: typeof record.message === 'string' ? record.message : '',
    changelog: typeof record.changelog === 'string' ? record.changelog : '',
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
  if (typeof record.change_number === 'number') normalized.change_number = record.change_number
  return normalized
}

/**
 * Read `current.version` when it is a non-empty string. Otherwise the newest
 * valid semver in the releases array, or null when the agent has no releases.
 *
 * Python `get_current_release` does not use that fallback. When `current` is
 * missing, `suggest_version` returns 0.1.0 even if older releases exist.
 */
export function currentReleaseVersion(
  data: unknown,
  releases: readonly {version: string}[],
): string | null {
  if (data && typeof data === 'object') {
    const current = (data as {current?: unknown}).current
    if (typeof current === 'string' && current.length > 0) return current
    if (current && typeof current === 'object') {
      const version = (current as {version?: unknown}).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  }
  const newest = sortReleasesDescending(releases).find((release) => semverParts(release.version))
  return newest ? newest.version : null
}

export function loadReleasesDocument(agentName: string, homeDir: string = os.homedir()): LoadedReleases {
  const file = releasesJsonPath(agentName, homeDir)
  if (!fs.existsSync(file)) return {releases: [], currentVersion: null}
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {releases: [], currentVersion: null}
    }
    const raw = (data as {releases?: unknown}).releases
    const releases = Array.isArray(raw)
      ? raw.map(normalizeRelease).filter((release): release is ReleaseRecord => release !== null)
      : []
    return {
      releases: sortReleasesDescending(releases),
      currentVersion: currentReleaseVersion(data, releases),
    }
  } catch {
    return {releases: [], currentVersion: null}
  }
}

export function agentChangesIndicateBreaking(agentName: string, homeDir: string = os.homedir()): boolean {
  const file = path.join(homeDir, '.cast', 'agents', agentName, '.cast', 'changes', 'changes.json')
  if (!fs.existsSync(file)) return false
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      current?: unknown
      versions?: unknown
    }
    const latest = typeof data.current === 'number' ? data.current : Number(data.current) || 0
    const versions = Array.isArray(data.versions) ? data.versions : []
    const messages = versions.map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      const message = (entry as {message?: unknown}).message
      return typeof message === 'string' ? message : ''
    })
    return changesIndicateBreaking(latest, messages)
  } catch {
    return false
  }
}
