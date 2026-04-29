import axios, {AxiosInstance, AxiosError} from 'axios'
import type {Readable} from 'stream'
import {A2AMessage, A2APart, A2AResponse, AgentCard} from './protocol'

export interface AgentResponse {
  text: string
  thinking?: string[]
  toolCalls?: string[]
  isError?: boolean
}

export class A2AClientError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
  ) {
    super(message)
    this.name = 'A2AClientError'
  }
}

export class A2AClient {
  private http: AxiosInstance

  constructor(
    private baseUrl: string,
    private authToken?: string,
  ) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? {Authorization: `Bearer ${this.authToken}`} : {}),
      },
    })
  }

  private async requestWithRetry<T>(
    payload: unknown,
    retries = 3,
    delayMs = 1000,
  ): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.http.post('/', payload)
        return response.data as T
      } catch (error) {
        lastError = this.handleError(error, attempt, retries)

        // Don't retry on client errors (4xx except 429) or invalid JSON
        if (lastError instanceof A2AClientError) {
          if (lastError.statusCode && lastError.statusCode >= 400 && lastError.statusCode < 500) {
            if (lastError.statusCode !== 429) {
              throw lastError
            }
          }
        }

        if (attempt < retries) {
          const backoffDelay = delayMs * Math.pow(2, attempt)
          await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        }
      }
    }

    throw lastError
  }

  private handleError(error: unknown, attempt: number, retries: number): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError

      // Network errors
      if (!axiosError.response) {
        if (axiosError.code === 'ECONNREFUSED') {
          return new A2AClientError(
            'Connection refused. The agent server may not be running.',
            'ECONNREFUSED',
          )
        }

        if (axiosError.code === 'ENOTFOUND') {
          return new A2AClientError(
            'Host not found. Check the agent URL.',
            'ENOTFOUND',
          )
        }

        if (axiosError.code === 'ETIMEDOUT' || axiosError.code === 'ECONNABORTED') {
          return new A2AClientError(
            `Request timed out (attempt ${attempt + 1}/${retries + 1}). The agent may be slow or unresponsive.`,
            'TIMEOUT',
          )
        }

        return new A2AClientError(
          `Network error: ${axiosError.message}`,
          axiosError.code,
        )
      }

      const status = axiosError.response.status
      const errorData = axiosError.response.data as any

      // HTTP errors
      switch (status) {
        case 401:
          return new A2AClientError(
            'Authentication failed. The auth token may be invalid or expired.',
            'AUTH_FAILED',
            401,
          )
        case 403:
          return new A2AClientError(
            'Access forbidden. You do not have permission to access this agent.',
            'FORBIDDEN',
            403,
          )
        case 404:
          return new A2AClientError(
            'Agent endpoint not found. Check the agent URL.',
            'NOT_FOUND',
            404,
          )
        case 429:
          return new A2AClientError(
            `Rate limited (attempt ${attempt + 1}/${retries + 1}). Retrying...`,
            'RATE_LIMITED',
            429,
          )
        case 500:
        case 502:
        case 503:
        case 504:
          return new A2AClientError(
            `Server error (${status}). The agent may be experiencing issues.`,
            'SERVER_ERROR',
            status,
          )
        default:
          return new A2AClientError(
            `HTTP error ${status}: ${errorData?.message || axiosError.message}`,
            'HTTP_ERROR',
            status,
          )
      }
    }

    if (error instanceof SyntaxError) {
      return new A2AClientError(
        'Invalid JSON response from agent. The server may not be an A2A endpoint.',
        'INVALID_JSON',
      )
    }

    return new A2AClientError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      'UNKNOWN',
    )
  }

  async getAgentCard(): Promise<AgentCard> {
    const data = await this.requestWithRetry<A2AResponse>({
      jsonrpc: '2.0',
      id: '1',
      method: 'agent/card',
      params: {},
    })

    if (data.error) {
      throw new A2AClientError(`A2A error: ${data.error.message}`, 'A2A_ERROR')
    }

    return data.result as AgentCard
  }

  async sendMessage(text: string): Promise<AgentResponse> {
    const message: A2AMessage = {
      role: 'user',
      parts: [{kind: 'text', text}],
      messageId: this.generateId(),
    }

    const data = await this.requestWithRetry<A2AResponse>({
      jsonrpc: '2.0',
      id: this.generateId(),
      method: 'message/send',
      params: {
        message,
        metadata: {},
      },
    })

    if (data.error) {
      throw new A2AClientError(`A2A error: ${data.error.message}`, 'A2A_ERROR')
    }

    // Extract text from response parts
    const parts: A2APart[] = data.result?.parts || []
    const textContent = parts.map((part) => part.text || '').join('')

    // Extract thinking blocks and tool calls from metadata
    const metadata = data.result?.metadata || {}
    const thinking = metadata.thinking || []
    const toolCalls = metadata.toolCalls || []
    const isError = metadata.isError === true

    return {
      text: textContent,
      thinking: Array.isArray(thinking) ? thinking : [],
      toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
      isError,
    }
  }

  async *sendMessageStream(text: string): AsyncGenerator<string> {
    const message: A2AMessage = {
      role: 'user',
      parts: [{kind: 'text', text}],
      messageId: this.generateId(),
    }

    const response = await this.http.post('/', {
      jsonrpc: '2.0',
      id: this.generateId(),
      method: 'message/send',
      params: {
        message,
        metadata: {},
      },
    }, {
      headers: {
        Accept: 'text/event-stream',
      },
      responseType: 'stream',
    })

    const stream = response.data as Readable
    stream.setEncoding('utf8')

    let buffer = ''
    for await (const chunk of stream) {
      buffer += chunk as string
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') {
            return
          }

          try {
            const parsed: A2AResponse = JSON.parse(data)
            if (parsed.error) {
              throw new Error(`A2A error: ${parsed.error.message}`)
            }

            const parts: A2APart[] = parsed.result?.parts || []
            for (const part of parts) {
              if (part.text) {
                yield part.text
              }
            }
          } catch (error) {
            // Ignore parse errors for non-JSON lines
            if (error instanceof Error && !error.message.includes('A2A error')) {
              continue
            }
            throw error
          }
        }
      }
    }
  }

  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }
}
