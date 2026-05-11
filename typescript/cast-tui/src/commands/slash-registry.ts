import clipboardy from 'clipboardy'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import yaml from 'yaml'
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
  category: 'chat' | 'agent' | 'session'
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
              const deployment = db.getDeployment(name)
              const localAgent = db.getLocalAgent(name)

              if (deployment?.deployment_url) {
                statusText = `deployed (${deployment.provider})`
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
        const deployment = db.getDeployment(ctx.agentName)

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

        if (deployment) {
          lines.push('Deployment:')
          lines.push(`  Provider: ${deployment.provider}`)
          lines.push(`  URL: ${deployment.deployment_url}`)
          lines.push(`  Deployed: ${deployment.deployed_at}`)
          if (deployment.last_connected_at) {
            lines.push(`  Last connected: ${deployment.last_connected_at}`)
          }
          lines.push('')
        } else {
          lines.push('Deployment: none')
          lines.push('')
        }

        lines.push('Current connection:')
        lines.push(`  URL: ${ctx.agentUrl}`)
        lines.push(`  Mode: ${ctx.mode}`)

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
                handleConnect(targetName)
                return true
              }
            }
            // Handle Enter to connect
            if (key.name === 'return' || key.name === 'enter') {
              const targetName = agents[selectedIndex]
              modal.hide()
              handleConnect(targetName)
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
      await handleConnect(targetName)
      return

      // Helper function to connect to an agent
      async function handleConnect(targetName: string) {
        // When given an explicit name, verify it exists on disk or in DB
        try {
          const diskAgents = listAgentsFromDisk()
          const existsOnDisk = diskAgents.includes(targetName)

          let url: string | undefined

          if (db) {
            const deployment = db.getDeployment(targetName)
            if (deployment?.deployment_url) {
              url = deployment.deployment_url as string
            } else {
              const localAgent = db.getLocalAgent(targetName)
              if (localAgent?.port) {
                url = `http://localhost:${localAgent.port}`
              }
            }
          }

          if (!url && !existsOnDisk) {
            ctx.messages.addAgentMessage(
              `Agent '${targetName}' not found.\n` +
                `Create it with: cast new\n` +
                `Or start locally: cast dev ${targetName} --no-tui`,
              ctx.mode,
            )
            return
          }

          if (!url) {
            ctx.messages.addAgentMessage(
              `Agent '${targetName}' exists but is not currently running or deployed.\n` +
                `Start it with: cast dev ${targetName} --no-tui`,
              ctx.mode,
            )
            return
          }

          const token = keychain ? await keychain.getToken(targetName) : undefined

          ctx.messages.addAgentMessage(`Connecting to ${targetName} at ${url}...`, ctx.mode)
          await ctx.reinitializeChat(targetName, url, token || undefined)
        } catch (err) {
          ctx.messages.addAgentMessage(
            `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
            ctx.mode,
          )
        }
      }
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
    name: 'versions',
    description: 'Show version history for current agent',
    category: 'session',
    args: '[version]',
    handler: async (ctx, args) => {
      const agentName = ctx.agentName
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      const versionsJsonPath = path.join(agentPath, '.cast', 'versions', 'versions.json')

      // Build modal content
      const modal = createModal(ctx.renderer, ctx.input, {
        title: `Versions: ${agentName}`,
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

      if (!fs.existsSync(versionsJsonPath)) {
        const emptyText = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('No versions found.')]),
        })
        contentBox.add(emptyText)

        const hint = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('\nVersions are created when the agent is edited.')]),
        })
        contentBox.add(hint)

        // Footer for no versions case
        const footer = new TextRenderable(ctx.renderer, {
          content: new StyledText([dim('ESC Close')]),
        })
        const footerBox = new BoxRenderable(ctx.renderer, {
          width: '100%',
          alignItems: 'center',
        })
        footerBox.add(footer)
        contentBox.add(footerBox)
      } else {
        try {
          const versionsData = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'))
          const versions = versionsData.versions

          // Track selected index for keyboard navigation
          let selectedIndex = versions.length > 0 ? versions.length - 1 : 0

          // Render function to update the list
          function renderList() {
            // Clear existing children
            for (const child of contentBox.getChildren()) {
              contentBox.remove(child.id)
            }

            // Header
            const headerText = new TextRenderable(ctx.renderer, {
              content: new StyledText([
                white('Version History'),
                dim(' | '),
                white(`Current: v${versionsData.current}`),
              ]),
            })
            contentBox.add(headerText)

            const sep = new TextRenderable(ctx.renderer, {
              content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
            })
            contentBox.add(sep)

            // Show each version with selection
            for (let i = 0; i < versions.length; i++) {
              const v = versions[i]
              const isSelected = i === selectedIndex
              const date = new Date(v.timestamp)
              const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
              const sourceLabel = v.source === 'create' ? dim('[CREATED]') :
                                 v.source === 'cli' ? cyan('[CLI]') :
                                 green('[BUILDER]')

              const prefix = isSelected ? cyan('▸ ') : dim('  ')
              const versionColor = isSelected ? white : dim

              const versionText = new TextRenderable(ctx.renderer, {
                content: new StyledText([
                  prefix,
                  versionColor(`v${v.id}`),
                  dim('  '),
                  sourceLabel,
                  dim('  '),
                  dim(dateStr),
                  dim('\n    '),
                  versionColor(v.message),
                ]),
              })
              contentBox.add(versionText)
            }

            const sep2 = new TextRenderable(ctx.renderer, {
              content: new StyledText([dim('\n───────────────────────────────────────────────────────────────')]),
            })
            contentBox.add(sep2)

            // Footer instructions
            const footer = new TextRenderable(ctx.renderer, {
              content: new StyledText([dim('↑↓ Navigate  Enter Revert  ESC Close')]),
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
              selectedIndex = Math.max(0, selectedIndex - 1)
              renderList()
              ctx.renderer.render()
              return true
            }
            // Handle down arrow
            if (key.name === 'down') {
              selectedIndex = Math.min(versions.length - 1, selectedIndex + 1)
              renderList()
              ctx.renderer.render()
              return true
            }
            // Handle Enter to revert
            if (key.name === 'return' || key.name === 'enter') {
              const targetVersion = versions[selectedIndex]
              if (targetVersion) {
                modal.hide()
                ctx.input.focus()

                // Show confirmation message
                ctx.messages.addAgentMessage(
                  `Revert to v${targetVersion.id}? Use \`cast revert ${agentName} ${targetVersion.id}\` from CLI to confirm.`,
                  ctx.mode
                )
              }
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
        } catch (err) {
          const errorText = new TextRenderable(ctx.renderer, {
            content: new StyledText([red('Failed to load version history.')]),
          })
          contentBox.add(errorText)
        }
      }

      modal.setContent(contentBox)
      ctx.renderer.root.add(modal.box)
      modal.show()
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
