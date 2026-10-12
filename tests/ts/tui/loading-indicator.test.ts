import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the helper and run that JavaScript instead.
function loadLoadingIndicator(): {
  loadingFrame: (tick: number, elapsedMs: number, mode: 'plan' | 'build') => string
  stopLoading: (state: {stopped: boolean}, clear: () => void) => void
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/loading-indicator.ts')
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

describe('loading indicator', () => {
  const {loadingFrame, stopLoading} = loadLoadingIndicator()
  const modes = ['plan', 'build'] as const

  it('selects braille frames and wraps', () => {
    for (const mode of modes) {
      expect(loadingFrame(0, 0, mode)).to.equal('⠋ Working')
      expect(loadingFrame(1, 0, mode)).to.equal('⠙ Working')
      expect(loadingFrame(9, 0, mode)).to.equal('⠏ Working')
      expect(loadingFrame(10, 0, mode)).to.equal('⠋ Working')
      expect(loadingFrame(-1, 0, mode)).to.equal('⠏ Working')
    }
  })

  it('shows whole seconds only once a second has elapsed', () => {
    for (const mode of modes) {
      expect(loadingFrame(0, 999, mode)).to.equal('⠋ Working')
      expect(loadingFrame(0, 1000, mode)).to.equal('⠋ Working  1s')
      expect(loadingFrame(2, 2000, mode)).to.equal('⠹ Working  2s')
      expect(loadingFrame(4, 12000, mode)).to.equal('⠼ Working  12s')
      expect(loadingFrame(0, 999, 'plan')).to.equal(loadingFrame(0, 999, 'build'))
      expect(loadingFrame(4, 12000, 'plan')).to.equal(loadingFrame(4, 12000, 'build'))
    }
  })

  it('does not clear twice when stopped again', () => {
    const state = {stopped: false}
    let calls = 0
    const clear = () => {
      calls += 1
    }
    stopLoading(state, clear)
    expect(state.stopped).to.equal(true)
    expect(calls).to.equal(1)
    expect(() => stopLoading(state, clear)).to.not.throw()
    expect(calls).to.equal(1)
  })
})
