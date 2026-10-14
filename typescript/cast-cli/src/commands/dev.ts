import {Args, Command, Flags} from '@oclif/core'
import {ChildProcess, spawn} from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as net from 'net'
import * as readline from 'readline'
import {db} from '../lib/sqlite'

export default class Dev extends Command {
  static description = 'Start agent in development mode'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
  ]

  static flags = {
    port: Flags.integer({description: 'Port for A2A server', default: 0}),
    'no-tui': Flags.boolean({description: 'Run without TUI (headless mode)'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private validateAgentName(name: string): boolean {
    return /^[a-zA-Z0-9-]+$/.test(name)
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true)
        } else {
          resolve(false)
        }
      })
      server.once('listening', () => {
        server.close()
        resolve(false)
      })
      server.listen(port)
    })
  }

  private getPythonExecutable(): string {
    // Find project root by looking for python directory
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

  private async promptWithRl(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer.trim())
      })
    })
  }

  private async runBuilderConversation(
    builder: ChildProcess,
    agentName: string,
    agentPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let hasResolved = false
      let initialized = false
      let pendingResponse = false
      let userRlClosed = false

      const builderRl = readline.createInterface({
        input: builder.stdout!,
        crlfDelay: Infinity,
      })

      const userRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      userRl.on('close', () => {
        userRlClosed = true
      })

      const cleanup = () => {
        if (!hasResolved) {
          hasResolved = true
          userRlClosed = true
          builderRl.close()
          userRl.close()
        }
      }

      const sendOutput = (content: string) => {
        if (builder.stdin && !builder.killed) {
          builder.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'output',
            params: {content},
          }) + '\n')
          pendingResponse = true
        }
      }

      const askUser = async () => {
        if (hasResolved || pendingResponse || userRlClosed) return
        const input = await this.promptWithRl(userRl, '\nYou: ')
        if (hasResolved || userRlClosed) return

        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
          this.log('\nExiting builder. Starting agent in dev mode...')
          cleanup()
          resolve()
          return
        }

        sendOutput(input)
      }

      builderRl.on('line', async (line) => {
        if (hasResolved) return

        try {
          const msg = JSON.parse(line)

          if (msg.error) {
            this.warn(`Builder error: ${msg.error.message}`)
            pendingResponse = false
            await askUser()
            return
          }

          if (msg.result) {
            pendingResponse = false

            if (!initialized) {
              initialized = true
              if (msg.result.message) {
                this.log('\n' + msg.result.message)
              }

              if (fs.existsSync(agentPath)) {
                this.log('\nAgent already exists. Starting in dev mode...')
                cleanup()
                resolve()
                return
              }

              await askUser()
            } else {
              if (msg.result.response) {
                this.log('\nBuilder: ' + msg.result.response)
              }

              if (fs.existsSync(agentPath)) {
                this.log('\n─────────────────────────────────────────')
                if (userRlClosed) return
                const startNow = await this.promptWithRl(userRl, 'Agent created. Start in dev mode now? (Y/n): ')
                if (hasResolved || userRlClosed) return
                if (startNow.toLowerCase() !== 'n') {
                  cleanup()
                  resolve()
                  return
                }
              }

              await askUser()
            }
          }
        } catch {
          // Not JSON, just log it
          if (line.trim()) {
            this.log(line)
          }
          pendingResponse = false
          await askUser()
        }
      })

      builder.on('error', (err) => {
        if (hasResolved) return
        cleanup()
        reject(new Error(`Builder Agent error: ${err.message}`))
      })

      builder.on('exit', (code) => {
        if (hasResolved) return
        cleanup()
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Builder Agent exited with code ${code}`))
        }
      })

      // Send initialize. This conversation only runs when the agent
      // directory is missing, so the builder must start the new-agent flow.
      setTimeout(() => {
        if (builder.stdin && !builder.killed) {
          builder.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: this.missingAgentInitializeParams(agentName),
          }) + '\n')
        }
      }, 500)

      // Timeout after 5 minutes
      setTimeout(() => {
        if (hasResolved) return
        cleanup()
        builder.kill()
        reject(new Error('Builder Agent timed out after 5 minutes'))
      }, 300000)
    })
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Dev)
    const agentName = args.agent

    // Validate agent name
    if (!this.validateAgentName(agentName)) {
      this.error(
        `Invalid agent name '${agentName}'. Agent names must be alphanumeric with hyphens only.\n` +
        `Examples: email-agent, slack-bot, data-pipeline-v2`
      )
    }

    this.log(`Starting ${agentName} in development mode...`)

    // Check if port is already in use
    if (flags.port > 0 && await this.isPortInUse(flags.port)) {
      this.error(`Port ${flags.port} is already in use. Choose a different port with --port.`)
    }

    // Check venv
    this.checkVenv()

    // Check if agent exists
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    const pythonExecutable = this.getPythonExecutable()
    const pythonPath = this.getPythonPath()

    if (!fs.existsSync(agentPath)) {
      this.log(`Agent '${agentName}' not found. Starting the new-agent flow...`)

      // Spawn Builder Agent in new mode so it creates this name
      // instead of claiming an existing configuration was loaded.
      const builder = spawn(pythonExecutable, [
        '-m', 'cast.builder',
      ], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: this.builderLaunchEnv(agentName, agentPath, pythonPath),
      })

      try {
        await this.runBuilderConversation(builder, agentName, agentPath)
        this.log('Agent created successfully. Restarting in dev mode...')
        await this.runRuntimeAgent(agentName, agentPath, flags)
      } catch (err: any) {
        this.error(err.message)
      }

    } else {
      // Agent exists, run runtime directly
      await this.runRuntimeAgent(agentName, agentPath, flags)
    }
  }

  builderLaunchEnv(agentName: string, agentPath: string, pythonPath: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CAST_AGENT_NAME: agentName,
      CAST_AGENT_PATH: agentPath,
      CAST_NEW_MODE: '1',
      PYTHONPATH: pythonPath,
    }
  }

  missingAgentInitializeParams(agentName: string): {agent_name: string; new_mode: boolean} {
    return {agent_name: agentName, new_mode: true}
  }

  private async runRuntimeAgent(agentName: string, agentPath: string, flags: any): Promise<void> {
    const port = flags.port || 0

    const pythonExecutable = this.getPythonExecutable()
    const pythonPath = this.getPythonPath()

    // Spawn Python runtime agent
    const runtime = spawn(pythonExecutable, [
      '-m', 'cast.runtime',
      '--agent-path', agentPath,
      '--port', port.toString(),
    ], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        CAST_AGENT_NAME: agentName,
        PYTHONPATH: pythonPath,
      },
    })

    runtime.on('error', (err) => {
      this.error(`Failed to start Python runtime: ${err.message}\nMake sure Python dependencies are installed.`)
    })

    // Wait for port announcement
    let agentPort: number | null = null
    let startupTimeout: NodeJS.Timeout

    startupTimeout = setTimeout(() => {
      if (!agentPort) {
        this.error('Agent failed to start within 30 seconds. Check the output above for errors.')
      }
    }, 30000)

    runtime.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      const match = output.match(/Agent ready on port (\d+)/)
      if (match) {
        agentPort = parseInt(match[1], 10)
        clearTimeout(startupTimeout)
        this.log(`Agent running on http://localhost:${agentPort}`)

        // Store in database
        db.setLocalAgent(agentName, runtime.pid || 0, agentPort)

        // Connect to agent
        this.connectToAgent(agentName, agentPort, flags)
      } else {
        process.stdout.write(output)
      }
    })

    // Handle process exit
    runtime.on('close', (code) => {
      clearTimeout(startupTimeout)
      if (code !== 0 && code !== null) {
        this.error(`Agent exited with error code ${code}`)
      }

      this.log(`Agent exited with code ${code}`)
      db.removeLocalAgent(agentName)
      process.exit(0)
    })

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      this.log('\nShutting down agent...')
      runtime.kill('SIGTERM')
    })

    // Keep the CLI alive
    await new Promise(() => {})
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

  private async connectToAgent(agentName: string, port: number, flags: any): Promise<void> {
    if (flags['no-tui']) {
      // Headless mode - just provide the A2A endpoint
      this.log(`Agent A2A endpoint: http://localhost:${port}`)
      this.log('Press Ctrl+C to stop')
      return
    }

    // Launch OpenTUI
    this.log('Launching OpenTUI...')

    const bunPath = this.resolveBun()
    const tuiPath = path.join(__dirname, '../../../cast-tui/dist/index.js')

    if (!fs.existsSync(tuiPath)) {
      this.warn(`OpenTUI not found at ${tuiPath}`)
      this.log(`Agent A2A endpoint: http://localhost:${port}`)
      this.log('Press Ctrl+C to stop')
      return
    }

    // Pause parent's stdin so TUI gets exclusive keyboard access
    process.stdin.pause()

    // Spawn TUI with inherited stdio so it controls the terminal
    // for interactive input. Not detached so it shares the process
    // group and controlling terminal with the parent.
    const opentui = spawn(bunPath, [
      tuiPath,
      '--agent', agentName,
      '--url', `http://localhost:${port}`,
      '--mode', 'dev',
    ], {
      stdio: 'inherit',
      detached: false,
    })

    opentui.on('error', (err) => {
      this.warn(`Failed to launch OpenTUI: ${err.message}`)
      this.log(`Agent is still running at http://localhost:${port}`)
    })

    opentui.on('exit', (code) => {
      this.log(`OpenTUI exited with code ${code}`)
      process.stdin.resume()
      process.exit(0)
    })
  }
}
