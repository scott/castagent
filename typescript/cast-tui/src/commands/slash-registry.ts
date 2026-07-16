import clipboardy from 'clipboardy'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import yaml from 'yaml'
import { simpleGit } from 'simple-git'
import {BoxRenderable, TextRenderable, TextTableRenderable, StyledText, white, dim, green, yellow, red, cyan} from '@opentui/core'
import type {KeyEvent, TextChunk} from '@opentui/core'
import {saveTranscript} from '../lib/transcript.js'
import {getDb} from '../lib/db.js'
import {getKeychain} from '../lib/keychain.js'
import {
  listSessions as listSessionsMeta,
  getSession,
  renameSession,
  forkSession,
  deleteSession,
  createSession,
  endSession,
  appendMessage,
  type SessionMeta,
  type Session,
} from '../lib/sessions.js'
import {createModal} from '../components/modal.js'
import {runDeployInTerminal} from '../components/terminal.js'
import type {UiMode} from '../components/header.js'

// Get agent description from agent.yaml
function getAgentDescription(agentName: string): string {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName, 'agent.yaml')
  try {
    if (fs.existsSync(agentPath)) {
      const content = fs.readFileSync(agentPath, 'utf8')
      const config = yaml.parse(content)
      if (config && config.description) {
        // Truncate to 100 chars with "..."
        const desc = config.description as string
        return desc.length > 100 ? desc.slice(0, 97) + '...' : desc
      }
    }
  } catch {
    // Ignore errors, return empty string
  }
  return ''
}

export interface SlashCommand {
  name: string
  description: string
  category: 'chat' | 'agent' | 'session' | 'git'
  args?: string
  /** If set, the command is only available in these UI modes. If unset, available in all modes. */
  modes?: UiMode[]
  handler: (ctx: CommandContext, args: string[]) => Promise<void>
}

export interface CommandContext {
  agentName: string
  agentUrl: string
  authToken?: string
  mode: 'plan' | 'build'
  uiMode?: UiMode
  renderer: any
  client: any
  messages: any
  input: any
  setMode: (mode: 'plan' | 'build') => void
  reinitializeChat: (agentName: string, url: string, token?: string) => Promise<void>
  exitTui: () => void
  messageHistory: Array<{role: 'user' | 'agent'; text: string}>
  lastAgentMessage?: string
  /**
   * The active session id, if one is bound to the chat screen. The TUI
   * creates a session on first user message and updates this on
   * /session new, /session fork, and /session resume.
   */
  currentSessionId?: string | null
  /**
   * Re-render the chat screen from a saved session's transcript. Wired
   * in the chat screen; defaults to a no-op in tests.
   */
  loadSession?: (sessionId: string) => Promise<void>
  /**
   * Recursively run a subcommand by name. Used by the /session parent
   * command to dispatch to /session-list, /session-resume, etc.
   */
  executeSubcommand?: (name: string, args: string[]) => Promise<void>
}

/**
 * Load a session's transcript into the chat. Clears the in-memory
 * message history, then re-renders each message as a user/agent
 * bubble. This is the user-facing "resume" action.
 */
async function loadSessionIntoChat(ctx: CommandContext, sessionId: string): Promise<void> {
  if (!ctx.loadSession) {
    ctx.messages.addAgentMessage(
      'Resuming sessions is not available in this context.',
      ctx.mode,
    )
    return
  }
  try {
    await ctx.loadSession(sessionId)
    ctx.currentSessionId = sessionId
    ctx.messages.addAgentMessage(
      `Resumed session ${sessionId}. Future messages will be appended to this session.`,
      ctx.mode,
    )
  } catch (err: any) {
    ctx.messages.addAgentMessage(
      `Failed to resume session: ${err?.message ?? String(err)}`,
      ctx.mode,
    )
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the cast CLI binary by searching common installation paths.
 * Returns the path to the cast binary, or null if it cannot be found.
 *
 * Duplicated from components/terminal.ts so that slash-registry can shell
 * out to cast commands without depending on the deploy-only internals.
 */
function findCastBinary(): string | null {
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        // Check if cast is in PATH
        const castPath = execFileSync('which', ['cast'], {encoding: 'utf8', timeout: 5000}).trim()
        if (castPath && fs.existsSync(castPath)) {
          return castPath
        }
      } else if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      // try next
    }
  }

  return null
}

/**
 * Parse a semver string (e.g. "1.2.3") into its numeric parts.
 * Returns [0, 0, 0] for unparseable input.
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ]
}

/**
 * Compute suggested next semver versions (patch, minor, major) from a
 * current version. If currentVersion is null/empty, defaults to "1.0.0".
 */
function suggestNextVersions(currentVersion: string | null | undefined): {
  current: string
  patch: string
  minor: string
  major: string
} {
  const current = currentVersion && currentVersion.length > 0 ? currentVersion : '1.0.0'
  const [maj, min, pat] = parseSemver(current)
  return {
    current,
    patch: `${maj}.${min}.${pat + 1}`,
    minor: `${maj}.${min + 1}.0`,
    major: `${maj + 1}.0.0`,
  }
}

/**
 * Show a generic info/success modal with a title, a list of label/value
 * lines, and a single Close button (or just Enter/ESC).
 */
function showInfoModal(
  ctx: CommandContext,
  title: string,
  lines: Array<{label?: string; value: string; color?: typeof white | typeof green | typeof yellow | typeof red | typeof cyan | typeof dim}>,
  footerText: string = 'Enter/ESC Close',
  successColor: boolean = false,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {title, overlay: true})
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 3,
    paddingLeft: 2,
    paddingRight: 2,
    alignItems: 'center',
  })

  for (const line of lines) {
    const color = line.color || (successColor ? green : white)
    const text = line.label
      ? new StyledText([dim(`${line.label}: `), color(line.value)])
      : new StyledText([color(line.value)])
    const row = new TextRenderable(ctx.renderer, {content: text})
    contentBox.add(row)
  }

  const spacer = new TextRenderable(ctx.renderer, {content: new StyledText([dim(' ')])})
  contentBox.add(spacer)

  const footer = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim(footerText)]),
  })
  contentBox.add(footer)

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

/**
 * Scan ~/.cast/agents/ for agent directories (containing agent.yaml).
 * This is the canonical source of agents — the SQLite DB only tracks
 * runtime/deployment state and may be empty for newly-created agents.
 */
function listAgentsFromDisk(): string[] {
  const agentsDir = path.join(os.homedir(), '.cast', 'agents')
  if (!fs.existsSync(agentsDir)) {
    return []
  }

  const agents: string[] = []
  for (const item of fs.readdirSync(agentsDir)) {
    const agentPath = path.join(agentsDir, item)
    if (fs.statSync(agentPath).isDirectory() && fs.existsSync(path.join(agentPath, 'agent.yaml'))) {
      agents.push(item)
    }
  }

  return agents.sort()
}

// Helper to get releases for an agent (reads from releases.json)
async function getReleasesForAgent(agentName: string): Promise<Array<{version: string; message: string; changelog: string; created_at: string}>> {
  const releasesJsonPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'releases', 'releases.json')
  if (!fs.existsSync(releasesJsonPath)) {
    return []
  }
  try {
    const data = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'))
    return data.releases || []
  } catch {
    return []
  }
}

/**
 * Get the current (latest) release version for an agent.
 *
 * Reads `data.current.version` from the agent's `releases.json` file. This
 * is the same field the Python `cast.releases.get_current_release` reads,
 * and the authoritative source for "what release is the agent currently
 * at". Falls back to the newest entry in the `releases` array (by semver)
 * when the `current` field is missing, and to `null` if no releases exist.
 */
function getCurrentReleaseVersion(agentName: string): string | null {
  const releasesJsonPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'releases', 'releases.json')
  if (!fs.existsSync(releasesJsonPath)) {
    return null
  }
  try {
    const data = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'))
    const current = data.current
    if (current && typeof current.version === 'string' && current.version.length > 0) {
      return current.version
    }
    // Fallback: newest entry by semver, when current is missing
    const releases: Array<{version: string}> = Array.isArray(data.releases) ? data.releases : []
    if (releases.length === 0) return null
    const sorted = [...releases].sort((a, b) => {
      const pa = a.version.split('.').map((n) => parseInt(n, 10) || 0)
      const pb = b.version.split('.').map((n) => parseInt(n, 10) || 0)
      return (pb[0] - pa[0]) || (pb[1] - pa[1]) || ((pb[2] || 0) - (pa[2] || 0))
    })
    return sorted[0].version
  } catch {
    return null
  }
}

// Helper to get changes for an agent
function getChangesForAgent(agentName: string): Array<{id: number; timestamp: string; source: string; message: string}> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  // Try new path first, fall back to old
  const newPath = path.join(agentPath, '.cast', 'changes', 'changes.json')
  const oldPath = path.join(agentPath, '.cast', 'versions', 'versions.json')
  const changesJsonPath = fs.existsSync(newPath) ? newPath : oldPath

  if (!fs.existsSync(changesJsonPath)) {
    return []
  }
  try {
    const data = JSON.parse(fs.readFileSync(changesJsonPath, 'utf8'))
    return data.versions || []
  } catch {
    return []
  }
}

/**
 * Format an ISO timestamp as a relative "x ago" string for session
 * pickers. Falls back to a locale string for invalid input.
 */
function formatRelativeTime(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/**
 * Truncate a string to a maximum length, collapsing whitespace and
 * adding an ellipsis when truncated. Used to fit user prompts into
 * session picker rows.
 */
function truncatePreview(s: string | null | undefined, n: number): string {
  if (!s) return ''
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

/**
 * Show a session picker modal. Renders the list of sessions for the
 * current agent, navigates with up/down, and invokes `onSelect` with
 * the chosen session id (or no-op on escape).
 *
 * Follows the AGENTS.md modal standards: 90% wide, 80% tall, centered,
 * `▸` selection indicator, no row numbers, two-line rows.
 */
function showSessionPicker(
  ctx: CommandContext,
  sessions: SessionMeta[],
  options: {
    title: string
    onSelect: (sess: SessionMeta) => void | Promise<void>
    extraActions?: Record<
      string,
      (sess: SessionMeta) => void | Promise<void>
    >
  },
): void {
  const modal = createModal(ctx.renderer, ctx.input, {title: options.title, overlay: true})
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  if (sessions.length === 0) {
    const empty = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('No sessions found.')]),
    })
    contentBox.add(empty)
    modal.setContent(contentBox)
    ctx.renderer.root.add(modal.box)
    modal.show()
    const closeKey = modal.box.handleKeyPress?.bind(modal.box)
    modal.box.handleKeyPress = (key: KeyEvent) => {
      if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
        modal.hide()
        ctx.input.focus()
        return true
      }
      return closeKey ? closeKey(key) : false
    }
    return
  }

  let selectedIndex = 0

  const renderList = () => {
    for (const child of contentBox.getChildren()) {
      contentBox.remove(child.id)
    }

    const header = new TextRenderable(ctx.renderer, {
      content: new StyledText([
        white(`${sessions.length} session${sessions.length === 1 ? '' : 's'}`),
      ]),
    })
    contentBox.add(header)
    const sep = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('──────────────────────────────────────────────────────────────────────────────')]),
    })
    contentBox.add(sep)

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]
      const isSelected = i === selectedIndex
      const titleColor = isSelected ? white : dim
      const title = s.name || truncatePreview(s.first_user_message, 60) || '(untitled)'
      const endedTag = s.ended_at ? ' (ended)' : ''

      const row = new TextRenderable(ctx.renderer, {
        content: new StyledText([
          isSelected ? cyan('▸ ') : dim('  '),
          titleColor(title),
          dim(endedTag),
          dim('\n    '),
          dim(`${s.agent_name} · ${s.message_count} msg · ${formatRelativeTime(s.updated_at)}`),
        ]),
      })
      contentBox.add(row)
    }

    const sep2 = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('──────────────────────────────────────────────────────────────────────────────')]),
    })
    contentBox.add(sep2)

    const footerParts: Array<{text: string; color: typeof white | typeof dim}> = [
      {text: '↑↓ ', color: white},
      {text: 'Navigate  ', color: dim},
      {text: 'Enter ', color: white},
      {text: 'Select  ', color: dim},
    ]
    if (options.extraActions) {
      for (const [key, _] of Object.entries(options.extraActions)) {
        footerParts.push({text: `${key.toUpperCase()} `, color: white})
        footerParts.push({text: 'Action  ', color: dim})
      }
    }
    footerParts.push({text: 'ESC ', color: white})
    footerParts.push({text: 'Close', color: dim})
    const chunks: any[] = []
    for (const p of footerParts) chunks.push(p.color(p.text))
    const footer = new TextRenderable(ctx.renderer, {content: new StyledText(chunks)})
    const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
    footerBox.add(footer)
    contentBox.add(footerBox)
  }

  renderList()
  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandle = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'up') {
      selectedIndex = (selectedIndex - 1 + sessions.length) % sessions.length
      renderList()
      ctx.renderer.requestRender?.()
      return true
    }
    if (key.name === 'down') {
      selectedIndex = (selectedIndex + 1) % sessions.length
      renderList()
      ctx.renderer.requestRender?.()
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      const chosen = sessions[selectedIndex]
      modal.hide()
      ctx.input.focus()
      void options.onSelect(chosen)
      return true
    }
    if (options.extraActions) {
      const k = (key.name ?? '').toLowerCase()
      if (k.length === 1 && options.extraActions[k]) {
        const chosen = sessions[selectedIndex]
        modal.hide()
        ctx.input.focus()
        void options.extraActions[k](chosen)
        return true
      }
    }
    return originalHandle ? originalHandle(key) : false
  }
}

function launchBuilderEditor(ctx: CommandContext, agentName: string): void {
  // Destroy renderer to release terminal
  if (ctx.renderer && !ctx.renderer.isDestroyed) {
    ctx.renderer.destroy()
  }

  const binary = findCastBinary()
  if (!binary) {
    console.error('Could not find cast CLI binary. Please ensure cast is installed.')
    process.exit(1)
  }

  try {
    execFileSync(binary, ['edit', agentName], { stdio: 'inherit' })
  } catch (err: any) {
    if (err.signal === 'SIGINT') {
      // User pressed Ctrl+C, exit cleanly
    } else {
      console.error(`Failed to launch editor: ${err.message}`)
    }
  }

  process.exit(0)
}

function launchConnect(ctx: CommandContext, agentNameOrSha: string): void {
  // Destroy renderer to release terminal
  if (ctx.renderer && !ctx.renderer.isDestroyed) {
    ctx.renderer.destroy()
  }

  const binary = findCastBinary()
  if (!binary) {
    console.error('Could not find cast CLI binary. Please ensure cast is installed.')
    process.exit(1)
  }

  try {
    execFileSync(binary, ['connect', agentNameOrSha], { stdio: 'inherit' })
  } catch (err: any) {
    if (err.signal === 'SIGINT') {
      // User pressed Ctrl+C, exit cleanly
    } else {
      console.error(`Failed to connect: ${err.message}`)
    }
  }

  process.exit(0)
}

function promptForNewName(ctx: CommandContext, currentName: string): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Rename: ${currentName}`,
    overlay: true,
  })

  if (modal.overlay) {
    ctx.renderer.root.add(modal.overlay)
  }

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 1,
    paddingTop: 3,
    paddingLeft: 2,
    paddingRight: 2,
  })

  const instructions = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim(`Enter new name for '${currentName}':`)]),
  })
  contentBox.add(instructions)

  const inputDisplay = new TextRenderable(ctx.renderer, {
    content: new StyledText([white('_')]),
  })
  contentBox.add(inputDisplay)

  const errorText = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim(' ')]),
  })
  contentBox.add(errorText)

  const footer = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('Enter Confirm  ESC Cancel')]),
  })
  const footerBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    alignItems: 'center',
  })
  footerBox.add(footer)
  contentBox.add(footerBox)

  let newName = ''
  const MAX_LENGTH = 50

  function updateInputDisplay(error?: string) {
    const displayText = newName + '_'
    inputDisplay.content = new StyledText([white(displayText)])
    if (error) {
      errorText.content = new StyledText([red(error)])
    } else {
      errorText.content = new StyledText([dim(' ')])
    }
    ctx.renderer.requestRender?.()
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (newName.length > 0) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(newName)) {
          updateInputDisplay('Invalid name (letters, numbers, hyphens only)')
          return true
        }
        const newPath = path.join(os.homedir(), '.cast', 'agents', newName)
        if (fs.existsSync(newPath)) {
          updateInputDisplay(`Agent '${newName}' already exists`)
          return true
        }
        modal.hide()
        launchRenameWithName(ctx, currentName, newName)
      }
      return true
    }
    if (key.name === 'backspace') {
      if (newName.length > 0) {
        newName = newName.slice(0, -1)
        updateInputDisplay()
      }
      return true
    }
    if (key.ctrl && key.name === 'h') {
      if (newName.length > 0) {
        newName = newName.slice(0, -1)
        updateInputDisplay()
      }
      return true
    }
    if (key.name && key.name.length === 1 && /^[a-zA-Z0-9-]$/.test(key.name) && newName.length < MAX_LENGTH) {
      newName += key.name
      updateInputDisplay()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }

  updateInputDisplay()
  ctx.renderer.requestRender?.()
}

function launchRenameWithName(ctx: CommandContext, currentName: string, newName: string): void {
  const binary = findCastBinary()
  if (!binary) {
    ctx.messages.addAgentMessage('Could not find cast CLI binary. Please ensure cast is installed.', ctx.mode)
    return
  }

  try {
    execFileSync(binary, ['rename', currentName, newName], { stdio: 'inherit' })
  } catch (err: any) {
    if (err.signal !== 'SIGINT') {
      ctx.messages.addAgentMessage(`Failed to rename agent: ${err.message}`, ctx.mode)
    }
  }
}

interface DeployedAgent {
  name: string
  provider: string
  version: number | null
}

interface SemverDeployedAgent {
  name: string
  provider: string
  deployedVersion: string | null
  sha: string
}

/**
 * Semver-aware replacement for `showVersionSelection`. Lists the agent's
 * releases in a modal and, on confirm, shells out to `cast upgrade` with
 * the chosen version. Built for the new release model.
 */
function showUpgradeVersionPicker(
  ctx: CommandContext,
  agent: SemverDeployedAgent,
  releases: Array<{version: string; message: string; changelog: string; created_at: string}>,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Upgrade ${agent.name}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  // Build selectable items: each release plus an explicit "latest" option
  // that points at the current working state of the agent.
  type Item = {kind: 'release'; version: string; message: string} | {kind: 'latest'; version: 'latest'; message: string}
  const items: Item[] = []
  for (const r of releases) {
    items.push({kind: 'release', version: r.version, message: r.message})
  }
  items.push({kind: 'latest', version: 'latest', message: 'Current working state'})

  let selectedIndex = 0

  function renderList(): void {
    for (const child of contentBox.getChildren()) {
      contentBox.remove(child.id)
    }

    const header = new TextRenderable(ctx.renderer, {
      content: new StyledText([
        dim('Agent: '),
        white(agent.name),
        dim('  sha:'),
        cyan(agent.sha),
        dim('  provider:'),
        white(agent.provider),
        dim('  current:'),
        yellow(agent.deployedVersion || 'none'),
      ]),
    })
    contentBox.add(header)

    const sep = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
    })
    contentBox.add(sep)

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const isSelected = i === selectedIndex
      const prefix = isSelected ? cyan('▸ ') : dim('  ')
      const isCurrent =
        (item.kind === 'release' && item.version === agent.deployedVersion) ||
        (item.kind === 'latest' && agent.deployedVersion === 'latest')
      const isLatest = item.kind === 'latest'
      let label = item.version
      if (isCurrent) label += dim(' (deployed)')
      else if (isLatest) label += green(' (latest)')

      const row = new TextRenderable(ctx.renderer, {
        content: new StyledText([
          prefix,
          isSelected ? white(label) : dim(label),
          dim('  '),
          dim(item.message || ''),
        ]),
      })
      contentBox.add(row)
    }

    const sep2 = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
    })
    contentBox.add(sep2)

    const footer = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('↑↓ Navigate  Enter Upgrade  ESC Cancel')]),
    })
    const footerBox = new BoxRenderable(ctx.renderer, {
      width: '100%',
      alignItems: 'center',
    })
    footerBox.add(footer)
    contentBox.add(footerBox)

    ctx.renderer.requestRender?.()
  }

  const doUpgrade = (version: string): void => {
    modal.hide()

    const binary = findCastBinary()
    if (!binary) {
      ctx.messages.addAgentMessage('Could not find cast CLI binary. Please ensure cast is installed.', ctx.mode)
      return
    }

    if (ctx.renderer && !ctx.renderer.isDestroyed) {
      ctx.renderer.destroy()
    }

    try {
      console.log(`\nUpgrading ${agent.name} to ${version}...\n`)
      execFileSync(binary, ['upgrade', agent.name, '--version', version], {stdio: 'inherit'})
    } catch (err: any) {
      if (err.signal === 'SIGINT') {
        // user cancelled
      } else {
        console.error(`\nUpgrade failed: ${err.message}`)
      }
    }
    process.exit(0)
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()
  renderList()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'up') {
      selectedIndex = Math.max(0, selectedIndex - 1)
      renderList()
      return true
    }
    if (key.name === 'down') {
      selectedIndex = Math.min(items.length - 1, selectedIndex + 1)
      renderList()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      const item = items[selectedIndex]
      const v = item.version
      if (item.kind === 'release' && v === agent.deployedVersion) {
        ctx.messages.addAgentMessage(
          `Agent '${agent.name}' is already at version ${v}.`,
          ctx.mode,
        )
        modal.hide()
        ctx.input.focus()
        return true
      }
      doUpgrade(v)
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

function showVersionSelection(ctx: CommandContext, agent: DeployedAgent): void {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agent.name)
  const versionsJsonPath = path.join(agentPath, '.cast', 'versions', 'versions.json')

  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Select version for ${agent.name}`,
    overlay: true,
  })

  if (modal.overlay) {
    ctx.renderer.root.add(modal.overlay)
  }

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  // Load versions from file
  let versions: Array<{id: number; timestamp: string; source: string; message: string}> = []
  let latestVersion = 0

  if (fs.existsSync(versionsJsonPath)) {
    try {
      const versionsData = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'))
      versions = versionsData.versions || []
      latestVersion = versionsData.current || 0
    } catch {
      // Ignore parsing errors
    }
  }

  if (versions.length === 0) {
    const emptyText = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('No versions found.')]),
    })
    contentBox.add(emptyText)

    const hint = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('\nCreate a version with: cast version')]),
    })
    contentBox.add(hint)

    const footer = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('ESC Back')]),
    })
    const footerBox = new BoxRenderable(ctx.renderer, {
      width: '100%',
      alignItems: 'center',
    })
    footerBox.add(footer)
    contentBox.add(footerBox)

    modal.setContent(contentBox)
    ctx.renderer.root.add(modal.box)
    modal.show()

    const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
    modal.box.handleKeyPress = (key: KeyEvent) => {
      if (key.name === 'escape') {
        modal.hide()
        ctx.input.focus()
        return true
      }
      return originalHandleKeyPress ? originalHandleKeyPress(key) : false
    }
    return
  }

  // Sort versions by id descending (newest first)
  const sortedVersions = [...versions].sort((a, b) => b.id - a.id)
  let selectedIndex = 0

  function renderVersionList() {
    for (const child of contentBox.getChildren()) {
      contentBox.remove(child.id)
    }

    for (let i = 0; i < sortedVersions.length; i++) {
      const v = sortedVersions[i]
      const isSelected = i === selectedIndex
      const isDeployed = v.id === agent.version
      const isLatest = v.id === latestVersion

      const prefix = isSelected ? cyan('▸ ') : dim('  ')
      let versionLabel = `v${v.id}`
      if (isDeployed) {
        versionLabel += dim(' (deployed)')
      } else if (isLatest) {
        versionLabel += green(' (latest)')
      }

      const message = v.message || 'Draft version'
      const messageTruncated = message.length > 40 ? message.slice(0, 37) + '...' : message

      const versionText = new TextRenderable(ctx.renderer, {
        content: new StyledText([
          prefix,
          white(versionLabel),
          dim(` - "${messageTruncated}"`),
        ]),
      })
      contentBox.add(versionText)
    }

    const footer = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Back')]),
    })
    const footerBox = new BoxRenderable(ctx.renderer, {
      width: '100%',
      alignItems: 'center',
    })
    footerBox.add(footer)
    contentBox.add(footerBox)
  }

  renderVersionList()
  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'up') {
      selectedIndex = Math.max(0, selectedIndex - 1)
      renderVersionList()
      ctx.renderer.requestRender?.()
      return true
    }
    if (key.name === 'down') {
      selectedIndex = Math.min(sortedVersions.length - 1, selectedIndex + 1)
      renderVersionList()
      ctx.renderer.requestRender?.()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      const selectedVersion = sortedVersions[selectedIndex]
      if (selectedVersion.id === agent.version) {
        // Already on this version
        modal.hide()
        ctx.messages.addAgentMessage(
          `Agent '${agent.name}' is already at version ${selectedVersion.id}.`,
          ctx.mode
        )
        ctx.input.focus()
        return true
      }
      modal.hide()
      showUpgradeConfirmation(ctx, agent, selectedVersion.id, latestVersion)
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

function showUpgradeConfirmation(
  ctx: CommandContext,
  agent: DeployedAgent,
  targetVersion: number,
  latestVersion: number
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Upgrade ${agent.name}?`,
    overlay: true,
  })

  if (modal.overlay) {
    ctx.renderer.root.add(modal.overlay)
  }

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
    alignItems: 'center',
  })

  const currentVer = agent.version || 'unknown'
  const targetVer = targetVersion
  const isLatest = targetVersion === latestVersion

  const versionInfo = new TextRenderable(ctx.renderer, {
    content: new StyledText([
      dim(`${currentVer} → `),
      green(`v${targetVer}`),
      dim(isLatest ? ' (latest)' : ''),
    ]),
  })
  contentBox.add(versionInfo)

  const spacer1 = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim(' ')]),
  })
  contentBox.add(spacer1)

  const memoryNote = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('Agent memory will be preserved.')]),
  })
  contentBox.add(memoryNote)

  const spacer2 = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim(' ')]),
  })
  contentBox.add(spacer2)

  const footer = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('Enter Upgrade  ESC Cancel')]),
  })
  contentBox.add(footer)

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'return' || key.name === 'enter') {
      modal.hide()
      executeUpgrade(ctx, agent, targetVersion)
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

function executeUpgrade(ctx: CommandContext, agent: DeployedAgent, targetVersion: number): void {
  // Find the cast CLI binary
  const binary = findCastBinary()
  if (!binary) {
    ctx.messages.addAgentMessage(
      'Could not find cast CLI binary. Please ensure cast is installed.',
      ctx.mode
    )
    return
  }

  // Destroy renderer to release terminal
  if (ctx.renderer && !ctx.renderer.isDestroyed) {
    ctx.renderer.destroy()
  }

  // Run the upgrade command
  try {
    console.log(`\nUpgrading ${agent.name} from v${agent.version || 'unknown'} to v${targetVersion}...\n`)
    execFileSync(binary, ['upgrade', agent.name, targetVersion.toString()], { stdio: 'inherit' })
  } catch (err: any) {
    if (err.signal === 'SIGINT') {
      // User pressed Ctrl+C
    } else {
      console.error(`\nUpgrade failed: ${err.message}`)
    }
  }

  // Exit the TUI after upgrade
  process.exit(0)
}

/**
 * Show a restore confirmation modal. The user must confirm before
 * `onConfirm` is invoked.
 */
function showRestoreConfirmation(
  ctx: CommandContext,
  agentName: string,
  kind: 'change' | 'release',
  value: string | number,
  onConfirm: (kind: 'change' | 'release', value: string | number) => void,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Restore: ${agentName}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 1,
    paddingTop: 3,
    paddingLeft: 2,
    paddingRight: 2,
    alignItems: 'center',
  })

  const label = kind === 'change' ? `change v${value}` : `release ${value}`
  const restoreLine = new TextRenderable(ctx.renderer, {
    content: new StyledText([
      dim('Restore from '),
      cyan(label),
      dim('?'),
    ]),
  })
  contentBox.add(restoreLine)

  const note = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('Your current changes will be preserved in the change history.')]),
  })
  contentBox.add(note)

  const warning = new TextRenderable(ctx.renderer, {
    content: new StyledText([yellow('Note: Restore does not deploy. Use /deploy to update the deployment.')]),
  })
  contentBox.add(warning)

  const spacer = new TextRenderable(ctx.renderer, {content: new StyledText([dim(' ')])})
  contentBox.add(spacer)

  const footer = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('Enter Restore  ESC Cancel')]),
  })
  contentBox.add(footer)

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      modal.hide()
      ctx.input.focus()
      onConfirm(kind, value)
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

/**
 * Show the restore picker: pick source (Changes vs Releases), then pick a
 * specific item, then ask for confirmation.
 */
function showRestorePicker(
  ctx: CommandContext,
  agentName: string,
  changes: Array<{id: number; timestamp: string; source: string; message: string}>,
  releases: Array<{version: string; message: string; changelog: string; created_at: string}>,
  onConfirm: (kind: 'change' | 'release', value: string | number) => void,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Restore: ${agentName}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  type Source = 'change' | 'release'
  type Stage = 'source' | 'item'
  type Item =
    | {kind: 'change'; id: number; label: string; sub: string}
    | {kind: 'release'; version: string; label: string; sub: string}

  const state = {
    source: 'change' as Source,
    stage: 'source' as Stage,
    selectedIndex: 0,
  }

  function getItems(): Item[] {
    if (state.source === 'change') {
      return changes.map((c) => ({
        kind: 'change' as const,
        id: c.id,
        label: `v${c.id}`,
        sub: c.message || '',
      }))
    }
    return releases.map((r) => ({
      kind: 'release' as const,
      version: r.version,
      label: r.version,
      sub: r.message || '',
    }))
  }

  function refresh(): void {
    for (const child of contentBox.getChildren()) {
      contentBox.remove(child.id)
    }

    if (state.stage === 'source') {
      const header = new TextRenderable(ctx.renderer, {
        content: new StyledText([white(`Restore from:`)]),
      })
      contentBox.add(header)
      const sep = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep)

      const sources: Array<{key: Source; label: string; count: number}> = [
        {key: 'change', label: 'Changes', count: changes.length},
        {key: 'release', label: 'Releases', count: releases.length},
      ]
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i]
        const isSelected = i === state.selectedIndex
        const prefix = isSelected ? cyan('(•) ') : dim('( ) ')
        const row = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            prefix,
            isSelected ? white(s.label) : dim(s.label),
            dim(`  (${s.count} available)`),
          ]),
        })
        contentBox.add(row)
      }

      const sep2 = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep2)
      const note = new TextRenderable(ctx.renderer, {
        content: new StyledText([yellow('Note: Restore does not deploy. Your current changes will be preserved.')]),
      })
      contentBox.add(note)

      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Cancel')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
      footerBox.add(footer)
      contentBox.add(footerBox)
    } else {
      // 'item' stage: show the list of changes or releases
      const items = getItems()
      if (items.length === 0) {
        const empty = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim(`No ${state.source}s available.`)]),
        })
        contentBox.add(empty)
        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('ESC Back')]),
        })
        contentBox.add(hint)
        ctx.renderer.requestRender?.()
        return
      }
      const header = new TextRenderable(ctx.renderer, {
        content: new StyledText([white(`Select ${state.source} to restore from:`)]),
      })
      contentBox.add(header)
      const sep = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep)

      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const isSelected = i === state.selectedIndex
        const prefix = isSelected ? cyan('▸ ') : dim('  ')
        const sub = it.sub.length > 50 ? it.sub.slice(0, 47) + '...' : it.sub
        const row = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            prefix,
            isSelected ? white(it.label) : dim(it.label),
            dim('  '),
            dim(sub),
          ]),
        })
        contentBox.add(row)
      }

      const sep2 = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep2)
      const note = new TextRenderable(ctx.renderer, {
        content: new StyledText([yellow('Your current changes will be preserved in the change history.')]),
      })
      contentBox.add(note)

      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('↑↓ Navigate  Enter Restore  ESC Back')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
      footerBox.add(footer)
      contentBox.add(footerBox)
    }

    ctx.renderer.requestRender?.()
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()
  refresh()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape') {
      if (state.stage === 'item') {
        state.stage = 'source'
        state.selectedIndex = 0
        refresh()
        return true
      }
      modal.hide()
      ctx.input.focus()
      return true
    }
    if (state.stage === 'source') {
      const maxIndex = 1 // 2 sources
      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1)
        refresh()
        return true
      }
      if (key.name === 'down') {
        state.selectedIndex = Math.min(maxIndex, state.selectedIndex + 1)
        refresh()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        const sources: Source[] = ['change', 'release']
        // If only one source has data, jump to it directly
        if (state.selectedIndex === 0 && changes.length === 0 && releases.length > 0) {
          state.source = 'release'
        } else if (state.selectedIndex === 1 && releases.length === 0 && changes.length > 0) {
          state.source = 'change'
        } else {
          state.source = sources[state.selectedIndex]
        }
        // If no items of the chosen type, stay on source stage
        const items = getItems()
        if (items.length === 0) {
          refresh()
          return true
        }
        state.stage = 'item'
        state.selectedIndex = 0
        refresh()
        return true
      }
    } else {
      // 'item' stage
      const items = getItems()
      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1)
        refresh()
        return true
      }
      if (key.name === 'down') {
        state.selectedIndex = Math.min(items.length - 1, state.selectedIndex + 1)
        refresh()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        const it = items[state.selectedIndex]
        modal.hide()
        ctx.input.focus()
        if (it.kind === 'change') {
          showRestoreConfirmation(ctx, agentName, 'change', it.id, onConfirm)
        } else {
          showRestoreConfirmation(ctx, agentName, 'release', it.version, onConfirm)
        }
        return true
      }
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

/**
 * Show a diff between two changes or two releases for an agent. The
 * implementation shells out to `cast diff` for changes (using version IDs)
 * and displays the result in a modal. For release diffs, falls back to a
 * summary view since there is no dedicated `cast diff` for releases.
 */
function showDiffModal(
  ctx: CommandContext,
  agentName: string,
  kind: 'change' | 'release',
  v1: string,
  v2: string,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Diff: ${agentName}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  const label1 = kind === 'change' ? `v${v1}` : `${v1}`
  const label2 = kind === 'change' ? `v${v2}` : `${v2}`

  const header = new TextRenderable(ctx.renderer, {
    content: new StyledText([
      dim(`${kind === 'change' ? 'Change' : 'Release'} diff: `),
      cyan(label1),
      dim(' → '),
      cyan(label2),
    ]),
  })
  contentBox.add(header)

  const sep = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
  })
  contentBox.add(sep)

  // Run the diff
  const binary = findCastBinary()
  let output = ''
  if (!binary) {
    output = 'Could not find cast CLI binary. Please ensure cast is installed.'
  } else {
      try {
      if (kind === 'change') {
        // `cast diff <agent> <v1> <v2>` uses integer version IDs
        output = execFileSync(binary, ['diff', agentName, v1, v2], {encoding: 'utf8', timeout: 30000})
      } else {
        // Releases: no dedicated `cast diff`; produce a summary
        // Show a synchronous message and then compute summary using releases from file.
        // We use a synchronous fs read here so the modal can be shown without await.
        const releasesJsonPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'releases', 'releases.json')
        let rels: any[] = []
        if (fs.existsSync(releasesJsonPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'))
            rels = data.releases || []
          } catch {
            rels = []
          }
        }
        const r1 = rels.find((r: any) => r.version === v1)
        const r2 = rels.find((r: any) => r.version === v2)
        if (!r1 || !r2) {
          output = `Could not find release ${!r1 ? v1 : v2} for agent ${agentName}.`
        } else {
          output = [
            `Comparing release ${v1} → ${v2}`,
            '',
            `${v1}: ${r1.message || '(no message)'}  — ${r1.created_at}`,
            `${v2}: ${r2.message || '(no message)'}  — ${r2.created_at}`,
            '',
            'No line-level diff available for releases in this build.',
          ].join('\n')
        }
      }
    } catch (err: any) {
      if (err.stdout) {
        output = err.stdout.toString()
      } else {
        output = `Failed to run diff: ${err.message || String(err)}`
      }
    }
  }

  // Render output (truncate very long output)
  const maxLines = 200
  const lines = output.split('\n').slice(0, maxLines)
  for (const line of lines) {
    const displayLine = line.length > 200 ? line.slice(0, 197) + '...' : line
    const text = new TextRenderable(ctx.renderer, {
      content: new StyledText([white(displayLine)]),
    })
    contentBox.add(text)
  }
  if (output.split('\n').length > maxLines) {
    const more = new TextRenderable(ctx.renderer, {
      content: new StyledText([dim(`... (${output.split('\n').length - maxLines} more lines truncated)`)]),
    })
    contentBox.add(more)
  }

  const sep2 = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
  })
  contentBox.add(sep2)

  const footer = new TextRenderable(ctx.renderer, {
    content: new StyledText([dim('ESC Close')]),
  })
  const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
  footerBox.add(footer)
  contentBox.add(footerBox)

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
      modal.hide()
      ctx.input.focus()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

/**
 * Show the /diff flow: pick kind (Changes or Releases), then pick two
 * items, then show the diff modal.
 */
function showDiffPicker(
  ctx: CommandContext,
  agentName: string,
  preselectedFirstChange: number | null,
  changes: Array<{id: number; timestamp: string; source: string; message: string}>,
  releases: Array<{version: string; message: string; changelog: string; created_at: string}>,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Diff: ${agentName}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  type Kind = 'change' | 'release'
  type Stage = 'kind' | 'first' | 'second' | 'show'
  type Item =
    | {kind: 'change'; id: number; label: string; sub: string}
    | {kind: 'release'; version: string; label: string; sub: string}

  const state = {
    kind: (preselectedFirstChange !== null ? 'change' : 'change') as Kind,
    stage: (preselectedFirstChange !== null ? 'second' : 'kind') as Stage,
    first: (preselectedFirstChange !== null
      ? ({kind: 'change', id: preselectedFirstChange, label: `v${preselectedFirstChange}`, sub: ''} as Item)
      : null) as Item | null,
    second: null as Item | null,
    selectedIndex: 0,
  }

  function getItems(): Item[] {
    if (state.kind === 'change') {
      return changes.map((c) => ({
        kind: 'change' as const,
        id: c.id,
        label: `v${c.id}`,
        sub: c.message || '',
      }))
    }
    return releases.map((r) => ({
      kind: 'release' as const,
      version: r.version,
      label: r.version,
      sub: r.message || '',
    }))
  }

  function refresh(): void {
    for (const child of contentBox.getChildren()) {
      contentBox.remove(child.id)
    }

    if (state.stage === 'kind') {
      const header = new TextRenderable(ctx.renderer, {
        content: new StyledText([white('Compare:')]),
      })
      contentBox.add(header)
      const sep = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep)
      const kinds: Array<{key: Kind; label: string}> = [
        {key: 'change', label: 'Compare Changes'},
        {key: 'release', label: 'Compare Releases'},
      ]
      for (let i = 0; i < kinds.length; i++) {
        const k = kinds[i]
        const isSelected = i === state.selectedIndex
        const prefix = isSelected ? cyan('(•) ') : dim('( ) ')
        const row = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            prefix,
            isSelected ? white(k.label) : dim(k.label),
          ]),
        })
        contentBox.add(row)
      }
      const sep2 = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep2)
      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Cancel')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
      footerBox.add(footer)
      contentBox.add(footerBox)
    } else if (state.stage === 'first' || state.stage === 'second') {
      const stageLabel = state.stage === 'first' ? 'First' : 'Second'
      const items = getItems()
      if (items.length === 0) {
        const empty = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim(`No ${state.kind}s available.`)]),
        })
        contentBox.add(empty)
      } else {
        const headerChunks: any[] = [
          white(`${stageLabel} ${state.kind}:`),
          dim('  '),
        ]
        if (state.first) {
          headerChunks.push(dim(`(first: ${state.first.label})`))
        }
        const header = new TextRenderable(ctx.renderer, {
          content: new StyledText(headerChunks),
        })
        contentBox.add(header)
        const sep = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
        })
        contentBox.add(sep)

        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          const isSelected = i === state.selectedIndex
          const prefix = isSelected ? cyan('▸ ') : dim('  ')
          const sub = it.sub.length > 50 ? it.sub.slice(0, 47) + '...' : it.sub
          const row = new TextRenderable(ctx.renderer, {
            content: new StyledText([
              prefix,
              isSelected ? white(it.label) : dim(it.label),
              dim('  '),
              dim(sub),
            ]),
          })
          contentBox.add(row)
        }
      }
      const sep2 = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep2)
      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Back')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
      footerBox.add(footer)
      contentBox.add(footerBox)
    }

    ctx.renderer.requestRender?.()
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()
  refresh()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape') {
      if (state.stage === 'kind') {
        modal.hide()
        ctx.input.focus()
        return true
      }
      if (state.stage === 'first') {
        state.stage = 'kind'
        state.selectedIndex = 0
        state.kind = 'change'
        refresh()
        return true
      }
      if (state.stage === 'second') {
        state.stage = 'first'
        state.selectedIndex = 0
        state.first = null
        refresh()
        return true
      }
    }
    if (state.stage === 'kind') {
      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1)
        refresh()
        return true
      }
      if (key.name === 'down') {
        state.selectedIndex = Math.min(1, state.selectedIndex + 1)
        refresh()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        state.kind = state.selectedIndex === 0 ? 'change' : 'release'
        // Make sure we have items
        const items = getItems()
        if (items.length < 1) {
          refresh()
          return true
        }
        // For changes, preselect the second-to-last (older) and last (newer) for convenience
        if (state.kind === 'change' && items.length >= 2) {
          state.selectedIndex = items.length - 2
        } else {
          state.selectedIndex = 0
        }
        state.stage = 'first'
        refresh()
        return true
      }
    } else if (state.stage === 'first') {
      const items = getItems()
      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1)
        refresh()
        return true
      }
      if (key.name === 'down') {
        state.selectedIndex = Math.min(items.length - 1, state.selectedIndex + 1)
        refresh()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        state.first = items[state.selectedIndex]
        state.selectedIndex = 0
        state.stage = 'second'
        refresh()
        return true
      }
    } else if (state.stage === 'second') {
      const items = getItems()
      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1)
        refresh()
        return true
      }
      if (key.name === 'down') {
        state.selectedIndex = Math.min(items.length - 1, state.selectedIndex + 1)
        refresh()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        state.second = items[state.selectedIndex]
        modal.hide()
        ctx.input.focus()
        const first = state.first!
        const second = state.second!
        const v1 = first.kind === 'change' ? String(first.id) : first.version
        const v2 = second.kind === 'change' ? String(second.id) : second.version
        showDiffModal(ctx, agentName, state.kind, v1, v2)
        return true
      }
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

const commands: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show all available slash commands',
    category: 'chat',
    handler: async (ctx) => {
      if (ctx.uiMode === 'on-host') {
        ctx.messages.addAgentMessage(
          'On-host commands:\n' +
          '  /clear  - Clear all messages from the chat\n' +
          '  /copy   - Copy the last agent response to clipboard\n' +
          '  /quit   - Exit the TUI\n' +
          '  /exit   - Exit the TUI\n' +
          '  /help   - Show this help\n' +
          '\n' +
          'Type a message and press Enter to talk to the agent.\n' +
          'Press Ctrl+C to exit at any time.',
          ctx.mode,
        )
        return
      }

      const lines: string[] = []
      lines.push('Available commands:')
      lines.push('')

      const categories: Record<string, string> = {
        chat: 'Chat',
        agent: 'Agent',
        session: 'Session',
        git: 'Git',
      }

      for (const [cat, label] of Object.entries(categories)) {
        const cmds = commands.filter((c) => c.category === cat)
        if (cmds.length > 0) {
          lines.push(`${label}:`)
          for (const cmd of cmds) {
            const args = cmd.args ? ` ${cmd.args}` : ''
            lines.push(`  /${cmd.name}${args} - ${cmd.description}`)
          }
          lines.push('')
        }
      }

      ctx.messages.addAgentMessage(lines.join('\n'), ctx.mode)
    },
  },

  {
    name: 'clear',
    description: 'Clear all messages from the chat',
    category: 'chat',
    handler: async (ctx) => {
      for (const child of ctx.messages.scrollBox.getChildren()) {
        ctx.messages.scrollBox.remove(child.id)
      }
      ctx.messageHistory = []
      ctx.lastAgentMessage = undefined
    },
  },

  {
    name: 'mode',
    description: 'Toggle or set plan/build mode',
    category: 'chat',
    modes: ['dev', 'production'],
    args: '[plan|build]',
    handler: async (ctx, args) => {
      let newMode: 'plan' | 'build'
      if (args.length > 0) {
        const arg = args[0].toLowerCase()
        if (arg !== 'plan' && arg !== 'build') {
          ctx.messages.addAgentMessage('Usage: /mode [plan|build]', ctx.mode)
          return
        }
        newMode = arg
      } else {
        newMode = ctx.mode === 'plan' ? 'build' : 'plan'
      }

      ctx.setMode(newMode)
      ctx.messages.addAgentMessage(`Mode set to ${newMode.toUpperCase()}`, ctx.mode)
    },
  },

  {
    name: 'mode?',
    description: 'Show current mode',
    category: 'chat',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      ctx.messages.addAgentMessage(`Current mode: ${ctx.mode.toUpperCase()}`, ctx.mode)
    },
  },

  {
    name: 'save',
    description: 'Save conversation transcript to file',
    category: 'session',
    modes: ['dev', 'production'],
    args: '[filename]',
    handler: async (ctx, args) => {
      if (ctx.messageHistory.length === 0) {
        ctx.messages.addAgentMessage('No messages to save.', ctx.mode)
        return
      }

      try {
        const filePath = saveTranscript(ctx.agentName, ctx.messageHistory, args[0])
        ctx.messages.addAgentMessage(`Transcript saved to: ${filePath}`, ctx.mode)
      } catch (err) {
        ctx.messages.addAgentMessage(
          `Failed to save transcript: ${err instanceof Error ? err.message : String(err)}`,
          ctx.mode,
        )
      }
    },
  },

  {
    name: 'copy',
    description: 'Copy the last agent response to clipboard',
    category: 'chat',
    handler: async (ctx) => {
      if (!ctx.lastAgentMessage) {
        ctx.messages.addAgentMessage('No agent response to copy.', ctx.mode)
        return
      }

      try {
        await clipboardy.write(ctx.lastAgentMessage)
        ctx.messages.addAgentMessage('Last agent response copied to clipboard.', ctx.mode)
      } catch (err) {
        ctx.messages.addAgentMessage(
          `Failed to copy to clipboard: ${err instanceof Error ? err.message : String(err)}`,
          ctx.mode,
        )
      }
    },
  },

  {
    name: 'reset',
    description: 'Clear messages and reset context',
    category: 'session',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      for (const child of ctx.messages.scrollBox.getChildren()) {
        ctx.messages.scrollBox.remove(child.id)
      }
      ctx.messageHistory = []
      ctx.lastAgentMessage = undefined
      ctx.messages.addAgentMessage('Chat reset. Context cleared.', ctx.mode)
    },
  },

  {
    name: 'list',
    description: 'List all agents with their status',
    category: 'agent',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const db = await getDb()
      const agents = listAgentsFromDisk()

      // Build modal content
      const modal = createModal(ctx.renderer, ctx.input, {
        title: 'Agents',
        overlay: true,
      })

      // Add overlay to renderer if present
      if (modal.overlay) {
        ctx.renderer.root.add(modal.overlay)
      }

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      if (agents.length === 0) {
        const emptyText = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('No agents found.')]),
        })
        contentBox.add(emptyText)

        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('\nCreate your first agent with: cast new')]),
        })
        contentBox.add(hint)
      } else {
        const tableData: (TextChunk[] | null)[][] = []

        // Header row with selection column
        tableData.push([
          [white('')],
          [white('Agent Name')],
          [white('Description')],
          [white('Status')],
        ])

        // Data rows with selection column
        for (const name of agents) {
          const description = getAgentDescription(name)

          let statusText = 'stopped'
          let statusColor = red

          if (db) {
            try {
              const deployments = db.listDeployments(name)
              const localAgent = db.getLocalAgent(name)

              if (deployments.length > 0) {
                const dep = deployments[0] // most recent
                statusText = `deployed (${dep.provider}, sha:${dep.id})`
                if (deployments.length > 1) {
                  statusText += ` +${deployments.length - 1} more`
                }
                statusColor = green
              } else if (localAgent?.port) {
                const running = isProcessAlive(localAgent.pid as number)
                if (running) {
                  statusText = `local (port ${localAgent.port})`
                  statusColor = cyan
                } else {
                  statusText = 'stopped'
                  statusColor = yellow
                }
              }
            } catch {
              // Database lookup failed for this agent — show as stopped
            }
          }

          tableData.push([
            [dim('  ')],
            [white(name)],
            description ? [dim(description)] : [dim('-')],
            [statusColor(statusText)],
          ])
        }

        const table = new TextTableRenderable(ctx.renderer, {
          content: tableData,
          columnWidthMode: 'content',
          showBorders: false,
          columnGap: 0,
          cellPadding: 0,
        })
        contentBox.add(table)
      }

      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('ESC Close')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        alignItems: 'center',
      })
      footerBox.add(footer)
      contentBox.add(footerBox)

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
    },
  },

  {
    name: 'describe',
    description: 'Show details for the current agent',
    category: 'agent',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      try {
        const agent = db.getAgent(ctx.agentName)
        const localAgent = db.getLocalAgent(ctx.agentName)
        const deployments = db.listDeployments(ctx.agentName)

        const lines: string[] = []
        lines.push(`Agent: ${ctx.agentName}`)
        lines.push('')

        if (agent) {
          lines.push('Database record:')
          lines.push(`  Created: ${agent.created_at}`)
          lines.push(`  Updated: ${agent.updated_at}`)
          lines.push(`  YAML path: ${agent.agent_yaml_path || 'N/A'}`)
          lines.push(`  Run count: ${agent.run_count || 0}`)
          lines.push('')
        } else {
          lines.push('No database record found.')
          lines.push('')
        }

        if (localAgent) {
          lines.push('Local status:')
          lines.push(`  PID: ${localAgent.pid}`)
          lines.push(`  Port: ${localAgent.port}`)
          lines.push(`  Started: ${localAgent.started_at}`)
          if (localAgent.stopped_at) {
            lines.push(`  Stopped: ${localAgent.stopped_at}`)
          }
          lines.push('')
        } else {
          lines.push('Local status: not running')
          lines.push('')
        }

        if (deployments.length > 0) {
          lines.push('Deployments:')
          for (const dep of deployments) {
            lines.push(`  SHA: ${dep.id}`)
            lines.push(`  Provider: ${dep.provider}`)
            lines.push(`  URL: ${dep.deployment_url}`)
            lines.push(`  Version: ${dep.deployed_version || 'latest'}`)
            lines.push(`  Deployed: ${dep.deployed_at}`)
            if (dep.last_connected_at) {
              lines.push(`  Last connected: ${dep.last_connected_at}`)
            }
            lines.push('')
          }
        } else {
          lines.push('Deployments: none')
          lines.push('')
        }

        lines.push('Current connection:')
        lines.push(`  URL: ${ctx.agentUrl}`)
        lines.push(`  Mode: ${ctx.mode}`)
        lines.push('')

        // Read and display full instructions.md and agent.yaml
        const fs = require('fs')
        const path = require('path')
        const os = require('os')
        const yaml = require('yaml')

        // Use stored yaml path or fallback to default location
        const agentYamlPath = agent?.agent_yaml_path || path.join(os.homedir(), '.cast', 'agents', ctx.agentName, 'agent.yaml')
        const agentDir = path.dirname(agentYamlPath)

          if (fs.existsSync(agentYamlPath)) {
            try {
              const agentConfig = yaml.parse(fs.readFileSync(agentYamlPath, 'utf8'))
              const instructionsFile = agentConfig.brain?.instructions_file || 'instructions.md'
              const instructionsPath = path.join(agentDir, instructionsFile)

              if (fs.existsSync(instructionsPath)) {
                const instructions = fs.readFileSync(instructionsPath, 'utf8')
                lines.push('📝 Instructions (Full):')
                lines.push('```markdown')
                lines.push(instructions)
                lines.push('```')
                lines.push('')
              }
            } catch (e) {
              // Ignore errors reading instructions
            }
          }

          // Read and display full agent.yaml
          if (fs.existsSync(agentYamlPath)) {
            try {
              const agentYamlContent = fs.readFileSync(agentYamlPath, 'utf8')
              const parsed = yaml.parse(agentYamlContent)
              const formattedYaml = yaml.stringify(parsed, {indent: 2, lineWidth: 0})
              lines.push('📄 Agent Configuration (Full):')
              lines.push('```yaml')
              lines.push(formattedYaml)
              lines.push('```')
            } catch (e) {
              // Ignore errors reading agent.yaml
            }
          }

        ctx.messages.addAgentMessage(lines.join('\n'), ctx.mode)
      } catch (err) {
        ctx.messages.addAgentMessage(
          `Failed to describe agent: ${err instanceof Error ? err.message : String(err)}`,
          ctx.mode,
        )
      }
    },
  },

  {
    name: 'stop',
    description: 'Stop the current local agent',
    category: 'agent',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      try {
        const localAgent = db.getLocalAgent(ctx.agentName)

        if (!localAgent) {
          ctx.messages.addAgentMessage(`Agent '${ctx.agentName}' is not currently running locally.`, ctx.mode)
          return
        }

        const pid = localAgent.pid as number

        if (!isProcessAlive(pid)) {
          ctx.messages.addAgentMessage(`Process ${pid} is not running. Cleaning up database entry.`, ctx.mode)
          db.removeLocalAgent(ctx.agentName)
          return
        }

        process.kill(pid, 'SIGTERM')

        let stopped = false
        for (let i = 0; i < 50; i++) {
          if (!isProcessAlive(pid)) {
            stopped = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        if (stopped) {
          db.removeLocalAgent(ctx.agentName)
          ctx.messages.addAgentMessage(`Agent '${ctx.agentName}' stopped successfully.`, ctx.mode)
        } else {
          ctx.messages.addAgentMessage(
            `Agent '${ctx.agentName}' did not stop gracefully. You may need to kill it manually.`,
            ctx.mode,
          )
        }
      } catch (err) {
        ctx.messages.addAgentMessage(
          `Failed to stop agent: ${err instanceof Error ? err.message : String(err)}`,
          ctx.mode,
        )
      }
    },
  },

  {
    name: 'connect',
    description: 'Connect to a different agent',
    category: 'session',
    modes: ['dev', 'production'],
    args: '[agent-name|sha]',
    handler: async (ctx, args) => {
      const db = await getDb()
      const keychain = await getKeychain()

      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      if (args.length === 0) {
        // Build a list of all recent deployments across all agents.
        const allAgents = listAgentsFromDisk()
        type DeploymentRow = {
          agent_name: string
          deployment_sha: string
          provider: string
          deployed_version: string | null
          deployed_at: string
        }
        const deployments: DeploymentRow[] = []
        for (const name of allAgents) {
          try {
            const rows = db.listAllDeploymentsForAgent(name) as DeploymentRow[]
            for (const r of rows) {
              deployments.push({
                agent_name: name,
                deployment_sha: r.deployment_sha,
                provider: r.provider,
                deployed_version: r.deployed_version,
                deployed_at: r.deployed_at,
              })
            }
          } catch {
            // skip agent on db error
          }
        }
        // Newest first
        deployments.sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''))

        const modal = createModal(ctx.renderer, ctx.input, {
          title: 'Connect to Agent',
          overlay: true,
        })

        if (modal.overlay) {
          ctx.renderer.root.add(modal.overlay)
        }

        const contentBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          gap: 0,
          paddingTop: 2,
          paddingLeft: 2,
          paddingRight: 2,
        })

        // Header
        const headerText = new TextRenderable(ctx.renderer, {
          content: new StyledText([white('Recent deployments:')]),
        })
        contentBox.add(headerText)
        const sep = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
        })
        contentBox.add(sep)

        let selectedIndex = 0
        // SHA input state
        let shaInput = ''
        const MAX_SHA_LEN = 64

        function renderList() {
          // Don't blow away the SHA input row at the bottom; rebuild the
          // upper list section only.
          // Simpler approach: just rebuild everything (we only have a small list)
          for (const child of contentBox.getChildren()) {
            contentBox.remove(child.id)
          }

          const h = new TextRenderable(ctx.renderer, {
            content: new StyledText([white('Recent deployments:')]),
          })
          contentBox.add(h)
          const s = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(s)

          if (deployments.length === 0) {
            const empty = new TextRenderable(ctx.renderer, {
              content: new StyledText([dim('No deployments found.')]),
            })
            contentBox.add(empty)
          } else {
            const tableData: (TextChunk[] | null)[][] = []
            tableData.push([
              [white('')],
              [white('Agent')],
              [white('SHA')],
              [white('Provider')],
              [white('Version')],
              [white('Deployed')],
            ])
            for (let i = 0; i < deployments.length; i++) {
              const d = deployments[i]
              const isSelected = i === selectedIndex
              const date = new Date(d.deployed_at)
              const dateStr = date.toLocaleDateString()
              const selectionColumn = isSelected ? [cyan('▸ ')] : [dim('  ')]
              const shortSha = d.deployment_sha ? d.deployment_sha.slice(0, 7) : '-'
              tableData.push([
                selectionColumn,
                [white(d.agent_name || '-')],
                [isSelected ? cyan(shortSha) : dim(shortSha)],
                [white(d.provider || '-')],
                [cyan(d.deployed_version || '-')],
                [dim(dateStr)],
              ])
            }
            const table = new TextTableRenderable(ctx.renderer, {
              content: tableData,
              columnWidthMode: 'content',
              showBorders: false,
              columnGap: 1,
              cellPadding: 0,
            })
            contentBox.add(table)
          }

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          // SHA input row
          const shaLabel = new TextRenderable(ctx.renderer, {
            content: new StyledText([
              dim('Or enter SHA: '),
              white(`[${shaInput}_]`),
            ]),
          })
          contentBox.add(shaLabel)

          // Footer
          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([
              white('↑↓ '), dim('Select  '),
              white('Enter '), dim('Connect  '),
              white('Type '), dim('SHA  '),
              white('ESC '), dim('Close'),
            ]),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
          footerBox.add(footer)
          contentBox.add(footerBox)
        }

        renderList()

        const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

        modal.box.handleKeyPress = (key: KeyEvent) => {
          // Typing into SHA input
          if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
            if (shaInput.length > 0) {
              shaInput = shaInput.slice(0, -1)
              renderList()
              ctx.renderer.requestRender?.()
            }
            return true
          }
          if (key.name === 'return' || key.name === 'enter') {
            // Prefer typed SHA if present
            if (shaInput.length > 0) {
              modal.hide()
              launchConnect(ctx, shaInput)
              return true
            }
            if (deployments.length > 0) {
              const d = deployments[selectedIndex]
              modal.hide()
              launchConnect(ctx, d.deployment_sha)
              return true
            }
            return true
          }
          if (key.name === 'escape') {
            modal.hide()
            ctx.input.focus()
            return true
          }
          if (key.name === 'up') {
            if (deployments.length > 0) {
              selectedIndex = (selectedIndex - 1 + deployments.length) % deployments.length
              renderList()
              ctx.renderer.requestRender?.()
            }
            return true
          }
          if (key.name === 'down') {
            if (deployments.length > 0) {
              selectedIndex = (selectedIndex + 1) % deployments.length
              renderList()
              ctx.renderer.requestRender?.()
            }
            return true
          }
          // Printable characters: append to SHA input
          if (key.name && key.name.length === 1 && !key.ctrl && !key.meta && /^[a-zA-Z0-9]$/.test(key.name)) {
            if (shaInput.length < MAX_SHA_LEN) {
              shaInput += key.name
              renderList()
              ctx.renderer.requestRender?.()
            }
            return true
          }
          return originalHandleKeyPress ? originalHandleKeyPress(key) : false
        }

        modal.setContent(contentBox)
        ctx.renderer.root.add(modal.box)
        modal.show()
        return
      }

      // Handle explicit agent name or SHA
      const targetName = args[0]
      // Launch CLI connect which handles keychain access in Node.js
      launchConnect(ctx, targetName)
      return
    },
  },

  {
    name: 'edit',
    description: 'Load an existing agent into the builder for editing',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[agent-name]',
    handler: async (ctx, args) => {
      if (args.length > 0) {
        const agentName = args[0]
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(agentName)) {
          ctx.messages.addAgentMessage(
            `Invalid agent name '${agentName}'. Names must start with a letter or number and contain only letters, numbers, and hyphens.`,
            ctx.mode,
          )
          return
        }
        const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName, 'agent.yaml')
        if (!fs.existsSync(agentPath)) {
          ctx.messages.addAgentMessage(`Agent '${agentName}' not found.`, ctx.mode)
          return
        }
        launchBuilderEditor(ctx, agentName)
        return
      }

      const agents = listAgentsFromDisk()
      if (agents.length === 0) {
        ctx.messages.addAgentMessage('No agents found. Create one with: cast new', ctx.mode)
        return
      }

      const modal = createModal(ctx.renderer, ctx.input, {
        title: 'Select Agent to Edit',
        overlay: true,
      })

      // Add overlay to renderer if present
      if (modal.overlay) {
        ctx.renderer.root.add(modal.overlay)
      }

      let selectedIndex = 0

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 3,
        paddingLeft: 2,
        paddingRight: 2,
      })

      function renderList() {
        for (const child of contentBox.getChildren()) {
          contentBox.remove(child.id)
        }

        const tableData: (TextChunk[] | null)[][] = []

        // Header row with selection column
        tableData.push([
          [white('')],
          [white('Agent Name')],
          [white('Description')],
        ])

        // Data rows with selection column
        for (let i = 0; i < agents.length; i++) {
          const isSelected = i === selectedIndex
          const nameColor = isSelected ? cyan : white
          const description = getAgentDescription(agents[i])

          // Selection column
          const selectionColumn = isSelected ? [cyan('▸ ')] : [dim('  ')]

          tableData.push([
            selectionColumn,
            [nameColor(agents[i])],
            description ? [dim(description)] : [dim('-')],
          ])
        }

        const table = new TextTableRenderable(ctx.renderer, {
          content: tableData,
          columnWidthMode: 'content',
          showBorders: false,
          columnGap: 0,
          cellPadding: 0,
        })
        contentBox.add(table)

        const footer = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Close')]),
        })
        const footerBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          alignItems: 'center',
        })
        footerBox.add(footer)
        contentBox.add(footerBox)
      }

      renderList()
      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()

      const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

      modal.box.handleKeyPress = (key: KeyEvent) => {
        if (key.name === 'up') {
          selectedIndex = (selectedIndex - 1 + agents.length) % agents.length
          renderList()
          ctx.renderer.requestRender?.()
          return true
        }
        if (key.name === 'down') {
          selectedIndex = (selectedIndex + 1) % agents.length
          renderList()
          ctx.renderer.requestRender?.()
          return true
        }
        if (key.name === 'return' || key.name === 'enter') {
          modal.hide()
          launchBuilderEditor(ctx, agents[selectedIndex])
          return true
        }
        if (key.name === 'escape') {
          modal.hide()
          ctx.input.focus()
          return true
        }
        return originalHandleKeyPress ? originalHandleKeyPress(key) : false
      }
    },
  },

  {
    name: 'rename',
    description: 'Rename an existing agent',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[current-name] [new-name]',
    handler: async (ctx, args) => {
      const agents = listAgentsFromDisk()

      if (args.length === 0) {
        if (agents.length === 0) {
          ctx.messages.addAgentMessage('No agents found. Create one with: cast new', ctx.mode)
          return
        }

        const modal = createModal(ctx.renderer, ctx.input, {
          title: 'Select Agent to Rename',
          overlay: true,
        })

        if (modal.overlay) {
          ctx.renderer.root.add(modal.overlay)
        }

        let selectedIndex = 0

        const contentBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          gap: 0,
          paddingTop: 3,
          paddingLeft: 2,
          paddingRight: 2,
        })

        function renderList() {
          for (const child of contentBox.getChildren()) {
            contentBox.remove(child.id)
          }

          const tableData: (TextChunk[] | null)[][] = []
          tableData.push([
            [white('')],
            [white('Agent Name')],
            [white('Description')],
          ])

          for (let i = 0; i < agents.length; i++) {
            const isSelected = i === selectedIndex
            const nameColor = isSelected ? cyan : white
            const description = getAgentDescription(agents[i])
            const selectionColumn = isSelected ? [cyan('▸ ')] : [dim('  ')]

            tableData.push([
              selectionColumn,
              [nameColor(agents[i])],
              description ? [dim(description)] : [dim('-')],
            ])
          }

          const table = new TextTableRenderable(ctx.renderer, {
            content: tableData,
            columnWidthMode: 'content',
            showBorders: false,
            columnGap: 0,
            cellPadding: 0,
          })
          contentBox.add(table)

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Close')]),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {
            width: '100%',
            alignItems: 'center',
          })
          footerBox.add(footer)
          contentBox.add(footerBox)
        }

        renderList()
        modal.setContent(contentBox)
        ctx.renderer.root.add(modal.box)
        modal.show()

        const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

        modal.box.handleKeyPress = (key: KeyEvent) => {
          if (key.name === 'up') {
            selectedIndex = (selectedIndex - 1 + agents.length) % agents.length
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = (selectedIndex + 1) % agents.length
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'return' || key.name === 'enter') {
            modal.hide()
            promptForNewName(ctx, agents[selectedIndex])
            return true
          }
          if (key.name === 'escape') {
            modal.hide()
            ctx.input.focus()
            return true
          }
          return originalHandleKeyPress ? originalHandleKeyPress(key) : false
        }
        return
      }

      if (args.length === 1) {
        const currentName = args[0]
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(currentName)) {
          ctx.messages.addAgentMessage(
            `Invalid agent name '${currentName}'. Names must contain only letters, numbers, and hyphens.`,
            ctx.mode,
          )
          return
        }
        const agentPath = path.join(os.homedir(), '.cast', 'agents', currentName, 'agent.yaml')
        if (!fs.existsSync(agentPath)) {
          ctx.messages.addAgentMessage(`Agent '${currentName}' not found.`, ctx.mode)
          return
        }
        promptForNewName(ctx, currentName)
        return
      }

      if (args.length >= 2) {
        const currentName = args[0]
        const newName = args[1]

        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(currentName)) {
          ctx.messages.addAgentMessage(`Invalid current agent name '${currentName}'.`, ctx.mode)
          return
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(newName)) {
          ctx.messages.addAgentMessage(`Invalid new agent name '${newName}'. Names must contain only letters, numbers, and hyphens.`, ctx.mode)
          return
        }

        const agentPath = path.join(os.homedir(), '.cast', 'agents', currentName, 'agent.yaml')
        if (!fs.existsSync(agentPath)) {
          ctx.messages.addAgentMessage(`Agent '${currentName}' not found.`, ctx.mode)
          return
        }

        const newPath = path.join(os.homedir(), '.cast', 'agents', newName)
        if (fs.existsSync(newPath)) {
          ctx.messages.addAgentMessage(`An agent named '${newName}' already exists.`, ctx.mode)
          return
        }

        launchRenameWithName(ctx, currentName, newName)
      }
    },
  },

  {
    name: 'quit',
    description: 'Exit the TUI',
    category: 'session',
    handler: async (ctx) => {
      ctx.exitTui()
    },
  },

  {
    name: 'exit',
    description: 'Exit the TUI',
    category: 'session',
    handler: async (ctx) => {
      ctx.exitTui()
    },
  },

  {
    name: 'update',
    description: 'Update the current agent',
    category: 'agent',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      ctx.messages.addAgentMessage(`Use \`cast update ${ctx.agentName}\` from the CLI for now.`, ctx.mode)
    },
  },

  {
    name: 'upgrade',
    description: 'Upgrade a deployed agent to a new version',
    category: 'agent',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      // The chat is already connected to a specific agent — operate on it
      // directly. No need for an agent picker.
      const agentName = ctx.agentName
      const deployment = db.getActiveDeployment(agentName)
      const releases = await getReleasesForAgent(agentName)

      if (!deployment && releases.length === 0) {
        ctx.messages.addAgentMessage(
          `Agent "${agentName}" is not currently deployed.\n` +
          `Use /deploy to deploy first.`,
          ctx.mode,
        )
        return
      }

      if (deployment) {
        // With the new semver-based release system, the deployed_version
        // is a string. The legacy showVersionSelection flow expects an
        // integer ID, so we render a new selector that's semver-aware.
        showUpgradeVersionPicker(ctx, {
          name: agentName,
          provider: deployment.provider,
          deployedVersion: deployment.deployed_version ?? null,
          sha: deployment.id,
        }, releases)
        return
      }

      // No deployment record, but releases exist — there is nothing to
      // upgrade against, so direct the user to deploy first.
      ctx.messages.addAgentMessage(
        `Agent "${agentName}" has no active deployment.\n` +
        `Use /deploy to deploy a release.`,
        ctx.mode,
      )
    },
  },

  {
    name: 'deploy',
    description: 'Deploy the current agent',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[provider]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const presetProvider = args[0] || ''

      // If a provider was passed on the command line, skip the modal flow
      // and run the deploy directly with the default release version.
      if (presetProvider) {
        await runDeployInTerminal(ctx.renderer, ctx.input, agentName, presetProvider, ctx.messages)
        return
      }

      // Show a release + provider selection modal.
      const releases = await getReleasesForAgent(agentName)

      const modal = createModal(ctx.renderer, ctx.input, {
        title: `Deploy: ${agentName}`,
        overlay: true,
      })
      if (modal.overlay) ctx.renderer.root.add(modal.overlay)

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 1,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      type Stage = 'release' | 'provider' | 'running' | 'success'
      const state = {
        stage: releases.length > 0 ? 'release' : 'provider' as Stage,
        releaseIndex: 0, // 0 = latest
        providerIndex: 0,
        error: '' as string,
        resultSha: '' as string,
        resultProvider: '' as string,
        resultUrl: '' as string,
      }

      const providers = [
        {key: 'railway', name: 'Railway', desc: 'Managed containers with automatic deployments'},
        {key: 'fly', name: 'Fly.io', desc: 'Distributed containers close to your users'},
        {key: 'digitalocean', name: 'DigitalOcean', desc: 'Droplet with Docker container hosting'},
        {key: 'sprites', name: 'Sprites', desc: 'Persistent Firecracker VMs on Fly.io'},
        {key: 'docker', name: 'Docker (local)', desc: 'Self-hosted Docker container on this machine'},
        {key: 'local', name: 'Local (no container)', desc: 'Run the agent directly without Docker'},
      ]

      function refresh(): void {
        for (const child of contentBox.getChildren()) {
          contentBox.remove(child.id)
        }

        if (state.stage === 'release') {
          const header = new TextRenderable(ctx.renderer, {
            content: new StyledText([white('Select release to deploy:')]),
          })
          contentBox.add(header)

          const sep = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep)

          for (let i = 0; i < releases.length; i++) {
            const r = releases[i]
            const isSelected = i === state.releaseIndex
            const prefix = isSelected ? cyan('▸ ') : dim('  ')
            const label = i === 0 ? `${r.version} (latest)` : r.version
            const message = r.message || ''
            const row = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                prefix,
                isSelected ? white(label) : dim(label),
                dim('  '),
                dim(message),
              ]),
            })
            contentBox.add(row)
          }

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          if (state.error) {
            const errLine = new TextRenderable(ctx.renderer, {
              content: new StyledText([red(state.error)]),
            })
            contentBox.add(errLine)
          }

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('↑↓ Navigate  Enter Next  ESC Cancel')]),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
          footerBox.add(footer)
          contentBox.add(footerBox)
        } else if (state.stage === 'provider') {
          const header = new TextRenderable(ctx.renderer, {
            content: new StyledText([white('Select deployment provider:')]),
          })
          contentBox.add(header)

          const sep = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep)

          for (let i = 0; i < providers.length; i++) {
            const p = providers[i]
            const isSelected = i === state.providerIndex
            const prefix = isSelected ? cyan('▸ ') : dim('  ')
            const row = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                prefix,
                isSelected ? white(p.name) : dim(p.name),
                dim(` — ${p.desc}`),
              ]),
            })
            contentBox.add(row)
          }

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          if (state.error) {
            const errLine = new TextRenderable(ctx.renderer, {
              content: new StyledText([red(state.error)]),
            })
            contentBox.add(errLine)
          }

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('↑↓ Navigate  Enter Deploy  ESC Cancel')]),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
          footerBox.add(footer)
          contentBox.add(footerBox)
        } else if (state.stage === 'success') {
          const header = new TextRenderable(ctx.renderer, {
            content: new StyledText([green('✓ Deployment Successful!')]),
          })
          contentBox.add(header)

          const sep = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep)

          contentBox.add(new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('Agent:    '), white(agentName)]),
          }))
          contentBox.add(new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('Provider: '), white(state.resultProvider)]),
          }))
          contentBox.add(new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('URL:      '), cyan(state.resultUrl || '(none)')]),
          }))
          contentBox.add(new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('SHA:      '), yellow(state.resultSha)]),
          }))

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          const hint = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim(`Connect with: `), cyan(`/connect ${state.resultSha}`)]),
          })
          contentBox.add(hint)

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('Enter/ESC Close')]),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
          footerBox.add(footer)
          contentBox.add(footerBox)
        }

        ctx.renderer.requestRender?.()
      }

      const closeModal = (): void => {
        modal.hide()
        ctx.input.focus()
      }

      const runDeploy = async (provider: string, version: string): Promise<void> => {
        // Run the deploy via the existing terminal flow. The terminal
        // flow builds a modal that streams output and blocks until the
        // child process exits.
        await runDeployInTerminal(ctx.renderer, ctx.input, agentName, provider, ctx.messages)

        // Query the database for the new deployment record.
        const db = await getDb()
        if (db) {
          const dep = db.getActiveDeployment(agentName)
          if (dep) {
            state.resultSha = dep.id
            state.resultProvider = dep.provider || provider
            state.resultUrl = dep.deployment_url || ''
          }
        }
        if (!state.resultSha) {
          state.resultSha = 'unknown'
          state.resultProvider = provider
          state.resultUrl = ''
        }
        state.stage = 'success'
        refresh()
      }

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
      refresh()

      const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
      modal.box.handleKeyPress = (key: KeyEvent): boolean => {
        if (state.stage === 'success') {
          if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
            closeModal()
            return true
          }
          return originalHandleKeyPress ? originalHandleKeyPress(key) : false
        }
        if (state.stage === 'release') {
          if (key.name === 'up') {
            state.releaseIndex = Math.max(0, state.releaseIndex - 1)
            refresh()
            return true
          }
          if (key.name === 'down') {
            state.releaseIndex = Math.min(releases.length - 1, state.releaseIndex + 1)
            refresh()
            return true
          }
          if (key.name === 'escape') {
            closeModal()
            return true
          }
          if (key.name === 'return' || key.name === 'enter') {
            state.stage = 'provider'
            refresh()
            return true
          }
        } else if (state.stage === 'provider') {
          if (key.name === 'up') {
            state.providerIndex = Math.max(0, state.providerIndex - 1)
            refresh()
            return true
          }
          if (key.name === 'down') {
            state.providerIndex = Math.min(providers.length - 1, state.providerIndex + 1)
            refresh()
            return true
          }
          if (key.name === 'escape') {
            closeModal()
            return true
          }
          if (key.name === 'return' || key.name === 'enter') {
            const provider = providers[state.providerIndex].key
            const version = releases.length > 0 ? releases[state.releaseIndex].version : 'latest'
            void runDeploy(provider, version)
            return true
          }
        }
        return originalHandleKeyPress ? originalHandleKeyPress(key) : false
      }
    },
  },

  {
    name: 'changes',
    description: 'Show change history for current agent',
    category: 'session',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const agentName = ctx.agentName
      const changes = getChangesForAgent(agentName)

      // Build modal content
      const modal = createModal(ctx.renderer, ctx.input, {
        title: `Changes: ${agentName}`,
        overlay: true,
      })

      if (modal.overlay) {
        ctx.renderer.root.add(modal.overlay)
      }

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      if (changes.length === 0) {
        const emptyText = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('No changes found.')]),
        })
        contentBox.add(emptyText)

        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('\nChanges are created when the agent is edited.')]),
        })
        contentBox.add(hint)
      } else {
        const sortedChanges = [...changes].sort((a, b) => b.id - a.id)

        let selectedIndex = 0

        function renderList() {
          for (const child of contentBox.getChildren()) {
            contentBox.remove(child.id)
          }

          const headerText = new TextRenderable(ctx.renderer, {
            content: new StyledText([
              white('Change History'),
              dim(' | '),
              white(`Current: v${sortedChanges[0]?.id || 0}`),
            ]),
          })
          contentBox.add(headerText)

          const sep = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep)

          for (let i = 0; i < sortedChanges.length; i++) {
            const c = sortedChanges[i]
            const isSelected = i === selectedIndex
            const date = new Date(c.timestamp)
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
            const sourceLabel = c.source === 'create' ? dim('[CREATED]') :
                               c.source === 'cli' ? cyan('[CLI]') :
                               green('[BUILDER]')

            const prefix = isSelected ? cyan('▸ ') : dim('  ')
            const changeColor = isSelected ? white : dim

            const changeText = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                prefix,
                changeColor(`v${c.id}`),
                dim('  '),
                sourceLabel,
                dim('  '),
                dim(dateStr),
                dim('\n    '),
                changeColor(c.message),
              ]),
            })
            contentBox.add(changeText)
          }

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          // Footer: ↑↓ Navigate  R Restore  D Diff  ESC Close
          const footerChunks: any[] = [
            white('↑↓ '), dim('Navigate  '),
            white('R '), dim('Restore  '),
            white('D '), dim('Diff  '),
            white('ESC '), dim('Close'),
          ]
          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText(footerChunks),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {
            width: '100%',
            alignItems: 'center',
          })
          footerBox.add(footer)
          contentBox.add(footerBox)
        }

        renderList()

        const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

        modal.box.handleKeyPress = (key: KeyEvent) => {
          if (key.name === 'up') {
            selectedIndex = Math.max(0, selectedIndex - 1)
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = Math.min(changes.length - 1, selectedIndex + 1)
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'escape') {
            modal.hide()
            ctx.input.focus()
            return true
          }
          // R = Restore selected change
          if (key.name && key.name.length === 1 && key.name.toLowerCase() === 'r' && !key.ctrl && !key.meta) {
            const c = sortedChanges[selectedIndex]
            if (c) {
              modal.hide()
              ctx.input.focus()
              void executeSlashCommand('restore', [`--change`, String(c.id)], ctx)
            }
            return true
          }
          // D = Diff: start a /diff flow with the selected change as the first version
          if (key.name && key.name.length === 1 && key.name.toLowerCase() === 'd' && !key.ctrl && !key.meta) {
            const c = sortedChanges[selectedIndex]
            if (c) {
              modal.hide()
              ctx.input.focus()
              // Open /diff with the first change pre-populated; the /diff modal
              // will prompt for the second change.
              void executeSlashCommand('diff', [`--change`, String(c.id)], ctx)
            }
            return true
          }
          return originalHandleKeyPress ? originalHandleKeyPress(key) : false
        }
      }

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
    },
  },

  {
    name: 'releases',
    description: 'Show releases for current agent',
    category: 'session',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const agentName = ctx.agentName
      const releases = await getReleasesForAgent(agentName)
      const db = await getDb()
      const activeDep = db ? db.getActiveDeployment(agentName) : null
      const isDeployed = activeDep !== null

      // Build modal content
      const modal = createModal(ctx.renderer, ctx.input, {
        title: `Releases: ${agentName}`,
        overlay: true,
      })

      if (modal.overlay) {
        ctx.renderer.root.add(modal.overlay)
      }

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      if (releases.length === 0) {
        const emptyText = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('No releases found.')]),
        })
        contentBox.add(emptyText)

        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('\nCreate a release with: /release or cast release')]),
        })
        contentBox.add(hint)
      } else {
        // Sort by version descending
        const sortedReleases = [...releases].sort((a, b) => {
          const parseV = (v: string) => v.split('.').map(Number)
          const va = parseV(a.version)
          const vb = parseV(b.version)
          return vb[0] - va[0] || vb[1] - va[1] || (vb[2] || 0) - (va[2] || 0)
        })

        let selectedIndex = 0

        function renderList() {
          for (const child of contentBox.getChildren()) {
            contentBox.remove(child.id)
          }

          const headerText = new TextRenderable(ctx.renderer, {
            content: new StyledText([
              white('Releases'),
              dim(' | '),
              white(`Current: ${sortedReleases[0]?.version || 'none'}`),
            ]),
          })
          contentBox.add(headerText)

          const sep = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep)

          for (let i = 0; i < sortedReleases.length; i++) {
            const r = sortedReleases[i]
            const isSelected = i === selectedIndex
            const date = new Date(r.created_at)
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()

            const prefix = isSelected ? cyan('▸ ') : dim('  ')
            const versionColor = isSelected ? white : dim

            const versionText = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                prefix,
                versionColor(r.version),
                dim('  '),
                dim(dateStr),
                dim('\n    '),
                versionColor(r.message),
              ]),
            })
            contentBox.add(versionText)
          }

          const sep2 = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
          })
          contentBox.add(sep2)

          // Footer: C = Create Release, U = Upgrade (only if deployed)
          const footerParts: Array<{text: string; color: typeof white | typeof dim | typeof cyan}> = [
            {text: '↑↓ ', color: white},
            {text: 'Navigate  ', color: dim},
            {text: 'C ', color: white},
            {text: 'Create Release  ', color: dim},
          ]
          if (isDeployed) {
            footerParts.push({text: 'U ', color: white})
            footerParts.push({text: 'Upgrade  ', color: dim})
          }
          footerParts.push({text: 'ESC ', color: white})
          footerParts.push({text: 'Close', color: dim})

          const footerChunks: any[] = []
          for (const p of footerParts) {
            footerChunks.push(p.color(p.text))
          }
          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText(footerChunks),
          })
          const footerBox = new BoxRenderable(ctx.renderer, {
            width: '100%',
            alignItems: 'center',
          })
          footerBox.add(footer)
          contentBox.add(footerBox)
        }

        renderList()

        const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

        modal.box.handleKeyPress = (key: KeyEvent) => {
          if (key.name === 'up') {
            selectedIndex = Math.max(0, selectedIndex - 1)
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = Math.min(releases.length - 1, selectedIndex + 1)
            renderList()
            ctx.renderer.requestRender?.()
            return true
          }
          if (key.name === 'escape') {
            modal.hide()
            ctx.input.focus()
            return true
          }
          // C = Create Release
          if (key.name === 'c' || (key.name && key.name.length === 1 && key.name.toLowerCase() === 'c' && !key.ctrl && !key.meta)) {
            modal.hide()
            ctx.input.focus()
            void executeSlashCommand('release', [], ctx)
            return true
          }
          // U = Upgrade (only when deployed)
          if (isDeployed && (key.name === 'u' || (key.name && key.name.length === 1 && key.name.toLowerCase() === 'u' && !key.ctrl && !key.meta))) {
            modal.hide()
            ctx.input.focus()
            void executeSlashCommand('upgrade', [], ctx)
            return true
          }
          return originalHandleKeyPress ? originalHandleKeyPress(key) : false
        }
      }

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
    },
  },

  {
    name: 'session',
    description: 'Manage conversation sessions (list, new, resume, rename, fork, delete)',
    category: 'session',
    args: '[list|new|resume|rename|fork|delete]',
    handler: async (ctx, args) => {
      const subcommand = (args[0] ?? 'list').toLowerCase()
      const rest = args.slice(1)
      const targetName =
        subcommand === 'list' ? 'session-list' :
        subcommand === 'new' ? 'session-new' :
        subcommand === 'resume' ? 'session-resume' :
        subcommand === 'rename' ? 'session-rename' :
        subcommand === 'fork' ? 'session-fork' :
        subcommand === 'delete' ? 'session-delete' :
        null

      if (!targetName) {
        ctx.messages.addAgentMessage(
          `Unknown subcommand: /session ${subcommand}. Use one of: list, new, resume, rename, fork, delete.`,
          ctx.mode,
        )
        return
      }
      const {executeSlashCommand} = await import('./slash-registry.js')
      await executeSlashCommand(targetName, rest, ctx)
    },
  },

  {
    name: 'session-list',
    description: 'List saved sessions for the current agent',
    category: 'session',
    handler: async (ctx) => {
      const items = await listSessionsMeta(ctx.agentName, 50, true)
      if (items.length === 0) {
        ctx.messages.addAgentMessage(
          `No sessions found for '${ctx.agentName}'. A new one will be created on your first message.`,
          ctx.mode,
        )
        return
      }
      showSessionPicker(ctx, items, {
        title: `Sessions: ${ctx.agentName}`,
        onSelect: async (sess) => {
          ctx.messages.addAgentMessage(
            `Resuming session ${sess.id} (${sess.message_count} message${sess.message_count === 1 ? '' : 's'}). Use /session resume ${sess.id} to reload it into the chat.`,
            ctx.mode,
          )
        },
        extraActions: {
          r: async (sess) => {
            ctx.messages.addAgentMessage(
              `Resume with: /session resume ${sess.id}`,
              ctx.mode,
            )
          },
          d: async (sess) => {
            await deleteSession(sess.id)
            ctx.messages.addAgentMessage(`Deleted session ${sess.id}.`, ctx.mode)
          },
        },
      })
    },
  },

  {
    name: 'session-new',
    description: 'Start a fresh session for the current agent',
    category: 'session',
    args: '[name]',
    handler: async (ctx, args) => {
      const name = args[0] ?? null
      try {
        const sess = await createSession({
          agentName: ctx.agentName,
          mode: ctx.mode,
          uiMode: ctx.uiMode ?? 'dev',
          name,
        })
        ctx.messages.addAgentMessage(
          `Started new session ${sess.id}${sess.name ? ` ('${sess.name}')` : ''}. The new session will take over on your next message.`,
          ctx.mode,
        )
        // End the current session and switch to the new one
        const previousId = ctx.currentSessionId
        if (previousId) {
          await endSession(previousId)
        }
        ctx.currentSessionId = sess.id
      } catch (err: any) {
        ctx.messages.addAgentMessage(
          `Failed to create session: ${err?.message ?? String(err)}`,
          ctx.mode,
        )
      }
    },
  },

  {
    name: 'session-resume',
    description: 'Resume an existing session',
    category: 'session',
    args: '[id|name]',
    handler: async (ctx, args) => {
      const identifier = args[0]
      if (!identifier) {
        const items = await listSessionsMeta(ctx.agentName, 50, true)
        if (items.length === 0) {
          ctx.messages.addAgentMessage(
            `No sessions to resume for '${ctx.agentName}'.`,
            ctx.mode,
          )
          return
        }
        showSessionPicker(ctx, items, {
          title: `Resume session: ${ctx.agentName}`,
          onSelect: async (sess) => {
            await loadSessionIntoChat(ctx, sess.id)
          },
        })
        return
      }

      const sess = await getSession(identifier)
      if (!sess) {
        ctx.messages.addAgentMessage(`Session not found: ${identifier}`, ctx.mode)
        return
      }
      await loadSessionIntoChat(ctx, sess.id)
    },
  },

  {
    name: 'session-rename',
    description: 'Rename a session',
    category: 'session',
    args: '<id|name> <new-name>',
    handler: async (ctx, args) => {
      if (args.length < 2) {
        ctx.messages.addAgentMessage('Usage: /session rename <id|name> <new-name>', ctx.mode)
        return
      }
      const [identifier, ...rest] = args
      const name = rest.join(' ')
      try {
        const updated = await renameSession(identifier, name)
        ctx.messages.addAgentMessage(`Renamed session ${updated.id} to '${updated.name}'.`, ctx.mode)
      } catch (err: any) {
        ctx.messages.addAgentMessage(`Failed to rename: ${err?.message ?? String(err)}`, ctx.mode)
      }
    },
  },

  {
    name: 'session-fork',
    description: 'Fork the current session into a new one',
    category: 'session',
    args: '[name]',
    handler: async (ctx, args) => {
      const source = ctx.currentSessionId
      if (!source) {
        ctx.messages.addAgentMessage('No active session to fork. Send a message first to create one.', ctx.mode)
        return
      }
      const name = args[0] ?? null
      try {
        const forked = await forkSession(source, name)
        ctx.messages.addAgentMessage(
          `Forked into new session ${forked.id}${forked.name ? ` ('${forked.name}')` : ''}. The fork will take over on your next message.`,
          ctx.mode,
        )
        await endSession(source)
        ctx.currentSessionId = forked.id
      } catch (err: any) {
        ctx.messages.addAgentMessage(`Failed to fork: ${err?.message ?? String(err)}`, ctx.mode)
      }
    },
  },

  {
    name: 'session-delete',
    description: 'Delete a session',
    category: 'session',
    args: '[id|name]',
    handler: async (ctx, args) => {
      const identifier = args[0] ?? ctx.currentSessionId
      if (!identifier) {
        ctx.messages.addAgentMessage(
          'No session to delete. Specify an id/name or use this command while a session is active.',
          ctx.mode,
        )
        return
      }
      try {
        await deleteSession(identifier)
        ctx.messages.addAgentMessage(`Deleted session ${identifier}.`, ctx.mode)
        if (ctx.currentSessionId === identifier) {
          ctx.currentSessionId = null
        }
      } catch (err: any) {
        ctx.messages.addAgentMessage(`Failed to delete: ${err?.message ?? String(err)}`, ctx.mode)
      }
    },
  },

  {
    name: 'git',
    description: 'Git operations for the current agent',
    category: 'git',
    modes: ['dev', 'production'],
    args: '[init|status|add|commit|push|log|diff]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      const gitDir = path.join(agentPath, '.git')

      const subcommand = args[0] || 'status'

      if (subcommand === 'init') {
        if (fs.existsSync(gitDir)) {
          ctx.messages.addAgentMessage(
            `'${agentName}' is already a Git repository.`,
            ctx.mode
          )
          return
        }

        try {
          const git = simpleGit(agentPath)
          await git.init()

          const gitignorePath = path.join(agentPath, '.gitignore')
          fs.writeFileSync(gitignorePath, `.cast/versions/\ncast.db\n*.log\n.env\n__pycache__/\n`)

          const configPath = path.join(agentPath, 'agent.yaml')
          if (fs.existsSync(configPath)) {
            const config = yaml.parse(fs.readFileSync(configPath, 'utf8')) || {}
            const readmePath = path.join(agentPath, 'README.md')
            const description = config.description || 'No description provided'
            const model = config.brain?.model || 'Not specified'
            const version = config.version || '1.0'
            const runtime = config.runtime?.python_version || '3.11'

            const builtinTools = config.tools?.builtin || []
            const mcpServers = config.tools?.mcp || []

            const formatList = (items: any[]): string => {
              if (!items || items.length === 0) return 'None'
              return items.map(item => typeof item === 'string' ? item : item.name || item.server || JSON.stringify(item)).join(', ')
            }

            const readme = `# ${agentName}

${description}

## Configuration

- **Model:** ${model}
- **Runtime:** Python ${runtime}
- **Version:** ${version}

## Tools

### Built-in
${formatList(builtinTools)}

### MCP Servers
${formatList(mcpServers)}

## Setup

\`\`\`bash
# Clone this agent
cast clone <remote-url>

# Run the agent
cast dev ${agentName}
\`\`\`

---

*Generated by cast*
`
            fs.writeFileSync(readmePath, readme)

            config.repository = { remote: 'origin', branch: 'main' }
            fs.writeFileSync(configPath, yaml.stringify(config))
          }

          await git.add('.')
          await git.commit(`Initial commit: ${agentName}`)

          ctx.messages.addAgentMessage(
            `Git repository initialized for '${agentName}'!\n\n` +
            `Next steps:\n` +
            `  - Add a remote: /git remote create origin\n` +
            `  - Check status: /git status`,
            ctx.mode
          )
        } catch (err) {
          ctx.messages.addAgentMessage(
            `Failed to initialize Git: ${err instanceof Error ? err.message : String(err)}`,
            ctx.mode
          )
        }
        return
      }

      if (!fs.existsSync(gitDir)) {
        ctx.messages.addAgentMessage(
          `'${agentName}' is not a Git repository.\n\nInitialize it with:\n  /git init`,
          ctx.mode
        )
        return
      }

      if (subcommand === 'status') {
        try {
          const git = simpleGit(agentPath)
          const status = await git.status()

          const lines: string[] = []
          lines.push(`Git Status for '${agentName}'`)
          lines.push('')

          if (status.current) {
            lines.push(`Branch: ${status.current}`)
          }

          const workingTreeChanges = status.modified.length + status.not_added.length + status.deleted.length
          const stagedChanges = status.staged.length

          if (stagedChanges > 0) {
            lines.push(`Staged (${stagedChanges}): ready to commit`)
            status.staged.forEach(f => lines.push(`  A ${f}`))
          }

          if (workingTreeChanges > 0) {
            lines.push('')
            lines.push(`Changes (${workingTreeChanges}):`)
            if (status.modified.length > 0) {
              status.modified.forEach(f => lines.push(`  M ${f}`))
            }
            if (status.not_added.length > 0) {
              status.not_added.forEach(f => lines.push(`  ?? ${f}`))
            }
            if (status.deleted.length > 0) {
              status.deleted.forEach(f => lines.push(`  D ${f}`))
            }
          }

          if (stagedChanges === 0 && workingTreeChanges === 0) {
            lines.push('Status: Working tree is clean')
          }

          if (status.ahead > 0) {
            lines.push(`Ahead: ${status.ahead} commit(s)`)
          }
          if (status.behind > 0) {
            lines.push(`Behind: ${status.behind} commit(s)`)
          }

          const remotes = await git.getRemotes(true)
          if (remotes.length > 0) {
            lines.push(`Remotes: ${remotes.map(r => r.name).join(', ')}`)
          } else {
            lines.push('No remotes configured.')
          }

          ctx.messages.addAgentMessage(lines.join('\n'), ctx.mode)
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to get git status: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      if (subcommand === 'commit') {
        let message = args.slice(1).join(' ')

        try {
          const git = simpleGit(agentPath)
          const status = await git.status()

          if (!message) {
            const staged = status.staged
            const modified = status.modified
            const deleted = status.deleted

            if (staged.length === 0 && modified.length === 0 && deleted.length === 0) {
              ctx.messages.addAgentMessage('Nothing to commit.', ctx.mode)
              return
            }

            const files = [...staged, ...modified, ...deleted]

            const categorize = (files: string[]) => {
              const categories: Record<string, string[]> = {
                'config': [],
                'instructions': [],
                'tools': [],
                'tests': [],
                'docs': [],
                'mcp': [],
                'other': []
              }

              files.forEach(f => {
                if (f.includes('agent.yaml') || f.includes('.castignore') || f.includes('.gitignore')) {
                  categories['config'].push(f)
                } else if (f.includes('instructions') || f.includes('system')) {
                  categories['instructions'].push(f)
                } else if (f.includes('tools/')) {
                  categories['tools'].push(f)
                } else if (f.includes('tests/') || f.includes('.test.')) {
                  categories['tests'].push(f)
                } else if (f.includes('README') || f.includes('.md')) {
                  categories['docs'].push(f)
                } else if (f.includes('mcp/')) {
                  categories['mcp'].push(f)
                } else {
                  categories['other'].push(f)
                }
              })

              return Object.entries(categories)
                .filter(([, files]) => files.length > 0)
                .map(([cat, files]) => `${cat}: ${files.length} file(s)`)
            }

            const summary = categorize(files)
            const timestamp = new Date().toISOString().split('T')[0]

            if (summary.length > 0) {
              message = `Update ${timestamp}\n\nChanges:\n${summary.map(s => `  - ${s}`).join('\n')}`
            } else {
              message = `Update ${timestamp}`
            }
          }

          await git.add('.')
          const result = await git.commit(message)
          ctx.messages.addAgentMessage(`Committed successfully!\n\nCommit: ${result.commit.substring(0, 7)}\n\n${message}`, ctx.mode)
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to commit: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      if (subcommand === 'push') {
        try {
          const git = simpleGit(agentPath)
          await git.push()
          ctx.messages.addAgentMessage('Pushed to remote successfully!', ctx.mode)
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to push: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      if (subcommand === 'log') {
        try {
          const git = simpleGit(agentPath)
          const log = await git.log({maxCount: 5})

          if (log.all.length === 0) {
            ctx.messages.addAgentMessage('No commits yet.', ctx.mode)
            return
          }

          const lines: string[] = []
          lines.push(`Recent commits for '${agentName}'`)
          lines.push('')

          for (const commit of log.all) {
            lines.push(`commit ${commit.hash.substring(0, 7)}`)
            lines.push(`Author: ${commit.author_name}`)
            lines.push(`Date: ${new Date(commit.date).toLocaleString()}`)
            lines.push('')
            lines.push(`    ${commit.message}`)
            lines.push('')
          }

          ctx.messages.addAgentMessage(lines.join('\n'), ctx.mode)
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to get git log: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      if (subcommand === 'add') {
        const files = args.slice(1)
        if (files.length === 0) {
          ctx.messages.addAgentMessage('Usage: /git add <file>...\n\nStage files for commit.\n  /git add .      - Stage all\n  /git add -A     - Stage all including deleted', ctx.mode)
          return
        }

        try {
          const git = simpleGit(agentPath)
          if (files[0] === '.' || files[0] === '-A' || files[0] === '--all') {
            await git.add('--all')
            ctx.messages.addAgentMessage('All files staged (including deletions).', ctx.mode)
          } else {
            await git.add(files)
            ctx.messages.addAgentMessage(`Staged: ${files.join(', ')}`, ctx.mode)
          }
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to stage files: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      if (subcommand === 'diff') {
        try {
          const git = simpleGit(agentPath)
          const diff = await git.diff()

          if (!diff) {
            ctx.messages.addAgentMessage('No changes to show.', ctx.mode)
            return
          }

          ctx.messages.addAgentMessage(`Changes in '${agentName}'\n\n\`\`\`diff\n${diff}\n\`\`\``, ctx.mode)
        } catch (err) {
          ctx.messages.addAgentMessage(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, ctx.mode)
        }
        return
      }

      ctx.messages.addAgentMessage(
        `Git subcommand '${subcommand}' not recognized.\n\nUsage:\n` +
        `  /git init                    - Initialize Git repository\n` +
        `  /git                         - Show status\n` +
        `  /git status                  - Show working tree status\n` +
        `  /git add <file>              - Stage specific file(s)\n` +
        `  /git add .                   - Stage all files\n` +
        `  /git add -A                  - Stage all (including deleted)\n` +
        `  /git commit <msg>            - Commit staged changes\n` +
        `  /git push                    - Push to remote\n` +
        `  /git log                     - Show recent commits\n` +
        `  /git diff                    - Show changes\n\n` +
        `Or use CLI: cast git <command> ${agentName}`,
        ctx.mode
      )
    },
  },

  {
    name: 'release',
    description: 'Create a semantic release for the current agent',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[version]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const presetVersion = args[0] || ''

      // Load existing releases to compute the current version + suggestions
      const releases = await getReleasesForAgent(agentName)
      const currentVersion = getCurrentReleaseVersion(agentName)
      const suggestions = suggestNextVersions(currentVersion)

      // Run a release through createRelease(). Falls back to shelling out
      // to `cast release` if the TS wrapper isn't available for any reason.
      const doCreateRelease = async (version: string, message: string): Promise<{ok: boolean; error?: string}> => {
        try {
          // Dynamic import — the releases module lives in cast-cli.
          // Using a relative path keeps the build portable.
          const releasesMod = await import('../../../cast-cli/dist/lib/releases.js').catch(() => null)
          if (releasesMod && typeof (releasesMod as any).createRelease === 'function') {
            await (releasesMod as any).createRelease(agentName, version, message)
            return {ok: true}
          }
        } catch (err: any) {
          // Fall through to CLI fallback below
        }

        // Fallback: shell out to `cast release`
        const binary = findCastBinary()
        if (!binary) {
          return {ok: false, error: 'Could not find cast CLI binary. Please ensure cast is installed.'}
        }
        try {
          const cliArgs = ['release', agentName, version]
          if (message) cliArgs.push('--message', message)
          execFileSync(binary, cliArgs, {stdio: 'inherit'})
          return {ok: true}
        } catch (err: any) {
          if (err.signal === 'SIGINT') return {ok: false, error: 'Cancelled'}
          return {ok: false, error: err.message || String(err)}
        }
      }

      // Render the modal. State lives in closures; `renderModal` rebuilds
      // the content on every change.
      type FocusField = 'version' | 'message' | 'create' | 'cancel'
      const state = {
        version: presetVersion || suggestions.patch,
        message: '',
        focus: (presetVersion ? 'message' : 'version') as FocusField,
        error: '' as string,
        creating: false,
      }

      const modal = createModal(ctx.renderer, ctx.input, {
        title: `Create Release: ${agentName}`,
        overlay: true,
      })
      if (modal.overlay) ctx.renderer.root.add(modal.overlay)

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 1,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      function refresh(): void {
        for (const child of contentBox.getChildren()) {
          contentBox.remove(child.id)
        }

        const header = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            white('Agent: '),
            cyan(agentName),
            dim('   '),
            white('Current: '),
            yellow(currentVersion || 'none'),
          ]),
        })
        contentBox.add(header)

        const suggested = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            dim('Suggested: '),
            green(`patch ${suggestions.patch}`),
            dim(' / '),
            green(`minor ${suggestions.minor}`),
            dim(' / '),
            green(`major ${suggestions.major}`),
          ]),
        })
        contentBox.add(suggested)

        // Version input
        const versionLabel = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            state.focus === 'version' ? cyan('▸ Version: ') : dim('  Version: '),
            white(state.version || '_'),
          ]),
        })
        contentBox.add(versionLabel)

        // Message input
        const messageLabel = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            state.focus === 'message' ? cyan('▸ Message: ') : dim('  Message: '),
            white(state.message || '_'),
          ]),
        })
        contentBox.add(messageLabel)

        if (state.error) {
          const errLine = new TextRenderable(ctx.renderer, {
            content: new StyledText([red(state.error)]),
          })
          contentBox.add(errLine)
        }

        const spacer = new TextRenderable(ctx.renderer, {content: new StyledText([dim(' ')])})
        contentBox.add(spacer)

        // Buttons
        const createStyle = state.focus === 'create' ? cyan : (state.creating ? dim : white)
        const cancelStyle = state.focus === 'cancel' ? cyan : dim
        const buttons = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            createStyle('[ Create Release ]'),
            dim('  '),
            cancelStyle('[ Cancel ]'),
          ]),
        })
        contentBox.add(buttons)

        const footer = new TextRenderable(ctx.renderer, {
          content: new StyledText([
            dim('Tab Switch Field  Enter Confirm  ESC Cancel'),
          ]),
        })
        const footerBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          alignItems: 'center',
        })
        footerBox.add(footer)
        contentBox.add(footerBox)

        ctx.renderer.requestRender?.()
      }

      const closeModal = (): void => {
        modal.hide()
        ctx.input.focus()
      }

      const submit = async (): Promise<void> => {
        if (state.creating) return
        const v = state.version.trim()
        if (!v) {
          state.error = 'Version is required'
          refresh()
          return
        }
        if (!/^\d+(\.\d+){0,2}$/.test(v)) {
          state.error = `Invalid semver: "${v}"`
          refresh()
          return
        }
        state.creating = true
        state.error = ''
        refresh()

        const result = await doCreateRelease(v, state.message.trim())
        if (!result.ok) {
          state.creating = false
          state.error = result.error || 'Failed to create release'
          refresh()
          return
        }

        // Success — close the form modal and show a confirmation
        closeModal()
        showInfoModal(
          ctx,
          'Release Created',
          [
            {label: 'Agent', value: agentName},
            {label: 'Version', value: v, color: green},
          ],
          'Enter/ESC Close',
          true,
        )
      }

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
      refresh()

      const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

      modal.box.handleKeyPress = (key: KeyEvent): boolean => {
        if (state.creating) {
          return true
        }
        if (key.name === 'escape') {
          closeModal()
          return true
        }
        if (key.name === 'tab') {
          const order: FocusField[] = ['version', 'message', 'create', 'cancel']
          const idx = order.indexOf(state.focus)
          state.focus = order[(idx + 1) % order.length]
          refresh()
          return true
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (state.focus === 'create') {
            void submit()
            return true
          }
          if (state.focus === 'cancel') {
            closeModal()
            return true
          }
          // Pressing Enter in a text field advances to the next field
          const order: FocusField[] = ['version', 'message', 'create', 'cancel']
          const idx = order.indexOf(state.focus)
          state.focus = order[(idx + 1) % order.length]
          refresh()
          return true
        }
        if (key.name === 'up') {
          const order: FocusField[] = ['version', 'message', 'create', 'cancel']
          const idx = order.indexOf(state.focus)
          state.focus = order[(idx - 1 + order.length) % order.length]
          refresh()
          return true
        }
        if (key.name === 'down') {
          const order: FocusField[] = ['version', 'message', 'create', 'cancel']
          const idx = order.indexOf(state.focus)
          state.focus = order[(idx + 1) % order.length]
          refresh()
          return true
        }
        if (key.name === 'left' || key.name === 'right') {
          state.focus = state.focus === 'create' ? 'cancel' : 'create'
          refresh()
          return true
        }
        if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
          if (state.focus === 'version' && state.version.length > 0) {
            state.version = state.version.slice(0, -1)
            refresh()
          } else if (state.focus === 'message' && state.message.length > 0) {
            state.message = state.message.slice(0, -1)
            refresh()
          }
          return true
        }
        // Printable characters
        if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) {
          if (state.focus === 'version' && state.version.length < 32) {
            state.version += key.name
            refresh()
            return true
          }
          if (state.focus === 'message' && state.message.length < 200) {
            state.message += key.name
            refresh()
            return true
          }
        }
        return originalHandleKeyPress ? originalHandleKeyPress(key) : false
      }
    },
  },

  {
    name: 'restore',
    description: 'Restore agent to a previous change or release',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[--change <num>|--release <version>]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName

      // Parse args for --change or --release
      let targetChange: number | null = null
      let targetRelease: string | null = null

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--change' && args[i + 1]) {
          targetChange = parseInt(args[i + 1], 10)
          if (!Number.isFinite(targetChange)) targetChange = null
        }
        if (args[i] === '--release' && args[i + 1]) {
          targetRelease = args[i + 1]
        }
      }

      // Run a restore by shelling out to the cast CLI.
      const doRestore = (kind: 'change' | 'release', value: string | number): void => {
        const binary = findCastBinary()
        if (!binary) {
          showInfoModal(
            ctx,
            'Restore Failed',
            [{value: 'Could not find cast CLI binary. Please ensure cast is installed.', color: red}],
            'Enter/ESC Close',
            false,
          )
          return
        }
        const cliArgs = ['restore', agentName, kind === 'change' ? '--change' : '--release', String(value)]
        try {
          execFileSync(binary, cliArgs, {stdio: 'inherit'})
          showInfoModal(
            ctx,
            'Restore Complete',
            [
              {label: 'Agent', value: agentName},
              {label: 'Restored from', value: kind === 'change' ? `v${value}` : `release ${value}`, color: green},
              {value: 'Local files updated. Use /deploy to update the deployment.', color: dim},
            ],
            'Enter/ESC Close',
            true,
          )
        } catch (err: any) {
          if (err.signal === 'SIGINT') return
          showInfoModal(
            ctx,
            'Restore Failed',
            [{value: err.message || String(err), color: red}],
            'Enter/ESC Close',
            false,
          )
        }
      }

      // If args provided, skip the picker and go straight to confirmation
      if (targetChange !== null) {
        showRestoreConfirmation(ctx, agentName, 'change', targetChange, doRestore)
        return
      }
      if (targetRelease !== null) {
        showRestoreConfirmation(ctx, agentName, 'release', targetRelease, doRestore)
        return
      }

      // No args: open the modal flow
      const changes = getChangesForAgent(agentName)
      const releases = await getReleasesForAgent(agentName)

      if (changes.length === 0 && releases.length === 0) {
        showInfoModal(
          ctx,
          'Nothing to Restore',
          [
            {value: 'No changes or releases found for this agent.', color: yellow},
            {value: 'Make a change or create a release first.', color: dim},
          ],
          'Enter/ESC Close',
          false,
        )
        return
      }

      showRestorePicker(ctx, agentName, changes, releases, doRestore)
    },
  },

  {
    name: 'diff',
    description: 'Compare two changes or releases',
    category: 'agent',
    modes: ['dev', 'production'],
    args: '[--change <num> --change <num>|--release <ver> --release <ver>]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const changes = getChangesForAgent(agentName)
      const releases = await getReleasesForAgent(agentName)

      // Parse --change/--release pairs
      const changeFlags: number[] = []
      const releaseFlags: string[] = []
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--change' && args[i + 1]) {
          const n = parseInt(args[i + 1], 10)
          if (Number.isFinite(n)) changeFlags.push(n)
        }
        if (args[i] === '--release' && args[i + 1]) {
          releaseFlags.push(args[i + 1])
        }
      }

      if (changeFlags.length === 2) {
        showDiffModal(ctx, agentName, 'change', String(changeFlags[0]), String(changeFlags[1]))
        return
      }
      if (releaseFlags.length === 2) {
        showDiffModal(ctx, agentName, 'release', releaseFlags[0], releaseFlags[1])
        return
      }

      // No (or partial) args: open the picker
      if (changes.length === 0 && releases.length === 0) {
        showInfoModal(
          ctx,
          'Nothing to Diff',
          [
            {value: 'No changes or releases found for this agent.', color: yellow},
          ],
          'Enter/ESC Close',
          false,
        )
        return
      }
      // If the first change is preselected (from a D press in /changes), pass it
      const preselected = changeFlags.length === 1 ? changeFlags[0] : null
      showDiffPicker(ctx, agentName, preselected, changes, releases)
    },
  },

  {
    name: 'registry',
    description: 'List all releases across all agents',
    category: 'session',
    modes: ['dev', 'production'],
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        showInfoModal(
          ctx,
          'Registry',
          [{value: 'Unable to access agent database.', color: red}],
          'Enter/ESC Close',
          false,
        )
        return
      }

      const allReleases = db.listAllReleases() as Array<{
        agent_name: string
        version: string
        created_at: string
        provider?: string | null
        deployment_sha?: string | null
        deployment_url?: string | null
      }>

      const modal = createModal(ctx.renderer, ctx.input, {
        title: 'Registry',
        overlay: true,
      })
      if (modal.overlay) ctx.renderer.root.add(modal.overlay)

      const contentBox = new BoxRenderable(ctx.renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      if (allReleases.length === 0) {
        const empty = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('No releases found.')]),
        })
        contentBox.add(empty)
        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('Create a release with: cast release <agent> <version>')]),
        })
        contentBox.add(hint)
      } else {
        const tableData: (TextChunk[] | null)[][] = []
        tableData.push([
          [white('Agent')],
          [white('Version')],
          [white('Date')],
          [white('Deployed')],
        ])
        for (const release of allReleases) {
          const date = new Date(release.created_at)
          const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
          let deployedCell: TextChunk[]
          if (release.deployment_sha) {
            deployedCell = [green(`✓ ${release.provider || 'deployed'}`), dim(` (${release.deployment_sha.slice(0, 7)})`)]
          } else {
            deployedCell = [dim('-')]
          }
          tableData.push([
            [white(release.agent_name || '-')],
            [cyan(release.version || '-')],
            [dim(dateStr)],
            deployedCell,
          ])
        }
        const table = new TextTableRenderable(ctx.renderer, {
          content: tableData,
          columnWidthMode: 'content',
          showBorders: false,
          columnGap: 2,
          cellPadding: 0,
        })
        contentBox.add(table)
        const total = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim(`\nTotal: ${allReleases.length} release(s)`)]),
        })
        contentBox.add(total)
      }

      const sep = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('───────────────────────────────────────────────────────────────')]),
      })
      contentBox.add(sep)
      const footer = new TextRenderable(ctx.renderer, {
        content: new StyledText([dim('ESC Close')]),
      })
      const footerBox = new BoxRenderable(ctx.renderer, {width: '100%', alignItems: 'center'})
      footerBox.add(footer)
      contentBox.add(footerBox)

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()

      const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
      modal.box.handleKeyPress = (key: KeyEvent): boolean => {
        if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
          modal.hide()
          ctx.input.focus()
          return true
        }
        return originalHandleKeyPress ? originalHandleKeyPress(key) : false
      }
    },
  },
]

export function getSlashCommands(mode: UiMode): SlashCommand[] {
  return commands.filter((cmd) => {
    if (!cmd.modes) return true // no restriction = available in all modes
    return cmd.modes.includes(mode)
  })
}

export async function executeSlashCommand(name: string, args: string[], ctx: CommandContext): Promise<boolean> {
  const availableCommands = getSlashCommands(ctx.uiMode ?? 'dev')
  const cmd = availableCommands.find((c) => c.name === name)
  if (!cmd) {
    return false
  }

  try {
    await cmd.handler(ctx, args)
  } catch (err) {
    ctx.messages.addAgentMessage(
      `Command error: ${err instanceof Error ? err.message : String(err)}`,
      ctx.mode,
    )
  }

  return true
}

export function getCommandSuggestions(prefix: string, mode: UiMode = 'dev'): SlashCommand[] {
  const lowerPrefix = prefix.toLowerCase()
  return getSlashCommands(mode).filter((c) => c.name.startsWith(lowerPrefix))
}

// Re-export the full commands list for consumers that need the unfiltered set
export { commands as allCommands }
