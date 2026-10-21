import {expect} from 'chai'
import {ChildProcess} from 'child_process'
import {StdioJsonRpcBridge, builderExitError, BUILDER_REQUEST_TIMEOUT_MS} from '../../../../typescript/cast-cli/src/lib/builder/stdio'

describe('StdioJsonRpcBridge', () => {
  it('reports a builder crash instead of waiting for Request timeout', async () => {
    const script = `
      process.stderr.write('ModuleNotFoundError: No module named cast\\n')
      process.exit(1)
    `
    const bridge = new StdioJsonRpcBridge(process.execPath, ['-e', script], {timeoutMs: 5000})
    const started = Date.now()
    await bridge.start()
    try {
      await bridge.send('initialize', {agent_name: 'meta-test'})
      expect.fail('initialize should reject')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('No module named cast')
      expect(message).to.not.include('Request timeout')
      expect(Date.now() - started).to.be.lessThan(3000)
    } finally {
      bridge.stop()
    }
  })

  it('rejects a request sent after the builder has already exited', async () => {
    const script = `
      process.stderr.write('ModuleNotFoundError: No module named cast\\n')
      process.exit(1)
    `
    for (let attempt = 0; attempt < 15; attempt++) {
      const bridge = new StdioJsonRpcBridge(process.execPath, ['-e', script], {timeoutMs: 5000})
      await bridge.start()
      try {
        await bridge.send('initialize', {agent_name: 'meta-test'})
        expect.fail('initialize should reject')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('No module named cast')
        expect(message).to.not.include('EPIPE')
        expect(message).to.not.include('Request timeout')
      } finally {
        bridge.stop()
      }
    }
  })

  it('keeps an in-flight request open when stdin reports EPIPE before close', async () => {
    const bridge = new StdioJsonRpcBridge(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {timeoutMs: 500})
    await bridge.start()
    const child = (bridge as unknown as {process: ChildProcess}).process
    let settled = false
    const sent = bridge.send('output', {message: 'hi'}).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const epipe = Object.assign(new Error('write EPIPE'), {code: 'EPIPE'})
    expect(() => child.stdin?.emit('error', epipe)).to.not.throw()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).to.equal(false)
    bridge.stop()
    await sent
  })

  it('times out a live request at the configured budget', async () => {
    const bridge = new StdioJsonRpcBridge(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {timeoutMs: 200})
    await bridge.start()
    const started = Date.now()
    try {
      await bridge.send('output', {message: 'Create an email agent'})
      expect.fail('output should time out')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.equal('Request timeout')
      const elapsed = Date.now() - started
      expect(elapsed).to.be.greaterThan(150)
      expect(elapsed).to.be.lessThan(2000)
    } finally {
      bridge.stop()
    }
  })

  it('resolves a JSON-RPC result from the builder', async () => {
    const script = `
      const readline = require('readline')
      const rl = readline.createInterface({input: process.stdin})
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: msg.id, result: {method: msg.method}}) + '\\n')
      })
    `
    const bridge = new StdioJsonRpcBridge(process.execPath, ['-e', script], {timeoutMs: 2000})
    await bridge.start()
    try {
      const result = await bridge.send('initialize', {harness: true})
      expect(result).to.deep.equal({method: 'initialize'})
    } finally {
      bridge.stop()
    }
  })

  it('uses the same request budget as a live builder turn', () => {
    expect(BUILDER_REQUEST_TIMEOUT_MS).to.equal(120000)
    const error = builderExitError(1, null, 'Traceback\nModuleNotFoundError: No module named cast\n')
    expect(error.message).to.equal('Builder exited with code 1: ModuleNotFoundError: No module named cast')
  })
})
