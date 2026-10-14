/**
 * Which on-disk agent `/git`, `/undo`, `/redo`, `/describe`, and
 * `/releases` should touch.
 *
 * `cast new` opens the TUI as "Cast Builder", which is the wizard, not
 * an agent directory. After `create_agent` runs it records the new name
 * in `~/.cast/builder/created-agent`. Commands read that file. Before
 * an agent exists they say so, instead of operating on "Cast Builder".
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const NO_AGENT_LOADED_MESSAGE = 'No agent is loaded.'

/** `cast new` passes this name to the TUI. It is not an agent directory. */
export const BUILDER_SESSION_NAME = 'Cast Builder'

/** Builder JSON-RPC initialize uses this placeholder. */
export const BUILDER_INTERNAL_NAME = '__new__'

/**
 * Allow a small clock gap so a marker written as the TUI is opening
 * still counts as part of this session.
 */
export const CREATED_AGENT_CLOCK_SKEW_MS = 1500

/**
 * execFileSync copies a child's stderr onto the parent terminal unless
 * stdio is set. That paints CLI errors over the TUI input line.
 */
export const CAPTURED_CHILD_STDIO = ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe']

export function isBuilderSessionName(name: string): boolean {
  return name === BUILDER_SESSION_NAME || name === BUILDER_INTERNAL_NAME
}

export function defaultAgentsDir(): string {
  return path.join(os.homedir(), '.cast', 'agents')
}

export function defaultCreatedAgentMarkerPath(): string {
  return path.join(os.homedir(), '.cast', 'builder', 'created-agent')
}

export function isFreshTimestamp(atMs: number, sessionStartedAtMs: number): boolean {
  return atMs + CREATED_AGENT_CLOCK_SKEW_MS >= sessionStartedAtMs
}

export function directoryCreatedAtMs(stat: {birthtimeMs: number; mtimeMs: number}): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
}

export interface CreatedAgentCandidate {
  name: string
  createdAtMs: number
}

/** Newest agent whose timestamp falls in this wizard session. */
export function pickCreatedAgent(
  candidates: readonly CreatedAgentCandidate[],
  sessionStartedAtMs: number,
): string | null {
  let best: CreatedAgentCandidate | null = null
  for (const candidate of candidates) {
    if (!isFreshTimestamp(candidate.createdAtMs, sessionStartedAtMs)) continue
    if (!best || candidate.createdAtMs >= best.createdAtMs) best = candidate
  }
  return best?.name ?? null
}

export type SubjectAgentResult =
  | {ok: true; name: string}
  | {ok: false; message: string}

export interface ResolveSubjectAgentInput {
  sessionAgentName: string
  agentsDir: string
  markerPath: string
  sessionStartedAtMs?: number
}

const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

function hasAgentYaml(agentsDir: string, name: string): boolean {
  if (!AGENT_NAME_PATTERN.test(name)) return false
  try {
    return fs.existsSync(path.join(agentsDir, name, 'agent.yaml'))
  } catch {
    return false
  }
}

function readFreshMarker(markerPath: string, sessionStartedAtMs: number): string | null {
  try {
    const stat = fs.statSync(markerPath)
    if (!isFreshTimestamp(stat.mtimeMs, sessionStartedAtMs)) return null
    const name = fs.readFileSync(markerPath, 'utf8').trim()
    if (!AGENT_NAME_PATTERN.test(name)) return null
    return name
  } catch {
    return null
  }
}

function agentsCreatedThisSession(agentsDir: string): CreatedAgentCandidate[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(agentsDir, {withFileTypes: true})
  } catch {
    return []
  }
  const candidates: CreatedAgentCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!hasAgentYaml(agentsDir, entry.name)) continue
    try {
      const stat = fs.statSync(path.join(agentsDir, entry.name))
      candidates.push({name: entry.name, createdAtMs: directoryCreatedAtMs(stat)})
    } catch {
      // Skip a directory we cannot stat.
    }
  }
  return candidates
}

export function resolveSubjectAgent(input: ResolveSubjectAgentInput): SubjectAgentResult {
  if (!isBuilderSessionName(input.sessionAgentName)) {
    return {ok: true, name: input.sessionAgentName}
  }
  if (input.sessionStartedAtMs == null) {
    return {ok: false, message: NO_AGENT_LOADED_MESSAGE}
  }

  const marked = readFreshMarker(input.markerPath, input.sessionStartedAtMs)
  if (marked && hasAgentYaml(input.agentsDir, marked)) {
    return {ok: true, name: marked}
  }

  const created = pickCreatedAgent(
    agentsCreatedThisSession(input.agentsDir),
    input.sessionStartedAtMs,
  )
  if (created) return {ok: true, name: created}
  return {ok: false, message: NO_AGENT_LOADED_MESSAGE}
}

export function resolveCommandAgent(
  sessionAgentName: string,
  sessionStartedAtMs: number | undefined,
): SubjectAgentResult {
  return resolveSubjectAgent({
    sessionAgentName,
    agentsDir: defaultAgentsDir(),
    markerPath: defaultCreatedAgentMarkerPath(),
    sessionStartedAtMs,
  })
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/**
 * The reason to show in the chat when a CLI child exits non-zero.
 * Trailing newlines are dropped so the reason is not blank.
 */
export function childProcessFailureReason(err: unknown): string {
  const error = err as {stderr?: unknown; stdout?: unknown; message?: unknown} | null
  const streamed = meaningfulLine(textOf(error?.stderr)) || meaningfulLine(textOf(error?.stdout))
  if (streamed) return streamed
  const message = typeof error?.message === 'string'
    ? error.message
    : err instanceof Error
      ? err.message
      : String(err ?? '')
  return meaningfulLine(message) || 'unknown error'
}

function meaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^›\s*/, '').replace(/^Error:\s*/i, '').trim()
    if (!line || line.startsWith('Command failed:')) continue
    return line
  }
  return ''
}
