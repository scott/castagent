import {spawn, ChildProcess} from 'child_process'
import * as readline from 'readline'
import {EventEmitter} from 'events'
import * as http from 'http'
import * as net from 'net'

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, any>
  result?: any
  error?: {code: number; message: string; data?: any}
}

/**
 * A2A-to-Builder Bridge Server.
 *
 * This HTTP server translates A2A protocol messages (used by OpenTUI)
 * into stdio JSON-RPC messages for the Builder Agent.
 *
 * It allows the existing TUI to connect to the builder agent
 * without any TUI modifications.
 */
export class BuilderA2ABridge extends EventEmitter {
  private builderProcess: ChildProcess | null = null
  private builderRl: readline.Interface | null = null
  private server: http.Server | null = null
  public port: number = 0
  private messageId = 0
  private pendingResponses: Map<number | string, {resolve: (value: any) => void; reject: (err: Error) => void}> = new Map()
  private responseBuffer = ''
  private isReady = false
  private welcomeMessage: string | null = null

  constructor(
    private command: string,
    private args: string[] = [],
    private env: Record<string, string> = {},
    private agentName: string = '__new__',
    private newMode: boolean = true,
  ) {
    super()
  }

  async start(): Promise<void> {
    // Start the builder process
    await this.startBuilder()
    // Start the HTTP bridge server
    await this.startServer()
    // Initialize the builder
    await this.initializeBuilder()
  }

  private async startBuilder(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.builderProcess = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {...process.env, ...this.env},
      })

      if (!this.builderProcess.stdout || !this.builderProcess.stdin) {
        reject(new Error('Failed to create stdio pipes for builder'))
        return
      }

      this.builderRl = readline.createInterface({
        input: this.builderProcess.stdout,
        crlfDelay: Infinity,
      })

      this.builderRl.on('line', (line) => {
        this.handleBuilderLine(line)
      })

      this.builderProcess.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.builderProcess.on('exit', (code) => {
        this.emit('exit', code)
      })

      // Wait a moment for process to start
      setTimeout(resolve, 500)
    })
  }

  private handleBuilderLine(line: string): void {
    try {
      const message: JsonRpcMessage = JSON.parse(line)

      // Handle responses to our requests
      if (message.id !== undefined && this.pendingResponses.has(message.id)) {
        const {resolve, reject} = this.pendingResponses.get(message.id)!
        this.pendingResponses.delete(message.id)

        if (message.error) {
          reject(new Error(message.error.message))
        } else {
          resolve(message.result)
        }
        return
      }

      // Handle notifications from builder (not expected in current flow)
      if (message.method) {
        this.emit('builderNotification', message)
      }
    } catch {
      // Not JSON - builder stderr is already inherited, so this might be stray stdout
      if (line.trim()) {
        this.emit('builderOutput', line)
      }
    }
  }

  private async sendBuilderRequest(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.builderProcess?.stdin) {
        reject(new Error('Builder process not started'))
        return
      }

      const id = ++this.messageId
      this.pendingResponses.set(id, {resolve, reject})

      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.builderProcess.stdin.write(JSON.stringify(message) + '\n')

      // Timeout after 60 seconds (builder may take time for LLM calls)
      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id)
          reject(new Error(`Builder request timeout: ${method}`))
        }
      }, 60000)
    })
  }

  private async initializeBuilder(): Promise<void> {
    const result = await this.sendBuilderRequest('initialize', {
      agent_name: this.agentName,
      new_mode: this.newMode,
    })
    this.welcomeMessage = result?.message || null
    this.isReady = true
    this.emit('ready', result)
  }

  getWelcomeMessage(): string | null {
    return this.welcomeMessage
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })

      // Find a free port
      const tempServer = net.createServer()
      tempServer.listen(0, '127.0.0.1', () => {
        const address = tempServer.address() as net.AddressInfo
        this.port = address.port
        tempServer.close(() => {
          this.server!.listen(this.port, '127.0.0.1', () => {
            resolve()
          })
        })
      })

      this.server.on('error', (err) => {
        reject(err)
      })
    })
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Enable CORS for local TUI
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({jsonrpc: '2.0', error: {code: -32600, message: 'Method not allowed'}}))
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })

    req.on('end', async () => {
      try {
        const request = JSON.parse(body)
        const accept = req.headers.accept || ''
        const isStreaming = accept.includes('text/event-stream')

        if (request.method === 'agent/card') {
          res.writeHead(200, {'Content-Type': 'application/json'})
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '0.2.9',
              name: 'Cast Builder',
              description: 'Cast Builder Agent - helps you create new agents',
              url: `http://127.0.0.1:${this.port}`,
              version: '1.0.0',
              capabilities: {
                streaming: true,
                pushNotifications: false,
                stateTransitionHistory: true,
                chatAgent: true,
              },
              defaultInputModes: ['text/plain'],
              defaultOutputModes: ['text/plain'],
              skills: [{
                id: 'builder',
                name: 'Agent Builder',
                description: 'Creates new AI agents',
              }],
            },
          }))
          return
        }

        if (request.method === 'message/send') {
          const message = request.params?.message || {}
          const parts = message.parts || []
          let text = ''
          for (const part of parts) {
            if (part.kind === 'text') {
              text += part.text || ''
            }
          }

          if (!text.trim()) {
            res.writeHead(400, {'Content-Type': 'application/json'})
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {code: -32602, message: 'No text content found'},
            }))
            return
          }

          if (isStreaming) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            })

            // Helper to safely write to response (handles client disconnects)
            const safeWrite = (data: string): boolean => {
              if (res.writableEnded) return false
              try {
                return res.write(data)
              } catch {
                return false
              }
            }

            try {
              const responseText = await this.sendBuilderRequest('output', {content: text})
              const response = responseText?.response || responseText?.message || "I've processed your request."

              // Simulate streaming by splitting into words
              const words = response.split(' ')
              for (let i = 0; i < words.length; i++) {
                const chunk = (i > 0 ? ' ' : '') + words[i]
                const event = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    parts: [{kind: 'text', text: chunk}],
                  },
                }
                safeWrite(`data: ${JSON.stringify(event)}\n\n`)
                // Minimal delay for streaming effect (reduced to avoid A2A client timeout)
                await new Promise((r) => setTimeout(r, 1))
              }

              safeWrite('data: [DONE]\n\n')
            } catch (err: any) {
              const errorEvent = {
                jsonrpc: '2.0',
                id: request.id,
                error: {code: -32603, message: err.message},
              }
              safeWrite(`data: ${JSON.stringify(errorEvent)}\n\n`)
              safeWrite('data: [DONE]\n\n')
            }

            if (!res.writableEnded) {
              res.end()
            }
          } else {
            try {
              const responseText = await this.sendBuilderRequest('output', {content: text})
              const response = responseText?.response || responseText?.message || "I've processed your request."

              res.writeHead(200, {'Content-Type': 'application/json'})
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  parts: [{kind: 'text', text: response}],
                  metadata: {
                    thinking: [],
                    toolCalls: [],
                  },
                },
              }))
            } catch (err: any) {
              res.writeHead(500, {'Content-Type': 'application/json'})
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: {code: -32603, message: err.message},
              }))
            }
          }

          return
        }

        // Unknown method
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: {code: -32601, message: `Method '${request.method}' not found`},
        }))
      } catch (err: any) {
        res.writeHead(400, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {code: -32700, message: `Parse error: ${err.message}`},
        }))
      }
    })
  }

  stop(): void {
    // Reject all pending responses immediately so they don't hang until timeout
    for (const [id, {reject}] of this.pendingResponses) {
      reject(new Error('Bridge stopped'))
    }
    this.pendingResponses.clear()

    if (this.builderRl) {
      this.builderRl.close()
    }
    if (this.builderProcess) {
      this.builderProcess.kill()
    }
    if (this.server) {
      this.server.close()
    }
  }
}
