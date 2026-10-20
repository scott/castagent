import {Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {spawn, spawnSync} from 'child_process'
import {BuilderA2ABridge} from '../lib/builder/bridge'

export default class New extends Command {
  static description = 'Create a new agent. On a TTY, opens the Builder wizard. Without a TTY, reads a description from stdin and creates the agent.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    'echo "Summarises incoming email and drafts replies." | <%= config.bin %> <%= command.id %>',
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
      this.warn('From the repository checkout, run ./setup.sh to create python/.venv.')
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
    // A pipe has no TTY. Read the description and create the agent
    // without opening the TUI. A terminal still uses the wizard below.
    if (!process.stdin.isTTY) {
      await this.createFromStdin()
      return
    }

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

  private async createFromStdin(): Promise<void> {
    const description = await this.readPipedDescription()
    this.checkVenv()
    const created = this.createAgentFromDescription(description)
    this.log(`Created agent '${created.name}' at ${created.path}`)
    this.log(`Run 'cast dev ${created.name}' to start it.`)
  }

  private async readPipedDescription(): Promise<string> {
    // `run` already touched `process.stdin` to see if it is a TTY. After
    // that, `readFileSync(0)` throws EAGAIN once the description is larger
    // than the pipe buffer. The stdin stream waits for the rest.
    const chunks: Buffer[] = []
    try {
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.error(`Failed to read stdin: ${message}`)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) {
      this.error('No description on stdin. Pipe a description, for example: echo "Summarises incoming email and drafts replies." | cast new')
    }
    return raw
  }

  private createAgentFromDescription(description: string): {name: string; path: string} {
    const pythonExecutable = this.getPythonExecutable()
    const pythonPath = this.getPythonPath()
    const result = spawnSync(pythonExecutable, ['-m', 'cast.create_from_stdin'], {
      input: description,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
      },
    })

    // A builder that exits before reading the description (an import
    // error, a config error) closes stdin while this write is still in
    // flight. spawnSync then sets EPIPE, and also keeps the builder's
    // status and stderr. The pipe error is not the failure to report.
    const errno = result.error as NodeJS.ErrnoException | undefined
    if (errno && errno.code !== 'EPIPE') {
      this.error(`Failed to create agent: ${errno.message}`)
    }
    if (result.status !== 0) {
      const detail = `${result.stderr || result.stdout || 'Failed to create agent'}`.trim()
      this.error(detail || 'Failed to create agent')
    }
    if (!result.stdout) {
      this.error('Failed to create agent: builder returned no output')
    }

    let parsed: {name?: string; path?: string} | null = null
    try {
      parsed = JSON.parse(result.stdout) as {name?: string; path?: string}
    } catch {
      this.error(`Failed to create agent: ${result.stdout.trim() || 'builder returned invalid JSON'}`)
    }
    if (!parsed?.name || !parsed.path) {
      this.error('Failed to create agent: builder returned an incomplete result')
    }
    return {name: parsed.name, path: parsed.path}
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

      const latestAgent = agents[agents.length - 1]
      const agentPath = path.join(agentsDir, latestAgent)
      const gitDir = path.join(agentPath, '.git')

      if (!fs.existsSync(gitDir)) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log(`  Git Integration Available`)
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log(`Initialize Git for '${latestAgent}'?`)
        this.log('')
        this.log(`  cast git init ${latestAgent}`)
        this.log('')
        this.log(`This will create a README and initial commit.`)
        this.log('')
      }
    }
  }
}
