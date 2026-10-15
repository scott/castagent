import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
function loadCliArgs(): typeof import('../../../typescript/cast-tui/src/lib/cli-args') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/cli-args.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

describe('TUI launch arguments', () => {
  const {parseTuiLaunchOptions} = loadCliArgs()
  const token = 'sentinel-bearer-token'
  const edgeToken = 'sentinel-edge-token'

  it('reads credentials from the environment', () => {
    const options = parseTuiLaunchOptions(
      ['--agent', 'mailer', '--url', 'https://agent.example.test', '--mode', 'production'],
      {AUTH_TOKEN: token, CAST_EDGE_TOKEN: edgeToken},
    )
    expect(options).to.deep.equal({
      agent: 'mailer',
      url: 'https://agent.example.test',
      mode: 'production',
      token,
      edgeToken,
    })
  })

  it('refuses a bearer token on argv without echoing the value', () => {
    expect(() => parseTuiLaunchOptions(
      ['--url', 'https://agent.example.test', '--token', token],
      {},
    )).to.throw(/--token is not accepted on the command line/)
    try {
      parseTuiLaunchOptions(['--token', token, '--url', 'https://agent.example.test'], {})
      expect.fail('expected the token flag to be refused')
    } catch (error) {
      expect((error as Error).message).to.not.include(token)
    }
  })

  it('refuses an edge token on argv without echoing the value', () => {
    try {
      parseTuiLaunchOptions(['--edge-token', edgeToken, '--url', 'https://agent.example.test'], {})
      expect.fail('expected the edge token flag to be refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).to.include('--edge-token is not accepted on the command line')
      expect(message).to.not.include(edgeToken)
    }
  })

  it('does not treat AUTH_TOKEN as optional when the flag used to supply it', () => {
    const options = parseTuiLaunchOptions(
      ['--agent', 'mailer', '--url', 'https://agent.example.test', '--session', 'sess-1'],
      {},
    )
    expect(options.token).to.equal(undefined)
    expect(options.edgeToken).to.equal(undefined)
    expect(options.session).to.equal('sess-1')
  })
})
