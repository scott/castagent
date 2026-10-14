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

/**
 * Same budget as the A2A builder bridge. A live model turn is often
 * longer than 30 seconds; giving up at 30s reports "Request timeout"
 * while the builder is still working.
 */
export const BUILDER_REQUEST_TIMEOUT_MS = 120_000

interface PendingRequest {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function builderExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean)
  const exception = [...lines].reverse().find(line => /(?:Error|Exception):/.test(line))
  const why = signal ? `signal ${signal}` : `code ${code}`
  if (exception) return new Error(`Builder exited with ${why}: ${exception}`)
  return new Error(`Builder exited with ${why}`)
}

export class StdioJsonRpcBridge extends EventEmitter {
  private process: ChildProcess | null = null
  private messageId = 0
  private pendingRequests: Map<number | string, PendingRequest> = new Map()
  private rl: readline.Interface | null = null
  private stderrText = ''
  private exitError: Error | null = null

  constructor(
    private command: string,
    private args: string[] = [],
    private options: {env?: NodeJS.ProcessEnv; timeoutMs?: number} = {},
  ) {
    super()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.options.env ? {...process.env, ...this.options.env} : process.env,
      })

      if (!this.process.stdout || !this.process.stdin) {
        reject(new Error('Failed to create stdio pipes'))
        return
      }

      this.process.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        this.stderrText = (this.stderrText + text).slice(-4000)
        process.stderr.write(text)
      })

      this.rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      })

      this.rl.on('line', (line) => {
        this.handleLine(line)
      })

      this.process.on('error', (err) => {
        this.emit('error', err)
        this.failPending(err)
        reject(err)
      })

      // 'close' runs after stderr is flushed. 'exit' can run first and
      // would report a bare status with the Python error still buffered.
      this.process.on('close', (code, signal) => {
        const error = builderExitError(code, signal, this.stderrText)
        this.exitError = error
        this.failPending(error)
        this.emit('exit', code)
      })

      // Wait a moment for process to start
      setTimeout(resolve, 100)
    })
  }

  private failPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private handleLine(line: string): void {
    try {
      const message: JsonRpcMessage = JSON.parse(line)

      if (message.id !== undefined && this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!
        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.id)

        if (message.error) {
          pending.reject(new Error(message.error.message))
        } else {
          pending.resolve(message.result)
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
      if (this.exitError) {
        reject(this.exitError)
        return
      }

      if (!this.process?.stdin) {
        reject(new Error('Process not started'))
        return
      }

      const id = ++this.messageId
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, this.options.timeoutMs ?? BUILDER_REQUEST_TIMEOUT_MS)
      this.pendingRequests.set(id, {resolve, reject, timer})

      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      try {
        this.process.stdin.write(JSON.stringify(message) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  stop(): void {
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      this.process.kill()
    }
  }
}
