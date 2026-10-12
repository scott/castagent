import {BoxRenderable, TextRenderable, ScrollBoxRenderable, StyledText, white, dim, green, yellow, red, cyan} from '@opentui/core'
import type {RenderContext, KeyEvent, Renderable} from '@opentui/core'
import {createModal} from './modal.js'
import {DEPLOYMENT_PROVIDERS, providerIndexForNumberKey} from '../lib/deployment-providers.js'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import clipboardy from 'clipboardy'
import yaml from 'yaml'

// better-sqlite3 is loaded lazily because it has a native binding that
// may not be available in every environment (e.g. the on-host TUI
// running inside a Docker container without the better-sqlite3 binary).
// The functions below return null when the module cannot be loaded,
// which is the right behavior — the on-host TUI doesn't need the
// developer's local SQLite database.
function loadDatabase(): any | null {
  try {
    return require('better-sqlite3')
  } catch {
    return null
  }
}

// Get agent description from agent.yaml
function getAgentDescription(agentName: string): string {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName, 'agent.yaml')
  try {
    if (fs.existsSync(agentPath)) {
      const content = fs.readFileSync(agentPath, 'utf8')
      const config = yaml.parse(content)
      if (config && config.description) {
        // Truncate to 50 chars with "..."
        const desc = config.description as string
        return desc.length > 50 ? desc.slice(0, 47) + '...' : desc
      }
    }
  } catch {
    // Ignore errors, return empty string
  }
  return ''
}

// Get deployed version from SQLite database
function getDeployedVersion(agentName: string): string | null {
  try {
    const Database = loadDatabase()
    if (!Database) return null
    const dbPath = path.join(os.homedir(), '.cast', 'cast.db')
    if (!fs.existsSync(dbPath)) {
      return null
    }
    const db = new Database(dbPath, {readonly: true})
    const stmt = db.prepare('SELECT deployed_version FROM deployments WHERE agent_name = ?')
    const row = stmt.get(agentName) as any
    db.close()
    return row?.deployed_version ?? null
  } catch {
    return null
  }
}

// Get deployment info from SQLite database
function getDeploymentInfo(agentName: string): {deployment_url: string, provider: string} | null {
  try {
    const Database = loadDatabase()
    if (!Database) return null
    const dbPath = path.join(os.homedir(), '.cast', 'cast.db')
    if (!fs.existsSync(dbPath)) {
      return null
    }
    const db = new Database(dbPath, {readonly: true})
    const stmt = db.prepare('SELECT deployment_url, provider FROM deployments WHERE agent_name = ?')
    const row = stmt.get(agentName) as any
    db.close()
    return row ?? null
  } catch {
    return null
  }
}

// List available agents from ~/.cast/agents/
function listAgents(): string[] {
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

// Find the cast CLI binary
function findCastBinary(): string | null {
  try {
    const {execSync} = require('child_process')
    // Add timeout to prevent hanging on 'which' command
    const castPath = execSync('which cast', {encoding: 'utf8', timeout: 5000}).trim()
    if (castPath && fs.existsSync(castPath)) {
      return castPath
    }
  } catch {
    // try next
  }

  // Fallback: check common installation paths
  const commonPaths = [
    '/usr/local/bin/cast',
    '/usr/bin/cast',
    path.join(os.homedir(), '.local', 'bin', 'cast'),
  ]

  for (const candidate of commonPaths) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // Try relative paths from various depths
  const candidates = [
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

// Provider selection modal
async function showProviderSelection(
  renderer: any,
  modal: any,
  contentBox: BoxRenderable,
  outputScroll: ScrollBoxRenderable,
  agentName: string,
  provider: string,
  messagesComponent: any,
  previouslyFocused: Renderable,
) {
  const providers = DEPLOYMENT_PROVIDERS

  // Track selected index for keyboard navigation
  let selectedIndex = 0

  // Render function to update the list
  function renderList() {
    // Clear existing children
    for (const child of outputScroll.getChildren()) {
      outputScroll.remove(child.id)
    }

    // Header
    const headerText = new TextRenderable(renderer, {
      content: new StyledText([white('Select a deployment provider:')]),
    })
    outputScroll.add(headerText)

    const sepText = new TextRenderable(renderer, {
      content: new StyledText([dim('────────────────────────────────')]),
    })
    outputScroll.add(sepText)

    // Provider list with selection indicator
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i]
      const isSelected = i === selectedIndex
      const prefix = isSelected ? cyan('▸ ') : cyan(`${i + 1}. `)
      const nameColor = isSelected ? cyan : white

      const lineText = new TextRenderable(renderer, {
        content: new StyledText([prefix, nameColor(p.name), dim(` - ${p.desc}`)]),
      })
      outputScroll.add(lineText)
    }

    // Help
    const helpText = new TextRenderable(renderer, {
      content: new StyledText([dim(`\n↑↓ Navigate  1-${providers.length} Select  ESC Cancel`)]),
    })
    outputScroll.add(helpText)
  }

  renderList()

  // Use modal.box.handleKeyPress like slash-registry does
  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  modal.box.handleKeyPress = (key: KeyEvent) => {
    // Handle up arrow
    if (key.name === 'up') {
      selectedIndex = (selectedIndex - 1 + providers.length) % providers.length
      renderList()
      return true
    }
    // Handle down arrow
    if (key.name === 'down') {
      selectedIndex = (selectedIndex + 1) % providers.length
      renderList()
      return true
    }
    const index = providerIndexForNumberKey(key.name, providers.length)
    if (index !== null) {
      selectedIndex = index
      const selectedProvider = providers[selectedIndex].key
      modal.hide()
      handleDeployModal(renderer, previouslyFocused, agentName, selectedProvider, messagesComponent)
      return true
    }
    // Handle Enter key
    if (key.name === 'return' || key.name === 'enter') {
      const selectedProvider = providers[selectedIndex].key
      modal.hide()
      handleDeployModal(renderer, previouslyFocused, agentName, selectedProvider, messagesComponent)
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

// Agent selection modal
async function showAgentSelection(
  renderer: any,
  modal: any,
  contentBox: BoxRenderable,
  outputScroll: ScrollBoxRenderable,
  agentName: string,
  provider: string,
  messagesComponent: any,
  previouslyFocused: Renderable,
) {
  const validAgents = listAgents()

  // Track selected index for keyboard navigation
  let selectedIndex = 0

  // Render function to update the list
  function renderList() {
    // Clear existing children
    for (const child of outputScroll.getChildren()) {
      outputScroll.remove(child.id)
    }

    // Header
    const headerText = new TextRenderable(renderer, {
      content: new StyledText([white('Available agents:')]),
    })
    outputScroll.add(headerText)

    const sepText = new TextRenderable(renderer, {
      content: new StyledText([dim('─────────────────────────────────────────')]),
    })
    outputScroll.add(sepText)

    // Column header
    const colHeaderText = new TextRenderable(renderer, {
      content: new StyledText([dim('  Agent Name        Version   Status')]),
    })
    outputScroll.add(colHeaderText)

    const colSepText = new TextRenderable(renderer, {
      content: new StyledText([dim('  ─────────────────────────────────────────')]),
    })
    outputScroll.add(colSepText)

    // Agent list with selection indicator
    for (let i = 0; i < validAgents.length; i++) {
      const name = validAgents[i]
      const isSelected = i === selectedIndex
      const prefix = isSelected ? cyan('▸ ') : white('  ')
      const nameColor = isSelected ? cyan : white

      // Get deployed version
      const deployedVersion = getDeployedVersion(name)
      const versionStr = deployedVersion !== null ? green(`v${deployedVersion}`) : dim('-')

      // Determine status
      const deployment = getDeploymentInfo(name)
      const statusStr = deployment?.deployment_url
        ? green('deployed')
        : dim('not deployed')

      // Pad columns for alignment
      const paddedName = name.padEnd(15)
      const lineText = new TextRenderable(renderer, {
        content: new StyledText([prefix, nameColor(paddedName), dim('  '), versionStr, dim('  '), statusStr]),
      })
      outputScroll.add(lineText)
    }

    // Help
    const helpText = new TextRenderable(renderer, {
      content: new StyledText([dim('\n↑↓ Navigate  Enter Select  ESC Cancel')]),
    })
    outputScroll.add(helpText)
  }

  renderList()

  // Use modal.box.handleKeyPress like slash-registry does
  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  modal.box.handleKeyPress = (key: KeyEvent) => {
    // Handle up arrow
    if (key.name === 'up') {
      selectedIndex = (selectedIndex - 1 + validAgents.length) % validAgents.length
      renderList()
      return true
    }
    // Handle down arrow
    if (key.name === 'down') {
      selectedIndex = (selectedIndex + 1) % validAgents.length
      renderList()
      return true
    }
    // Handle Enter to select
    if (key.name === 'return' || key.name === 'enter') {
      const selectedAgent = validAgents[selectedIndex]
      modal.hide()
      handleDeployModal(renderer, previouslyFocused, selectedAgent, provider, messagesComponent)
      return true
    }
    if (key.name === 'escape') {
      modal.hide()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}

export async function handleDeployModal(
  renderer: any,
  previouslyFocused: Renderable,
  agentName: string,
  provider: string,
  messagesComponent: any,
): Promise<void> {
  // Closing the modal returns focus to the chat input, not the renderer root.
  const prevFocused = previouslyFocused

  // If no provider specified, show provider selection
  if (!provider) {
    const modal = createModal(renderer, prevFocused, {
      title: 'Select Deployment Provider',
      overlay: true,
    })

    // Add overlay to renderer if present
    if (modal.overlay) {
      renderer.root.add(modal.overlay)
    }

    const contentBox = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })

    const outputScroll = new ScrollBoxRenderable(renderer, {
      width: '100%',
      flexGrow: 1,
      scrollY: true,
      contentOptions: {
        flexDirection: 'column',
        gap: 0,
        padding: 1,
      },
    })

    // Add content BEFORE setting it on the modal (like slash-registry does)
    await showProviderSelection(renderer, modal, contentBox, outputScroll, agentName, provider, messagesComponent, previouslyFocused)

    contentBox.add(outputScroll)
    modal.setContent(contentBox)
    renderer.root.add(modal.box)
    modal.show()
    return
  }

  // Check if agent name is valid
  const validAgents = listAgents()
  if (!agentName || !validAgents.includes(agentName)) {
    const modal = createModal(renderer, prevFocused, {
      title: 'Select Agent to Deploy',
      overlay: true,
    })

    // Add overlay to renderer if present
    if (modal.overlay) {
      renderer.root.add(modal.overlay)
    }

    const contentBox = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })

    const outputScroll = new ScrollBoxRenderable(renderer, {
      width: '100%',
      flexGrow: 1,
      scrollY: true,
      contentOptions: {
        flexDirection: 'column',
        gap: 0,
        padding: 1,
      },
    })

    // Add content BEFORE setting it on the modal (like slash-registry does)
    await showAgentSelection(renderer, modal, contentBox, outputScroll, agentName, provider, messagesComponent, previouslyFocused)

    contentBox.add(outputScroll)
    modal.setContent(contentBox)
    renderer.root.add(modal.box)
    modal.show()
    return
  }

  // Find cast binary
  const castBinary = findCastBinary()
  if (!castBinary) {
    messagesComponent.addAgentMessage(
      {text: 'Could not find cast CLI binary. Please ensure cast is installed.', type: 'error'},
      'build',
    )
    return
  }

  // Build the deploy command - use --force to avoid interactive prompts
  // since TUI cannot handle stdin for child processes
  const args = ['deploy', agentName, '--provider', provider, '--force']

  // Create the modal (centered in terminal)
  const modal = createModal(renderer, prevFocused, {
    title: `Deploying ${agentName}...`,
    width: '90%',
    height: '90%',
    overlay: true,
  })

  // Add overlay to renderer if present
  if (modal.overlay) {
    renderer.root.add(modal.overlay)
  }

  const contentBox = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
  })

  const outputScroll = new ScrollBoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: 'bottom',
    contentOptions: {
      flexDirection: 'column',
      gap: 0,
      padding: 1,
    },
  })

  // Store all output lines for copy functionality
  const outputLines: string[] = []

  // Status bar
  const statusBar = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    height: 3,
  })

  const statusText = new TextRenderable(renderer, {
    content: new StyledText([dim('Running...'), yellow('  Press ESC to close')]),
  })
  statusBar.add(statusText)

  contentBox.add(outputScroll)
  contentBox.add(statusBar)

  modal.setContent(contentBox)
  renderer.root.add(modal.box)
  modal.show()

  // Helper functions - render is automatic in OpenTUI
  function addOutput(line: string): void {
    // Store line for copy functionality
    outputLines.push(line)
    if (!modal.isVisible()) return
    try {
      const lineText = new TextRenderable(renderer, {
        content: new StyledText([white(line)]),
        wrapMode: 'word',
      })
      outputScroll.add(lineText)
    } catch (e: any) {
      console.error('addOutput error:', e.message)
    }
  }

  function updateStatus(text: string, color: typeof green | typeof yellow | typeof red): void {
    if (!modal.isVisible()) return
    try {
      statusText.content = new StyledText([color(text), dim('  Press ESC to close')])
    } catch (e: any) {
      console.error('updateStatus error:', e.message)
    }
  }

  // Track deployment stage based on output
  let currentStage = 'initializing'
  let totalElapsedSeconds = 0 // Store total time for display at end
  const stageKeywords: Record<string, string[]> = {
    'Building Docker image': ['building', 'docker build', 'step '],
    'Stopping container': ['stopping', 'docker stop'],
    'Starting container': ['starting', 'docker run', 'starting container'],
    'Deployment successful': ['deployment successful', 'deploy completed'],
  }

  function detectStage(line: string): string | null {
    const lowerLine = line.toLowerCase()
    for (const [stage, keywords] of Object.entries(stageKeywords)) {
      for (const kw of keywords) {
        if (lowerLine.includes(kw.toLowerCase())) {
          return stage
        }
      }
    }
    return null
  }

  // Start elapsed time counter
  const startTime = Date.now()
  let elapsedInterval: NodeJS.Timeout | null = null

  function startElapsedTimer(): void {
    elapsedInterval = setInterval(() => {
      if (!modal.isVisible()) {
        if (elapsedInterval) clearInterval(elapsedInterval)
        return
      }
      const elapsed = Math.floor((Date.now() - startTime) / 1000)
      totalElapsedSeconds = elapsed // Keep track of total time
      const mins = Math.floor(elapsed / 60)
      const secs = elapsed % 60
      const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`
      const stageDisplay = currentStage !== 'initializing' ? ` | ${currentStage}` : ''
      try {
        statusText.content = new StyledText([yellow(`Running${stageDisplay} (${timeStr})`), dim('  Press ESC to close')])
      } catch (e: any) {
        // ignore
      }
    }, 1000)
  }

  // Run deploy
  try {
    const {spawn} = require('child_process')

    addOutput(`$ ${castBinary} ${args.join(' ')}`)
    addOutput('')

    addOutput('Executing command...')

    // Start elapsed time counter
    startElapsedTimer()

    // Use spawn instead of execSync for better control and to avoid shell quoting issues
    await new Promise<void>((resolve) => {
      const child = spawn(castBinary, args, {
        cwd: os.homedir(),
        env: {...process.env},
      })

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.trim()) {
            addOutput(line)
            // Detect stage from output
            const detectedStage = detectStage(line)
            if (detectedStage) {
              currentStage = detectedStage
            }
          }
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.trim()) {
            addOutput(line)
            // Detect stage from output
            const detectedStage = detectStage(line)
            if (detectedStage) {
              currentStage = detectedStage
            }
          }
        }
      })

      child.on('error', (err: any) => {
        addOutput(`Error: ${err.message}`)
        updateStatus('Deploy failed', red)
        if (elapsedInterval) clearInterval(elapsedInterval)
        resolve()
      })

      child.on('close', (code: number | null) => {
        if (elapsedInterval) clearInterval(elapsedInterval)
        const mins = Math.floor(totalElapsedSeconds / 60)
        const secs = totalElapsedSeconds % 60
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`
        if (code === 0) {
          updateStatus(`Deploy completed! (${timeStr})`, green)
        } else {
          updateStatus(`Deploy failed (exit code: ${code})`, red)
        }
        resolve()
      })
    })
  } catch (err: any) {
    if (elapsedInterval) clearInterval(elapsedInterval)
    addOutput(`Error: ${err.message}`)
    updateStatus('Deploy failed', red)
  }

  // Refocus the modal so keyboard events work (it may have lost focus during async operation)
  modal.box.focus()

  // Get the original handleKeyPress to chain to (modal.ts has default ESC handling)
  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)

  // ESC to close, Ctrl+Shift+C to copy output
  modal.box.handleKeyPress = (key: KeyEvent) => {
    if (key.name === 'escape') {
      modal.hide()
      prevFocused.focus()
      return true
    }
    // Ctrl+Shift+C to copy all output to clipboard
    if (key.ctrl && key.shift && key.name === 'c') {
      try {
        const output = outputLines.join('\n')
        clipboardy.write(output)
        updateStatus('Output copied to clipboard!', green)
      } catch (e: any) {
        updateStatus('Failed to copy output', red)
      }
      return true
    }
    // Chain to original handler for other keys
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }

  // Force focus and render to ensure the modal is properly capturing keyboard events
  modal.box.focus()
  renderer.requestRender?.()
}

export async function runDeployInTerminal(
  renderer: any,
  previouslyFocused: Renderable,
  agentName: string,
  provider: string,
  messagesComponent: any,
): Promise<void> {
  return handleDeployModal(renderer, previouslyFocused, agentName, provider, messagesComponent)
}