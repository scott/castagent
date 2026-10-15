import {Args, Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {spawn} from 'child_process'
import {BuilderA2ABridge} from '../lib/builder/bridge'

export default class Edit extends Command {
  static description = 'Edit an existing agent through an interactive TUI wizard'

  static examples = [
    '<%= config.bin %> <%= command.id %> <agent-name>',
  ]

  static flags = {}

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private validateAgentName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)
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
    const {args} = await this.parse(Edit)
    const agentName = args.agent as string

    if (!this.validateAgentName(agentName)) {
      this.error('Agent name must contain only letters, numbers, and hyphens.')
    }

    const agentConfigPath = path.join(os.homedir(), '.cast', 'agents', agentName, 'agent.yaml')
    if (!fs.existsSync(agentConfigPath)) {
      this.error(`Agent '${agentName}' does not exist. Create it first with: cast new`)
    }

    this.log(`Starting Cast Agent Editor for '${agentName}'...`)
    this.log('')

    this.checkVenv()

    const pythonExecutable = this.getPythonExecutable()
    const pythonPath = this.getPythonPath()

    const bridge = new BuilderA2ABridge(
      pythonExecutable,
      ['-m', 'cast.builder'],
      {
        ...process.env,
        PYTHONPATH: pythonPath,
      } as Record<string, string>,
      agentName,
      false,
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
      await this.runTerminalMode(bridge)
      return
    }

    const welcomeMessage = bridge.getWelcomeMessage()
    const tuiArgs = [
      tuiPath,
      '--agent', agentName,
      '--url', `http://127.0.0.1:${bridge.port}`,
      '--mode', 'dev',
    ]
    if (welcomeMessage) {
      tuiArgs.push('--welcome', welcomeMessage)
    }

    process.stdin.pause()

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
      process.exit(0)
    })

    process.on('SIGINT', () => {
      this.log('\nShutting down builder...')
      bridge.stop()
      process.stdin.resume()
      process.exit(0)
    })

    await new Promise(() => {})
  }

  private async runTerminalMode(bridge: BuilderA2ABridge): Promise<void> {
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
}
