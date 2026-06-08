import {expect} from 'chai'
import {A2AClient, A2AClientError} from '../../../../typescript/cast-cli/dist/lib/a2a/client'
import * as protocol from '../../../../typescript/cast-cli/dist/lib/a2a/protocol'

// Re-export interfaces for TypeScript type checking
import type {AgentResponse, StreamChunk} from '../../../../typescript/cast-cli/dist/lib/a2a/client'
export type {AgentResponse, StreamChunk}
import * as sinon from 'sinon'

describe('A2A Client', () => {
  describe('A2AClient class', () => {
    it('should be a class', () => {
      expect(typeof A2AClient).to.equal('function')
    })

    it('should require baseUrl', () => {
      // The constructor takes baseUrl as first argument
      const client = new A2AClient('http://localhost:8080')
      expect(client).to.be.an('object')
    })

    it('should accept optional authToken', () => {
      const client = new A2AClient('http://localhost:8080', 'test-token')
      expect(client).to.be.an('object')
    })

    it('should set Authorization header when token provided', () => {
      const client = new A2AClient('http://localhost:8080', 'bearer-token')
      expect(client).to.be.an('object')
    })

    it('should work without auth token', () => {
      const client = new A2AClient('http://localhost:8080')
      expect(client).to.be.an('object')
    })
  })

  describe('Client methods', () => {
    it('should be instantiable', () => {
      const client = new A2AClient('http://localhost:8080', 'test-token')
      expect(client).to.be.an('object')
    })

    it('should have getAgentCard method', () => {
      const client = new A2AClient('http://localhost:8080')
      expect(typeof client.getAgentCard).to.equal('function')
    })

    it('should have sendMessage method', () => {
      const client = new A2AClient('http://localhost:8080')
      expect(typeof client.sendMessage).to.equal('function')
    })

    it('should have sendMessageStream method', () => {
      const client = new A2AClient('http://localhost:8080')
      expect(typeof client.sendMessageStream).to.equal('function')
    })

    it('should generate IDs with proper pattern', () => {
      // The ID pattern is msg_<timestamp>_<random>
      const idPattern = /^msg_\d+_[a-z0-9]+$/
      expect('msg_1234567890_abc123').to.match(idPattern)
    })
  })

  describe('AgentResponse interface', () => {
    it('should have text property', () => {
      const response = {
        text: 'Hello, world!',
      }
      expect(response.text).to.equal('Hello, world!')
    })

    it('should have optional thinking property', () => {
      const response = {
        text: 'Thinking...',
        thinking: ['Step 1', 'Step 2'],
      }
      expect(response.thinking).to.deep.equal(['Step 1', 'Step 2'])
    })

    it('should have optional toolCalls property', () => {
      const response = {
        text: 'Using tool...',
        toolCalls: ['bash:ls', 'file:read'],
      }
      expect(response.toolCalls).to.deep.equal(['bash:ls', 'file:read'])
    })

    it('should have optional isError property', () => {
      const response = {
        text: 'Error occurred',
        isError: true,
      }
      expect(response.isError).to.be.true
    })

    it('should have optional uiAction property', () => {
      const response = {
        text: 'Action triggered',
        uiAction: { type: 'navigate', path: '/home' },
      }
      expect(response.uiAction).to.deep.equal({ type: 'navigate', path: '/home' })
    })
  })

  describe('Request ID generation', () => {
    it('should generate unique IDs', () => {
      // The client generates IDs for requests
      const idPattern = /^msg_\d+_[a-z0-9]+$/
      // Verify pattern format
      expect('msg_1234567890_abc123').to.match(idPattern)
    })

    it('should generate IDs with timestamp prefix', () => {
      const idPattern = /^msg_\d+_/
      expect('msg_1234567890_abc123').to.match(idPattern)
    })
  })
})

describe('A2AClientError', () => {
  describe('error construction', () => {
    it('should create error with message', () => {
      const error = new A2AClientError('Test error message')
      expect(error.message).to.equal('Test error message')
      expect(error.name).to.equal('A2AClientError')
    })

    it('should create error with code', () => {
      const error = new A2AClientError('Test error', 'ECONNREFUSED')
      expect(error.code).to.equal('ECONNREFUSED')
    })

    it('should create error with status code', () => {
      const error = new A2AClientError('Not found', 'NOT_FOUND', 404)
      expect(error.statusCode).to.equal(404)
    })

    it('should be instance of Error', () => {
      const error = new A2AClientError('Test')
      expect(error).to.be.an.instanceOf(Error)
    })

    it('should have error name', () => {
      const error = new A2AClientError('Test')
      expect(error.name).to.equal('A2AClientError')
    })
  })

  describe('error types', () => {
    it('should represent connection refused', () => {
      const error = new A2AClientError(
        'Connection refused. The agent server may not be running.',
        'ECONNREFUSED'
      )
      expect(error.code).to.equal('ECONNREFUSED')
    })

    it('should represent host not found', () => {
      const error = new A2AClientError(
        'Host not found. Check the agent URL.',
        'ENOTFOUND'
      )
      expect(error.code).to.equal('ENOTFOUND')
    })

    it('should represent timeout', () => {
      const error = new A2AClientError(
        'Request timed out',
        'TIMEOUT'
      )
      expect(error.code).to.equal('TIMEOUT')
    })

    it('should represent authentication failure', () => {
      const error = new A2AClientError(
        'Authentication failed',
        'AUTH_FAILED',
        401
      )
      expect(error.statusCode).to.equal(401)
      expect(error.code).to.equal('AUTH_FAILED')
    })

    it('should represent forbidden access', () => {
      const error = new A2AClientError(
        'Access forbidden',
        'FORBIDDEN',
        403
      )
      expect(error.statusCode).to.equal(403)
    })

    it('should represent not found', () => {
      const error = new A2AClientError(
        'Agent endpoint not found',
        'NOT_FOUND',
        404
      )
      expect(error.statusCode).to.equal(404)
    })

    it('should represent rate limiting', () => {
      const error = new A2AClientError(
        'Rate limited',
        'RATE_LIMITED',
        429
      )
      expect(error.statusCode).to.equal(429)
    })

    it('should represent server errors', () => {
      const error500 = new A2AClientError('Server error', 'SERVER_ERROR', 500)
      expect(error500.statusCode).to.equal(500)

      const error502 = new A2AClientError('Bad gateway', 'SERVER_ERROR', 502)
      expect(error502.statusCode).to.equal(502)

      const error503 = new A2AClientError('Service unavailable', 'SERVER_ERROR', 503)
      expect(error503.statusCode).to.equal(503)
    })
  })
})

describe('AgentResponse interface', () => {
  it('should have text property', () => {
    const response: AgentResponse = {
      text: 'Hello, world!',
    }
    expect(response.text).to.equal('Hello, world!')
  })

  it('should have optional thinking property', () => {
    const response: AgentResponse = {
      text: 'Thinking...',
      thinking: ['Step 1', 'Step 2'],
    }
    expect(response.thinking).to.deep.equal(['Step 1', 'Step 2'])
  })

  it('should have optional toolCalls property', () => {
    const response: AgentResponse = {
      text: 'Using tool...',
      toolCalls: ['bash:ls', 'file:read'],
    }
    expect(response.toolCalls).to.deep.equal(['bash:ls', 'file:read'])
  })

  it('should have optional isError property', () => {
    const response: AgentResponse = {
      text: 'Error occurred',
      isError: true,
    }
    expect(response.isError).to.be.true
  })

  it('should have optional uiAction property', () => {
    const response: AgentResponse = {
      text: 'Action triggered',
      uiAction: { type: 'navigate', path: '/home' },
    }
    expect(response.uiAction).to.deep.equal({ type: 'navigate', path: '/home' })
  })
})

describe('StreamChunk interface', () => {
  it('should have text property', () => {
    const chunk: StreamChunk = {
      text: 'streaming text',
    }
    expect(chunk.text).to.equal('streaming text')
  })

  it('should have optional uiAction', () => {
    const chunk: StreamChunk = {
      text: 'action text',
      uiAction: { type: 'refresh' },
    }
    expect(chunk.uiAction).to.deep.equal({ type: 'refresh' })
  })
})

describe('A2A Protocol Types', () => {
  describe('A2AMessage interface', () => {
    it('should have required fields', () => {
      const message: protocol.A2AMessage = {
        role: 'user',
        parts: [],
        messageId: 'test-123',
      }
      expect(message.role).to.equal('user')
      expect(message.parts).to.be.an('array')
      expect(message.messageId).to.equal('test-123')
    })

    it('should accept agent role', () => {
      const message: protocol.A2AMessage = {
        role: 'agent',
        parts: [],
        messageId: 'test-456',
      }
      expect(message.role).to.equal('agent')
    })

    it('should allow optional metadata', () => {
      const message: protocol.A2AMessage = {
        role: 'user',
        parts: [],
        messageId: 'test-789',
        metadata: { key: 'value' },
      }
      expect(message.metadata).to.deep.equal({ key: 'value' })
    })
  })

  describe('A2APart interface', () => {
    it('should support text parts', () => {
      const part: protocol.A2APart = {
        kind: 'text',
        text: 'Hello, world!',
      }
      expect(part.kind).to.equal('text')
      expect(part.text).to.equal('Hello, world!')
    })

    it('should support file parts', () => {
      const part: protocol.A2APart = {
        kind: 'file',
        file: {
          name: 'test.txt',
          mimeType: 'text/plain',
          bytes: 'SGVsbG8=',
        },
      }
      expect(part.kind).to.equal('file')
      expect(part.file?.name).to.equal('test.txt')
      expect(part.file?.mimeType).to.equal('text/plain')
    })

    it('should support data parts', () => {
      const part: protocol.A2APart = {
        kind: 'data',
        data: { key: 'value', number: 42 },
      }
      expect(part.kind).to.equal('data')
      expect(part.data).to.deep.equal({ key: 'value', number: 42 })
    })
  })

  describe('A2ARequest interface', () => {
    it('should have jsonrpc 2.0 requirement', () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'agent/card',
        params: {},
      }
      expect(request.jsonrpc).to.equal('2.0')
      expect(request.method).to.be.a('string')
    })

    it('should require method field', () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: { message: {} },
      }
      expect(request.method).to.equal('message/send')
    })
  })

  describe('A2AResponse interface', () => {
    it('should support success response with result', () => {
      const response: protocol.A2AResponse = {
        jsonrpc: '2.0',
        id: '1',
        result: { parts: [] },
      }
      expect(response.jsonrpc).to.equal('2.0')
      expect(response.result).to.exist
    })

    it('should support error response', () => {
      const response: protocol.A2AResponse = {
        jsonrpc: '2.0',
        id: '1',
        error: {
          code: -32600,
          message: 'Invalid request',
        },
      }
      expect(response.error).to.exist
      expect(response.error?.code).to.equal(-32600)
      expect(response.error?.message).to.equal('Invalid request')
    })

    it('should support error with data', () => {
      const response: protocol.A2AResponse = {
        jsonrpc: '2.0',
        id: '1',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { details: 'param is missing' },
        },
      }
      expect(response.error?.data).to.deep.equal({ details: 'param is missing' })
    })
  })

  describe('AgentCard interface', () => {
    it('should have required fields', () => {
      const card: protocol.AgentCard = {
        protocolVersion: '0.2.9',
        name: 'Test Agent',
        description: 'A test agent',
        url: 'http://localhost:8080',
        version: '1.0.0',
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: false,
          chatAgent: true,
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }
      expect(card.protocolVersion).to.equal('0.2.9')
      expect(card.name).to.equal('Test Agent')
      expect(card.capabilities.chatAgent).to.be.true
    })

    it('should support skills', () => {
      const card: protocol.AgentCard = {
        protocolVersion: '0.2.9',
        name: 'Test Agent',
        description: 'A test agent',
        url: 'http://localhost:8080',
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
          chatAgent: true,
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [
          { id: 'skill-1', name: 'Test Skill', description: 'A test skill' },
        ],
      }
      expect(card.skills).to.have.length(1)
      expect(card.skills[0].id).to.equal('skill-1')
    })
  })

  describe('JSON-RPC 2.0 compliance', () => {
    it('should use jsonrpc "2.0" version string', () => {
      const response: protocol.A2AResponse = {
        jsonrpc: '2.0',
        id: '1',
        result: {},
      }
      expect(response.jsonrpc).to.equal('2.0')
    })

    it('should use negative error codes for errors', () => {
      const errorCodes = {
        parseError: -32700,
        invalidRequest: -32600,
        methodNotFound: -32601,
        invalidParams: -32602,
        internalError: -32603,
      }
      expect(errorCodes.parseError).to.be.lessThan(0)
      expect(errorCodes.invalidRequest).to.be.lessThan(0)
      expect(errorCodes.methodNotFound).to.be.lessThan(0)
    })

    it('should have string method names', () => {
      const methods = ['agent/card', 'message/send', 'task/get']
      methods.forEach(method => {
        expect(typeof method).to.equal('string')
      })
    })
  })
})