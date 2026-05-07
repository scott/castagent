import {Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {spawn} from 'child_process'
import {BuilderA2ABridge} from '../lib/builder/bridge'

export default class New extends Command {
  static description = 'Create a new agent through an interactive TUI wizard'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  static flags = {}

  static args = {}

  private validateAgentName(name: string): boolean {
    return /^[a-zA-Z0-9-]+$/.test(name)
  }

  private getPythonExecutable(): string {
    let projectRoot = process.cwd()
    if (!fs.existsSync(path.join(projectRoot, 'python'))) {
      projectRoot = path.resolve(__dirname, '../../../..')
      if (!fs.existsSync(path.join(projectRoot, 'python'))) {
        projectRoot = path.resolve(__dirname, '../../../../..')
      }
    }
    const pythonPath = path.join(projectRoot, 'python')
    const venvPython = path.join(pythonPath, '.venv/bin/python3')
    return fs.existsSync(venvPython) ? venvPython : 'python3'
  }

  private getPythonPath(): string {
    let projectRoot = process.cwd()
    if (!fs.existsSync(path.join(projectRoot, 'python'))) {
      projectRoot = path.resolve(__dirname, '../../../..')
      if (!fs.existsSync(path.join(projectRoot, 'python'))) {
        projectRoot = path.resolve(__dirname, '../../../../..')
      }
    }
    return path.join(projectRoot, 'python')
  }

  private checkVenv(): void {
    const pythonPath = this.getPythonPath()
    const venvPython = path.join(pythonPath, '.venv/bin/python3')
    if (!fs.existsSync(venvPython)) {
      this.warn('Python virtual environment not found at python/.venv/')
      this.warn('Falling back to system python3. Some features may not work correctly.')
      this.warn('Run: python -m venv python/.venv && pip install -r python/requirements.txt')
    }
  }

  private resolveBun(): string {
    const candidates = [
      path.join(os.homedir(), '.bun', 'bin', 'bun'),
      '/usr/local/bin/bun',
      '/opt/homebrew/bin/bun',
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    return 'bun'
  }

  async run(): Promise<void> {
    this.log('Starting Cast Agent Creator...')
    this.log('')

    // Check venv
    this.checkVenv()

    const pythonExecutable = this.getPythonExecutable()
    const pythonPath = this.getPythonPath()

    // Start the A2A-to-Builder bridge
    const bridge = new BuilderA2ABridge(
      pythonExecutable,
      ['-m', 'cast.builder'],
      {
        ...process.env,
        PYTHONPATH: pythonPath,
        CAST_NEW_MODE: '1',
      } as Record<string, string>,
      '__new__',
      true,
    )

    let bridgeReady = false

    bridge.on('ready', () => {
      bridgeReady = true
    })

    bridge.on('error', (err: Error) => {
      this.error(`Builder error: ${err.message}`)
    })

    bridge.on('exit', (code: number | null) => {
      if (!bridgeReady) {
        this.error(`Builder exited with code ${code}`)
      }
    })

    try {
      await bridge.start()
    } catch (err: any) {
      this.error(`Failed to start builder bridge: ${err.message}`)
      return
    }

    this.log(`Builder ready on port ${bridge.port}`)
    this.log('Launching OpenTUI...')
    this.log('')

    const bunPath = this.resolveBun()
    const tuiPath = path.join(__dirname, '../../../cast-tui/dist/index.js')

    if (!fs.existsSync(tuiPath)) {
      this.warn(`OpenTUI not found at ${tuiPath}`)
      this.log('Falling back to terminal mode...')
      // Fall back to simple terminal mode if TUI is not built
      await this.runTerminalMode(bridge)
      return
    }

    const welcomeMessage = bridge.getWelcomeMessage()
    const tuiArgs = [
      tuiPath,
      '--agent', 'Cast Builder',
      '--url', `http://127.0.0.1:${bridge.port}`,
      '--mode', 'dev',
    ]
    if (welcomeMessage) {
      tuiArgs.push('--welcome', welcomeMessage)
    }

    // Pause parent's stdin so TUI gets exclusive keyboard access
    process.stdin.pause()

    // Spawn TUI with inherited stdio
    const opentui = spawn(bunPath, tuiArgs, {
      stdio: 'inherit',
      detached: false,
    })

    opentui.on('error', (err) => {
      this.warn(`Failed to launch OpenTUI: ${err.message}`)
      this.log(`Builder is still running. Press Ctrl+C to stop.`)
    })

    opentui.on('exit', (code) => {
      this.log(`OpenTUI exited with code ${code}`)
      process.stdin.resume()
      bridge.stop()

      // Check if any agent was created during the session
      this.checkForNewAgent()
      process.exit(0)
    })

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      this.log('\nShutting down builder...')
      bridge.stop()
      process.stdin.resume()
      process.exit(0)
    })

    // Keep the CLI alive
    await new Promise(() => {})
  }

  private async runTerminalMode(bridge: BuilderA2ABridge): Promise<void> {
    // Simple fallback using readline when TUI is not available
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const promptUser = (question: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim())
        })
      })
    }

    this.log('Terminal mode - type your messages below.')
    this.log('Type "exit" or "quit" to finish.')
    this.log('')

    while (true) {
      const input = await promptUser('You: ')
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        this.log('Exiting builder...')
        break
      }

      try {
        // Use the bridge's internal method via a hack - actually we need to send via HTTP
        // In terminal mode, we'll use a simple HTTP request
        const axios = await import('axios')
        const response = await axios.default.post(`http://127.0.0.1:${bridge.port}`, {
          jsonrpc: '2.0',
          id: '1',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{kind: 'text', text: input}],
              messageId: 'msg_1',
            },
            metadata: {},
          },
        })

        const parts = response.data?.result?.parts || []
        const text = parts.map((p: any) => p.text || '').join('')
        this.log('\nBuilder: ' + text + '\n')
      } catch (err: any) {
        this.warn(`Error: ${err.message}`)
      }
    }

    rl.close()
    bridge.stop()
  }

  private checkForNewAgent(): void {
    const agentsDir = path.join(os.homedir(), '.cast', 'agents')
    if (!fs.existsSync(agentsDir)) {
      return
    }

    const agents: string[] = []
    for (const item of fs.readdirSync(agentsDir)) {
      const agentPath = path.join(agentsDir, item)
      if (fs.statSync(agentPath).isDirectory() && fs.existsSync(path.join(agentPath, 'agent.yaml'))) {
        agents.push(item)
      }
    }

    if (agents.length > 0) {
      this.log('\nYour agents:')
      for (const agent of agents) {
        this.log(`  - ${agent}`)
      }
      this.log(`\nRun 'cast dev <agent-name>' to start an agent in development mode.`)
    }
  }
}
