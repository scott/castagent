import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the provider list and run that JavaScript instead.
function loadProviders(): {
  DEPLOYMENT_PROVIDERS: Array<{key: string}>
  providerIndexForNumberKey: (keyName: string | undefined, count?: number) => number | null
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/deployment-providers.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {
    exports: module.exports,
    module,
    require,
    __dirname: path.dirname(file),
    __filename: file,
    process,
  }
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

describe('deployment provider list', () => {
  const {DEPLOYMENT_PROVIDERS, providerIndexForNumberKey} = loadProviders()

  it('includes DigitalOcean MicroVM after Droplets', () => {
    const keys = DEPLOYMENT_PROVIDERS.map(provider => provider.key)
    expect(keys).to.deep.equal(['railway', 'fly', 'digitalocean', 'microvm', 'sprites', 'docker', 'local'])
    expect(DEPLOYMENT_PROVIDERS).to.have.length(7)
  })

  it('selects the seventh provider with key 7', () => {
    expect(providerIndexForNumberKey('7')).to.equal(6)
    expect(DEPLOYMENT_PROVIDERS[providerIndexForNumberKey('7')!].key).to.equal('local')
    expect(providerIndexForNumberKey('4')).to.equal(3)
    expect(DEPLOYMENT_PROVIDERS[3].key).to.equal('microvm')
    expect(providerIndexForNumberKey('8')).to.equal(null)
    expect(providerIndexForNumberKey('7', 6)).to.equal(null)
  })
})
