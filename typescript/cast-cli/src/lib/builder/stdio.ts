import {spawn, ChildProcess} from 'child_process'
import * as readline from 'readline'
import {EventEmitter} from 'events'

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, any>
  result?: any
  error?: {code: number; message: string; data?: any}
}

export class StdioJsonRpcBridge extends EventEmitter {
  private process: ChildProcess | null = null
  private messageId = 0
  private pendingRequests: Map<number | string, {resolve: Function; reject: Function}> = new Map()
  private rl: readline.Interface | null = null

  constructor(
    private command: string,
    private args: string[] = [],
    private options: {env?: Record<string, string>} = {},
  ) {
    super()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: this.options.env ? {...process.env, ...this.options.env} : process.env,
      })

      if (!this.process.stdout || !this.process.stdin) {
        reject(new Error('Failed to create stdio pipes'))
        return
      }

      this.rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      })

      this.rl.on('line', (line) => {
        this.handleLine(line)
      })

      this.process.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.process.on('exit', (code) => {
        this.emit('exit', code)
      })

      // Wait a moment for process to start
      setTimeout(resolve, 100)
    })
  }

  private handleLine(line: string): void {
    try {
      const message: JsonRpcMessage = JSON.parse(line)

      if (message.id !== undefined && this.pendingRequests.has(message.id)) {
        const {resolve, reject} = this.pendingRequests.get(message.id)!
        this.pendingRequests.delete(message.id)

        if (message.error) {
          reject(new Error(message.error.message))
        } else {
          resolve(message.result)
        }
      } else if (message.method) {
        // Notification from server
        this.emit(message.method, message.params)
      }
    } catch (err) {
      console.error('Failed to parse JSON-RPC message:', line)
    }
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Process not started'))
        return
      }

      const id = ++this.messageId
      this.pendingRequests.set(id, {resolve, reject})

      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.process.stdin.write(JSON.stringify(message) + '\n')

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 30000)
    })
  }

  stop(): void {
    if (this.rl) {
      this.rl.close()
    }
    if (this.process) {
      this.process.kill()
    }
  }
}
