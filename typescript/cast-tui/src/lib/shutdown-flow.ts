import {providerDisplayName} from './deployment-providers.js'

export const NO_DEPLOYED_AGENTS_MESSAGE = 'No deployed agents to shut down.'
export const CAST_CLI_NOT_FOUND_MESSAGE = 'cast CLI not found. Install cast first.'
export const SHUTDOWN_SUCCESS_STATUS = 'Shutdown completed!'

export interface ShutdownDeploymentView {
  agentName: string
  provider: string | null | undefined
  id: string | null | undefined
  deployedVersion: string | null | undefined
  deployedAt: string | Date | number | null | undefined
}

/** First 8 characters of a deployment id. Empty ids render as '-'. */
export function shortDeploymentSha(id: string | null | undefined): string {
  if (id == null) return '-'
  const trimmed = String(id).trim()
  if (!trimmed) return '-'
  return trimmed.slice(0, 8)
}

export function deploymentVersionLabel(version: string | null | undefined): string {
  if (version == null) return '-'
  const trimmed = String(version).trim()
  return trimmed.length > 0 ? trimmed : '-'
}

/**
 * Argv for the TUI-confirmed shutdown. --force skips the CLI y/N prompt.
 * The agent name is one argument so spawn does not go through a shell.
 */
export function shutdownSpawnArgs(agentName: string): string[] {
  return ['shutdown', '--force', agentName]
}

/**
 * ESC closes the streaming modal and must not signal the child.
 * The shutdown keeps running after the modal is gone.
 */
export function shouldKillShutdownOnEscape(): boolean {
  return false
}

export function shutdownFailureStatus(code: number | null): string {
  return `Shutdown failed (exit code: ${code})`
}

const SHUTDOWN_STAGES: Array<{includes: string; stage: string}> = [
  {includes: 'shutting down', stage: 'Destroying remote resources'},
  {includes: 'remote resources destroyed', stage: 'Removing local records'},
  {includes: 'marked all deployments', stage: 'Updating database'},
  {includes: 'removed auth token', stage: 'Removing credentials'},
  {includes: 'has been shut down', stage: 'Finished'},
]

/** Map a cast shutdown log line to a status-bar stage, or null if none. */
export function shutdownStageFromLine(line: string): string | null {
  const lower = line.toLowerCase()
  for (const entry of SHUTDOWN_STAGES) {
    if (lower.includes(entry.includes)) return entry.stage
  }
  return null
}

function parseDeployedAt(value: string | Date | number | null | undefined): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS" with no zone suffix.
  const sqlite = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed)
  if (sqlite) {
    const ms = sqlite[7] ? Number(sqlite[7].padEnd(3, '0').slice(0, 3)) : 0
    const date = new Date(Date.UTC(
      Number(sqlite[1]),
      Number(sqlite[2]) - 1,
      Number(sqlite[3]),
      Number(sqlite[4]),
      Number(sqlite[5]),
      Number(sqlite[6]),
      ms,
    ))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function pluralAgo(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

/**
 * Relative time for a deployment row.
 * compact: "3d ago". long: "3 days ago". Missing or invalid values are "-".
 */
export function formatRelativeTime(
  value: string | Date | number | null | undefined,
  now: Date = new Date(),
  style: 'compact' | 'long' = 'compact',
): string {
  const date = parseDeployedAt(value)
  if (!date) return '-'
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  const hours = Math.floor(diffMs / 3_600_000)
  const days = Math.floor(diffMs / 86_400_000)
  const years = Math.floor(days / 365)
  if (minutes < 60) return style === 'compact' ? `${minutes}m ago` : pluralAgo(minutes, 'minute')
  if (hours < 24) return style === 'compact' ? `${hours}h ago` : pluralAgo(hours, 'hour')
  if (years < 1) return style === 'compact' ? `${days}d ago` : pluralAgo(days, 'day')
  return style === 'compact' ? `${years}y ago` : pluralAgo(years, 'year')
}

function labeledField(label: string, value: string): string {
  const prefix = `  ${label}:`
  const pad = Math.max(1, 13 - prefix.length)
  return prefix + ' '.repeat(pad) + value
}

/** Y/N confirmation body. Copy matches the shutdown modal, including the warning. */
export function shutdownConfirmationLines(view: ShutdownDeploymentView, now: Date = new Date()): string[] {
  return [
    `Shut down '${view.agentName}'?`,
    labeledField('Provider', providerDisplayName(view.provider)),
    labeledField('Version', deploymentVersionLabel(view.deployedVersion)),
    labeledField('Deployed', formatRelativeTime(view.deployedAt, now, 'long')),
    labeledField('SHA', shortDeploymentSha(view.id)),
    '',
    '  This will destroy the remote droplet and',
    '  all associated resources. This cannot be undone.',
    '',
    '  [Y] Yes, shut it down    [N] Cancel',
  ]
}
