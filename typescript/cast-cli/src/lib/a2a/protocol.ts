export interface A2APart {
  kind: 'text' | 'file' | 'data'
  text?: string
  file?: {
    name: string
    mimeType: string
    bytes?: string
    uri?: string
  }
  data?: Record<string, any>
}

export interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2APart[]
  messageId: string
  metadata?: Record<string, any>
}

export interface A2ARequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: Record<string, any>
}

export interface A2AResponse {
  jsonrpc: '2.0'
  id: string
  result?: Record<string, any>
  error?: {
    code: number
    message: string
    data?: any
  }
}

export interface AgentCard {
  protocolVersion: string
  name: string
  description: string
  url: string
  version: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    stateTransitionHistory: boolean
    chatAgent: boolean
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: Array<{
    id: string
    name: string
    description: string
  }>
}
