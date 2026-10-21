import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import * as ts from 'typescript'

function loadHelper(): any {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/inference-provider.ts'),
    'utf8',
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  })
  const module = {exports: {}}
  const sandbox = {module, exports: module.exports, require, URL}
  vm.createContext(sandbox)
  vm.runInContext(compiled.outputText, sandbox)
  return module.exports
}

describe('inference provider picker', () => {
  const helper = loadHelper()

  it('uses a marker and does not switch a disabled row', () => {
    const disabled = {key: 'digitalocean', displayName: 'DigitalOcean Serverless Inference', enabled: false, current: false, baseUrl: 'https://inference.do-ai.run/v1', defaultBaseUrl: 'https://inference.do-ai.run/v1'}
    const enabled = {...disabled, enabled: true, current: false}
    const current = {...enabled, current: true}
    expect(helper.formatProviderRow(disabled, true).startsWith('▸')).to.equal(true)
    expect(helper.formatProviderRow(disabled, false).startsWith('  ')).to.equal(true)
    expect(helper.providerEnterAction(disabled)).to.equal('enable')
    expect(helper.providerEnterAction(enabled)).to.equal('switch')
    expect(helper.providerEnterAction(current)).to.equal('noop')
  })

  it('asks the CLI for the list on each open and keeps the token off argv', () => {
    expect(helper.providerListArgv()).to.deep.equal(['provider', '--json'])
    const same = helper.providerEnableArgv('digitalocean', 'https://inference.do-ai.run/v1', 'https://inference.do-ai.run/v1')
    expect(same).to.deep.equal(['provider', 'enable', 'digitalocean', '--token', '-'])
    const custom = helper.providerEnableArgv('digitalocean', 'https://inference.example/v1', 'https://inference.do-ai.run/v1')
    expect(custom).to.include('--url')
    expect(custom).to.not.include('secret')
  })

  it('rejects a URL that carries userinfo', () => {
    expect(helper.parseInferenceUrl('https://user:secret@inference.example/v1')).to.equal(null)
    expect(helper.parseInferenceUrl('https://inference.example/v1')).to.equal('https://inference.example/v1')
    expect(helper.parseInferenceUrl('http://evil.example/v1')).to.equal(null)
    expect(helper.parseInferenceUrl('http://127.0.0.1:9/v1')).to.equal('http://127.0.0.1:9/v1')
    expect(helper.parseInferenceUrl('http://[::1]/v1')).to.equal('http://[::1]/v1')
    expect(helper.parseInferenceUrl('http://localhost/v1')).to.equal('http://localhost/v1')
  })

  it('registers /provider only in dev mode', () => {
    const registry = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    const command = registry.slice(registry.indexOf("name: 'provider'"))
    expect(command.slice(0, command.indexOf('handler'))).to.match(/modes: \['dev'\]/)
  })
})
