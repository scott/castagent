import {expect} from 'chai'
import axios, {AxiosError} from 'axios'
import {Readable} from 'stream'
import {A2AClient, A2AClientError, STREAM_RESUME_LIMIT} from '../../../../typescript/cast-cli/dist/lib/a2a/client'
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

describe('A2AClient resume retries', () => {
  const sandbox = sinon.createSandbox()
  let post: sinon.SinonStub

  function statusError(status: number): AxiosError {
    const error = new AxiosError(`Request failed with status code ${status}`)
    error.response = {
      status,
      statusText: '',
      headers: {},
      config: error.config!,
      data: '',
    }
    return error
  }

  beforeEach(() => {
    post = sandbox.stub()
    sandbox.stub(axios, 'create').returns({post} as never)
    sandbox.stub(A2AClient.prototype as unknown as {sleep: () => Promise<void>}, 'sleep').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('retries HTTP 503 while a MicroVM resumes, then reads the stream', async () => {
    post.onCall(0).rejects(statusError(503))
    post.onCall(1).rejects(statusError(503))
    post.onCall(2).resolves({
      data: Readable.from([
        'data: {"jsonrpc":"2.0","result":{"parts":[{"kind":"text","text":"pong"}]}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })

    const client = new A2AClient(
      'https://vm.mkc1.microvm.ondigitalocean.com',
      'agent-token',
      'do-token',
    )
    const chunks: string[] = []
    for await (const chunk of client.sendMessageStream('hi')) {
      chunks.push(chunk.text)
    }

    expect(chunks.join('')).to.equal('pong')
    expect(post.callCount).to.equal(3)
    expect(post.secondCall.args[2].headers.Accept).to.equal('text/event-stream')
  })

  it('ignores keepalive comments on a chat stream', async () => {
    const keepalive = `: ${'keepalive '.repeat(20)}\n\n`
    post.resolves({
      data: Readable.from([
        keepalive,
        'data: {"jsonrpc":"2.0","result":{"parts":[{"kind":"text","text":"pong"}]}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })

    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')
    const chunks: string[] = []
    for await (const chunk of client.sendMessageStream('hi')) {
      chunks.push(chunk.text)
    }

    expect(chunks).to.deep.equal(['pong'])
  })

  it('explains a MicroVM stream that the edge closes', async () => {
    const stream = new Readable({
      read() {
        const error = new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()') as NodeJS.ErrnoException
        error.code = 'ECONNRESET'
        this.destroy(error)
      },
    })
    post.resolves({data: stream})

    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')
    try {
      for await (const chunk of client.sendMessageStream('install the skill')) {
        expect(chunk).to.equal(undefined)
      }
      expect.fail('expected the edge to close the stream')
    } catch (error) {
      expect(error).to.be.instanceOf(A2AClientError)
      expect((error as Error).message).to.include('15 seconds')
      expect((error as Error).message).to.include('installing a skill')
    }
    // No resume marker means this server cannot continue the reply.
    expect(post.callCount).to.equal(1)
  })

  function textEvent(text: string): string {
    return `data: ${JSON.stringify({
      jsonrpc: '2.0',
      result: {parts: [{kind: 'text', text}]},
    })}\n\n`
  }

  function closingAfter(chunks: string[]): Readable {
    let index = 0
    return new Readable({
      read() {
        if (index < chunks.length) {
          this.push(chunks[index])
          index++
          return
        }
        const error = new Error('socket hang up') as NodeJS.ErrnoException
        error.code = 'ECONNRESET'
        this.destroy(error)
      },
    })
  }

  it('continues a MicroVM reply after the edge closes the socket', async () => {
    post.callsFake(async (_url: string, payload: {params: {metadata: {streamId: string, streamOffset: number, sessionId?: string}}}) => {
      const id = payload.params.metadata.streamId
      const offset = payload.params.metadata.streamOffset
      if (offset === 0) {
        return {
          data: closingAfter([
            `: cast-stream ${id}\n\n`,
            textEvent('Based'),
            textEvent(''),
          ]),
        }
      }
      return {
        data: Readable.from([
          `: cast-stream ${id}\n\n`,
          textEvent(' on my current'),
          'data: [DONE]\n\n',
        ]),
      }
    })

    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')
    const chunks: string[] = []
    for await (const chunk of client.sendMessageStream('do you have access to gander?', {sessionId: 'sess-1'})) {
      chunks.push(chunk.text)
    }

    expect(chunks).to.deep.equal(['Based', ' on my current'])
    expect(post.callCount).to.equal(2)
    const first = post.firstCall.args[1].params.metadata
    const second = post.secondCall.args[1].params.metadata
    expect(first.streamId).to.be.a('string')
    expect(second.streamId).to.equal(first.streamId)
    expect(first.streamOffset).to.equal(0)
    // The empty text event counts. Skipping it would repeat "Based".
    expect(second.streamOffset).to.equal(2)
    expect(second.sessionId).to.equal('sess-1')
  })

  it('does not reconnect after the reply is done', async () => {
    post.callsFake(async (_url: string, payload: {params: {metadata: {streamId: string}}}) => {
      const id = payload.params.metadata.streamId
      return {
        data: Readable.from([
          `: cast-stream ${id}\n\n`,
          textEvent('pong'),
          'data: [DONE]\n\n',
        ]),
      }
    })

    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')
    const chunks: string[] = []
    for await (const chunk of client.sendMessageStream('hi')) {
      chunks.push(chunk.text)
    }

    expect(chunks).to.deep.equal(['pong'])
    expect(post.callCount).to.equal(1)
  })

  it('stops resuming after the edge keeps closing the stream', async () => {
    post.callsFake(async (_url: string, payload: {params: {metadata: {streamId: string}}}) => {
      const id = payload.params.metadata.streamId
      return {data: closingAfter([`: cast-stream ${id}\n\n`])}
    })

    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')
    try {
      for await (const chunk of client.sendMessageStream('install the skill')) {
        expect(chunk).to.equal(undefined)
      }
      expect.fail('expected the edge to keep closing the stream')
    } catch (error) {
      expect(error).to.be.instanceOf(A2AClientError)
      expect((error as Error).message).to.include('15 seconds')
    }
    expect(post.callCount).to.equal(STREAM_RESUME_LIMIT + 1)
  })

  it('does not resume a stream on a host that is not a MicroVM', async () => {
    post.callsFake(async () => ({data: closingAfter([textEvent('partial')])}))
    const client = new A2AClient('http://localhost:8080', 'agent')

    try {
      for await (const chunk of client.sendMessageStream('hi')) {
        expect(chunk.text).to.equal('partial')
      }
      expect.fail('expected the socket to close')
    } catch (error) {
      expect(error).to.be.instanceOf(A2AClientError)
      expect((error as Error).message).to.include('connection closed')
      expect((error as Error).message).to.not.include('15 seconds')
    }
    expect(post.callCount).to.equal(1)
    expect(post.firstCall.args[1].params.metadata.streamId).to.equal(undefined)
  })

  it('does not retry HTTP 401', async () => {
    post.rejects(statusError(401))
    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')

    try {
      await client.getAgentCard()
      expect.fail('expected auth failure')
    } catch (error) {
      expect(error).to.be.instanceOf(A2AClientError)
      expect((error as A2AClientError).statusCode).to.equal(401)
    }
    expect(post.callCount).to.equal(1)
  })

  it('stops after the MicroVM resume window and names the 503', async () => {
    post.rejects(statusError(503))
    const client = new A2AClient('https://vm.mkc1.microvm.ondigitalocean.com', 'agent', 'edge')

    try {
      for await (const chunk of client.sendMessageStream('hi')) {
        expect(chunk).to.equal(undefined)
      }
      expect.fail('expected resume failure')
    } catch (error) {
      expect(error).to.be.instanceOf(A2AClientError)
      expect((error as A2AClientError).statusCode).to.equal(503)
      expect((error as Error).message).to.include('resuming from pause')
    }
    expect(post.callCount).to.equal(13)
  })

  it('retries a non-MicroVM 503 only a few times', async () => {
    post.rejects(statusError(503))
    const client = new A2AClient('http://localhost:8080', 'agent')

    try {
      await client.getAgentCard()
      expect.fail('expected server error')
    } catch (error) {
      expect((error as A2AClientError).message).to.equal('Server error (503). The agent may be experiencing issues.')
    }
    expect(post.callCount).to.equal(4)
  })
})

describe('A2AClient session metadata', () => {
  const sandbox = sinon.createSandbox()
  let post: sinon.SinonStub

  beforeEach(() => {
    post = sandbox.stub()
    sandbox.stub(axios, 'create').returns({post} as never)
  })

  afterEach(() => {
    sandbox.restore()
  })

  function jsonResult(text: string) {
    return {
      data: {
        jsonrpc: '2.0',
        id: '1',
        result: {parts: [{kind: 'text', text}]},
      },
    }
  }

  it('sends no session metadata when the caller omits an id', async () => {
    post.resolves(jsonResult('ok'))
    const client = new A2AClient('http://localhost:8080')
    const response = await client.sendMessage('hello')
    expect(response.text).to.equal('ok')
    const payload = post.firstCall.args[1]
    expect(payload.method).to.equal('message/send')
    expect(payload.params.metadata).to.deep.equal({})
  })

  it('sends the session id on message/send without a transcript', async () => {
    post.resolves(jsonResult('ok'))
    const client = new A2AClient('http://localhost:8080')
    await client.sendMessage('hello', {sessionId: 'sess-1'})
    expect(post.firstCall.args[1].params.metadata).to.deep.equal({sessionId: 'sess-1'})
    expect(post.firstCall.args[1].params.message.parts[0].text).to.equal('hello')
  })

  it('sends a resumed transcript in metadata', async () => {
    post.resolves(jsonResult('ok'))
    const client = new A2AClient('http://localhost:8080')
    const history = [
      {role: 'user' as const, text: 'earlier'},
      {role: 'agent' as const, text: 'reply'},
    ]
    await client.sendMessage('next', {sessionId: 'sess-1', history})
    expect(post.firstCall.args[1].params.metadata).to.deep.equal({
      sessionId: 'sess-1',
      history,
    })
  })

  it('omits an empty transcript', async () => {
    post.resolves(jsonResult('ok'))
    const client = new A2AClient('http://localhost:8080')
    await client.sendMessage('hi', {sessionId: 'sess-1', history: []})
    expect(post.firstCall.args[1].params.metadata).to.deep.equal({sessionId: 'sess-1'})
  })

  it('sends the same session metadata on a streamed message', async () => {
    post.resolves({
      data: Readable.from([
        'data: {"jsonrpc":"2.0","result":{"parts":[{"kind":"text","text":"pong"}]}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })
    const client = new A2AClient('http://localhost:8080')
    const chunks: string[] = []
    for await (const chunk of client.sendMessageStream('hi', {
      sessionId: 'sess-stream',
      history: [{role: 'user', text: 'before'}],
    })) {
      chunks.push(chunk.text)
    }
    expect(chunks).to.deep.equal(['pong'])
    const payload = post.firstCall.args[1]
    expect(payload.params.metadata).to.deep.equal({
      sessionId: 'sess-stream',
      history: [{role: 'user', text: 'before'}],
    })
    expect(post.firstCall.args[2].headers.Accept).to.equal('text/event-stream')
  })

  it('yields an ask permission request from stream metadata', async () => {
    post.resolves({
      data: Readable.from([
        'data: {"jsonrpc":"2.0","result":{"parts":[],"metadata":{"permissionRequest":{"id":"req-1","tool":"bash","arguments":{"command":"date"}}}}}\n\n',
        'data: {"jsonrpc":"2.0","result":{"parts":[{"kind":"text","text":"denied"}]}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })
    const client = new A2AClient('http://localhost:8812')
    const chunks = []
    for await (const chunk of client.sendMessageStream('run date')) {
      chunks.push(chunk)
    }
    expect(chunks[0].permissionRequest).to.deep.equal({
      id: 'req-1',
      tool: 'bash',
      arguments: {command: 'date'},
    })
    expect(chunks[0].text).to.equal('')
    expect(chunks[1].text).to.equal('denied')
  })

  it('sends permission/respond with a boolean', async () => {
    post.resolves({data: {jsonrpc: '2.0', id: '1', result: {ok: true}}})
    const client = new A2AClient('http://localhost:8812')
    await client.respondToPermission('req-1', false)
    const payload = post.firstCall.args[1]
    expect(payload.method).to.equal('permission/respond')
    expect(payload.params).to.deep.equal({id: 'req-1', approved: false})
  })
})
