import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the focus decision and run that JavaScript instead.
function loadInputFocus(): {
  slashKeyAction: (opts: {
    key: string
    ctrl: boolean
    meta: boolean
    alt: boolean
    inputFocused: boolean
    modalOpen: boolean
  }) => 'insert' | 'passthrough' | 'ignore'
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/input-focus.ts')
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

describe('slash key focus decision', () => {
  const {slashKeyAction} = loadInputFocus()

  const base = {
    key: '/',
    ctrl: false,
    meta: false,
    alt: false,
    inputFocused: false,
    modalOpen: false,
  }

  it('inserts when the input is unfocused and no modal is open', () => {
    expect(slashKeyAction(base)).to.equal('insert')
  })

  it('does not double-insert when the input is already focused', () => {
    expect(slashKeyAction({...base, inputFocused: true})).to.equal('passthrough')
  })

  it('ignores slash while a modal is open', () => {
    expect(slashKeyAction({...base, modalOpen: true})).to.equal('ignore')
    expect(slashKeyAction({...base, modalOpen: true, inputFocused: true})).to.equal('ignore')
  })

  it('passes a non-slash key through', () => {
    expect(slashKeyAction({...base, key: 'a'})).to.equal('passthrough')
    expect(slashKeyAction({...base, key: 'escape', inputFocused: false})).to.equal('passthrough')
  })

  it('passes a ctrl-slash chord through', () => {
    expect(slashKeyAction({...base, ctrl: true})).to.equal('passthrough')
    expect(slashKeyAction({...base, ctrl: true, modalOpen: true})).to.equal('passthrough')
    expect(slashKeyAction({...base, meta: true})).to.equal('passthrough')
    expect(slashKeyAction({...base, alt: true})).to.equal('passthrough')
  })
})
