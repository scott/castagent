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
import {createModal} from '../components/modal.js'
import {runDeployInTerminal} from '../components/terminal.js'

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
  handler: (ctx: CommandContext, args: string[]) => Promise<void>
}

export interface CommandContext {
  agentName: string
  agentUrl: string
  authToken?: string
  mode: 'plan' | 'build'
  renderer: any
  client: any
  messages: any
  input: any
  setMode: (mode: 'plan' | 'build') => void
  reinitializeChat: (agentName: string, url: string, token?: string) => Promise<void>
  exitTui: () => void
  messageHistory: Array<{role: 'user' | 'agent'; text: string}>
  lastAgentMessage?: string
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

function launchBuilderEditor(ctx: CommandContext, agentName: string): void {
  // Destroy renderer to release terminal
  if (ctx.renderer && !ctx.renderer.isDestroyed) {
    ctx.renderer.destroy()
  }

  // Try to find the cast CLI binary
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  let binary: string | null = null
  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        // Check if cast is in PATH
        execFileSync('which', ['cast'], { stdio: 'ignore' })
        binary = candidate
        break
      } else if (fs.existsSync(candidate)) {
        binary = candidate
        break
      }
    } catch {
      // try next
    }
  }

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

function launchConnect(ctx: CommandContext, agentName: string): void {
  // Destroy renderer to release terminal
  if (ctx.renderer && !ctx.renderer.isDestroyed) {
    ctx.renderer.destroy()
  }

  // Try to find the cast CLI binary
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  let binary: string | null = null
  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        // Check if cast is in PATH
        execFileSync('which', ['cast'], { stdio: 'ignore' })
        binary = candidate
        break
      } else if (fs.existsSync(candidate)) {
        binary = candidate
        break
      }
    } catch {
      // try next
    }
  }

  if (!binary) {
    console.error('Could not find cast CLI binary. Please ensure cast is installed.')
    process.exit(1)
  }

  try {
    execFileSync(binary, ['connect', agentName], { stdio: 'inherit' })
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
    ctx.renderer.render()
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
  ctx.renderer.render()
}

function launchRenameWithName(ctx: CommandContext, currentName: string, newName: string): void {
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  let binary: string | null = null
  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        execFileSync('which', ['cast'], { stdio: 'ignore' })
        binary = candidate
        break
      } else if (fs.existsSync(candidate)) {
        binary = candidate
        break
      }
    } catch {
      // try next
    }
  }

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
      ctx.renderer.render()
      return true
    }
    if (key.name === 'down') {
      selectedIndex = Math.min(sortedVersions.length - 1, selectedIndex + 1)
      renderVersionList()
      ctx.renderer.render()
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
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  let binary: string | null = null
  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        execFileSync('which', ['cast'], { stdio: 'ignore' })
        binary = candidate
        break
      } else if (fs.existsSync(candidate)) {
        binary = candidate
        break
      }
    } catch {
      // try next
    }
  }

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

const commands: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show all available slash commands',
    category: 'chat',
    handler: async (ctx) => {
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
    handler: async (ctx) => {
      ctx.messages.addAgentMessage(`Current mode: ${ctx.mode.toUpperCase()}`, ctx.mode)
    },
  },

  {
    name: 'save',
    description: 'Save conversation transcript to file',
    category: 'session',
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
    args: '[agent-name]',
    handler: async (ctx, args) => {
      const db = await getDb()
      const keychain = await getKeychain()

      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      if (args.length === 0) {
        // Show available agents in a modal with keyboard navigation
        const agents = listAgentsFromDisk()

        const modal = createModal(ctx.renderer, ctx.input, {
          title: 'Connect to Agent',
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
          paddingTop: 3,
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
          // Track selected index for keyboard navigation
          let selectedIndex = 0

          // Helper to get agent status info
          function getAgentStatus(name: string): {text: string; color: typeof green} {
            let statusText = 'stopped'
            let statusColor = red

            if (db) {
              try {
                const deployment = db.getDeployment(name)
                const localAgent = db.getLocalAgent(name)

                if (deployment?.deployment_url) {
                  statusText = 'deployed'
                  statusColor = green
                } else if (localAgent?.port) {
                  statusText = 'local'
                  statusColor = cyan
                }
              } catch {
                // Database lookup failed — show as stopped
              }
            }
            return {text: statusText, color: statusColor}
          }

          // Render function to update the list
          function renderList() {
            // Clear existing children
            for (const child of contentBox.getChildren()) {
              contentBox.remove(child.id)
            }

            const tableData: (TextChunk[] | null)[][] = []

            // Header row with selection column
            tableData.push([
              [white('')],
              [white('Agent Name')],
              [white('Description')],
              [white('Status')],
            ])

            // Data rows with selection column
            for (let i = 0; i < agents.length; i++) {
              const isSelected = i === selectedIndex
              const description = getAgentDescription(agents[i])
              const {text: statusText, color: statusColor} = getAgentStatus(agents[i])
              const nameColor = isSelected ? cyan : white

              // Selection column
              const selectionColumn = isSelected ? [cyan('▸ ')] : [dim('  ')]

              tableData.push([
                selectionColumn,
                [nameColor(agents[i])],
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

            // Footer with instructions
            const footer = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                white('↑↓  '),
                dim('Navigate  '),
                white('Enter  '),
                dim('Connect  '),
                white('ESC  '),
                dim('Close'),
              ]),
            })
            const footerBox = new BoxRenderable(ctx.renderer, {
              width: '100%',
              alignItems: 'center',
            })
            footerBox.add(footer)
            contentBox.add(footerBox)
          }

          renderList()

          // Override modal's key handler for custom keyboard navigation
          const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

          modal.box.handleKeyPress = (key: KeyEvent) => {
            // Handle up arrow
            if (key.name === 'up') {
              selectedIndex = (selectedIndex - 1 + agents.length) % agents.length
              renderList()
              ctx.renderer.render()
              return true
            }
            // Handle down arrow
            if (key.name === 'down') {
              selectedIndex = (selectedIndex + 1) % agents.length
              renderList()
              ctx.renderer.render()
              return true
            }
            // Handle number keys 1-9 for quick selection
            if (key.name && key.name.length === 1 && key.name >= '1' && key.name <= '9') {
              const num = parseInt(key.name, 10)
              if (num <= agents.length) {
                selectedIndex = num - 1
                // Connect immediately on number press
                const targetName = agents[selectedIndex]
                modal.hide()
                launchConnect(ctx, targetName)
                return true
              }
            }
            // Handle Enter to connect
            if (key.name === 'return' || key.name === 'enter') {
              const targetName = agents[selectedIndex]
              modal.hide()
              launchConnect(ctx, targetName)
              return true
            }
            // Handle Escape to close
            if (key.name === 'escape') {
              modal.hide()
              ctx.input.focus()
              return true
            }
            return originalHandleKeyPress ? originalHandleKeyPress(key) : false
          }

          modal.setContent(contentBox)
          ctx.renderer.root.add(modal.box)
          modal.show()
          return
        }

        // No agents case - just show basic modal
        const escFooter = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('\nPress ESC to close')]),
        })
        contentBox.add(escFooter)

        modal.setContent(contentBox)
        ctx.renderer.root.add(modal.box)
        modal.show()
        return
      }

      // Handle explicit agent name
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
          ctx.renderer.render()
          return true
        }
        if (key.name === 'down') {
          selectedIndex = (selectedIndex + 1) % agents.length
          renderList()
          ctx.renderer.render()
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
            ctx.renderer.render()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = (selectedIndex + 1) % agents.length
            renderList()
            ctx.renderer.render()
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
    handler: async (ctx) => {
      ctx.messages.addAgentMessage(`Use \`cast update ${ctx.agentName}\` from the CLI for now.`, ctx.mode)
    },
  },

  {
    name: 'upgrade',
    description: 'Upgrade a deployed agent to a new version',
    category: 'agent',
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      // Get all agents from disk
      const allAgents = listAgentsFromDisk()

      // Filter to only agents with deployments
      const deployedAgents: Array<{name: string; provider: string; version: number | null; sha: string}> = []
      for (const name of allAgents) {
        try {
          const deployments = db.listDeployments(name)
          if (deployments.length > 0) {
            const deployment = deployments[0] // most recent
            deployedAgents.push({
              name,
              provider: deployment.provider,
              version: deployment.deployed_version,
              sha: deployment.id,
            })
          }
        } catch {
          // Skip agents we can't get deployment info for
        }
      }

      if (deployedAgents.length === 0) {
        ctx.messages.addAgentMessage(
          'No deployed agents found.\n\nDeploy an agent first with: cast deploy <agent-name>',
          ctx.mode
        )
        return
      }

      // Create agent selection modal
      const modal = createModal(ctx.renderer, ctx.input, {
        title: 'Select agent to upgrade',
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
        paddingTop: 2,
        paddingLeft: 2,
        paddingRight: 2,
      })

      function renderAgentList() {
        for (const child of contentBox.getChildren()) {
          contentBox.remove(child.id)
        }

        const tableData: (TextChunk[] | null)[][] = []

        // Header row
        tableData.push([
          [white('')],
          [white('Agent Name')],
          [white('Provider')],
        ])

        // Data rows
        for (let i = 0; i < deployedAgents.length; i++) {
          const agent = deployedAgents[i]
          const isSelected = i === selectedIndex
          const nameColor = isSelected ? cyan : white
          const selectionColumn = isSelected ? [cyan('▸ ')] : [dim('  ')]

          const versionLabel = agent.version ? `(${agent.version})` : ''
          const shaLabel = dim(`[sha:${agent.sha}]`)
          tableData.push([
            selectionColumn,
            [nameColor(agent.name), dim(` ${versionLabel}`), dim(` ${shaLabel}`)],
            [dim(`[${agent.provider}]`)],
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

        const footer = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('↑↓ Navigate  Enter Select  ESC Cancel')]),
        })
        const footerBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          alignItems: 'center',
        })
        footerBox.add(footer)
        contentBox.add(footerBox)
      }

      renderAgentList()
      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()

      const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

      modal.box.handleKeyPress = (key: KeyEvent) => {
        if (key.name === 'up') {
          selectedIndex = (selectedIndex - 1 + deployedAgents.length) % deployedAgents.length
          renderAgentList()
          ctx.renderer.render()
          return true
        }
        if (key.name === 'down') {
          selectedIndex = (selectedIndex + 1) % deployedAgents.length
          renderAgentList()
          ctx.renderer.render()
          return true
        }
        if (key.name === 'return' || key.name === 'enter') {
          modal.hide()
          showVersionSelection(ctx, deployedAgents[selectedIndex])
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
    name: 'deploy',
    description: 'Deploy the current agent',
    category: 'agent',
    args: '[provider]',
    handler: async (ctx, args) => {
      const provider = args[0] || ''
      await runDeployInTerminal(ctx.renderer, ctx.input, ctx.agentName, provider, ctx.messages)
    },
  },

  {
    name: 'changes',
    description: 'Show change history for current agent',
    category: 'session',
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

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('↑↓ Navigate  ESC Close')]),
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
            ctx.renderer.render()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = Math.min(changes.length - 1, selectedIndex + 1)
            renderList()
            ctx.renderer.render()
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

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
    },
  },

  {
    name: 'versions',
    description: 'Show releases for current agent',
    category: 'session',
    handler: async (ctx) => {
      const agentName = ctx.agentName
      const releases = await getReleasesForAgent(agentName)

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

          const footer = new TextRenderable(ctx.renderer, {
            content: new StyledText([dim('↑↓ Navigate  ESC Close')]),
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
            ctx.renderer.render()
            return true
          }
          if (key.name === 'down') {
            selectedIndex = Math.min(releases.length - 1, selectedIndex + 1)
            renderList()
            ctx.renderer.render()
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

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
    },
  },

  {
    name: 'git',
    description: 'Git operations for the current agent',
    category: 'git',
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
    args: '[version]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const version = args[0]

      if (version) {
        // Version provided, show confirmation and create
        ctx.messages.addAgentMessage(
          `Create release ${version} for '${agentName}'?\n\nUse: \`cast release ${agentName} ${version}\``,
          ctx.mode
        )
      } else {
        // No version, show current info and prompt
        ctx.messages.addAgentMessage(
          `Create a semantic release for '${agentName}'?\n\n` +
          `Usage: /release <version>\n` +
          `Example: /release 1.0, /release 1.6, /release 2.0.0\n\n` +
          `Use \`cast release ${agentName} <version>\` to create a release.`,
          ctx.mode
        )
      }
    },
  },

  {
    name: 'restore',
    description: 'Restore agent to a previous change or release',
    category: 'agent',
    args: '[--change <num>|--release <version>]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const changes = getChangesForAgent(agentName)
      const releases = await getReleasesForAgent(agentName)

      // Parse args for --change or --release
      let targetChange: number | null = null
      let targetRelease: string | null = null

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--change' && args[i + 1]) {
          targetChange = parseInt(args[i + 1], 10)
        }
        if (args[i] === '--release' && args[i + 1]) {
          targetRelease = args[i + 1]
        }
      }

      if (targetChange || targetRelease) {
        const target = targetChange ? `v${targetChange}` : targetRelease
        ctx.messages.addAgentMessage(
          `Restore '${agentName}' to ${target}?\n\n` +
          `Use: \`cast restore ${agentName} ${targetChange ? `--change ${targetChange}` : `--release ${targetRelease}`}\``,
          ctx.mode
        )
      } else {
        ctx.messages.addAgentMessage(
          `Restore '${agentName}' to a previous state?\n\n` +
          `Usage:\n` +
          `  /restore --change <num>   - Restore to a specific change (v1, v2, etc.)\n` +
          `  /restore --release <ver> - Restore to a specific release (1.0, 1.6, etc.)\n\n` +
          `Example: /restore --change 5`,
          ctx.mode
        )
      }
    },
  },

  {
    name: 'registry',
    description: 'List all releases across all agents',
    category: 'session',
    handler: async (ctx) => {
      const db = await getDb()
      if (!db) {
        ctx.messages.addAgentMessage('Unable to access agent database.', ctx.mode)
        return
      }

      const allReleases = db.listAllReleases()

      if (allReleases.length === 0) {
        ctx.messages.addAgentMessage('No releases found.\n\nCreate a release with: cast release <agent> <version>', ctx.mode)
        return
      }

      const lines: string[] = []
      lines.push('Local Agent Registry')
      lines.push('──────────────────────────────────────────────────────────────────────────────')

      for (const release of allReleases) {
        const date = new Date(release.created_at)
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
        let status = ''
        if (release.provider && release.deployment_sha) {
          status = ` [DEPLOYED on ${release.provider.toUpperCase()}, sha:${release.deployment_sha}]`
        } else if (release.provider) {
          status = ` [DEPLOYED on ${release.provider.toUpperCase()}]`
        }
        lines.push(`  ${release.agent_name}    ${release.version}   ${dateStr}${status}`)
      }

      lines.push('──────────────────────────────────────────────────────────────────────────────')
      lines.push(`\nTotal: ${allReleases.length} release(s)`)

      ctx.messages.addAgentMessage(lines.join('\n'), ctx.mode)
    },
  },
]

export const slashCommands: SlashCommand[] = commands

export async function executeSlashCommand(name: string, args: string[], ctx: CommandContext): Promise<boolean> {
  const cmd = slashCommands.find((c) => c.name === name)
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

export function getCommandSuggestions(prefix: string): SlashCommand[] {
  const lowerPrefix = prefix.toLowerCase()
  return slashCommands.filter((c) => c.name.startsWith(lowerPrefix))
}
