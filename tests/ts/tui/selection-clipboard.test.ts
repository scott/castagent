import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module and @opentui/core uses bun:ffi, so Mocha cannot
// import TUI modules. This file has no imports; transpile and run it here.
function loadCopyHighlightedText(): (text: string, clipboard: {
  osc52(text: string): void
  write(text: string): Promise<unknown>
}) => void {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/selection-clipboard.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as {copyHighlightedText?: (text: string, clipboard: {
    osc52(text: string): void
    write(text: string): Promise<unknown>
  }) => void}}
  const sandbox = {exports: module.exports, module, require}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  if (!module.exports.copyHighlightedText) {
    throw new Error('copyHighlightedText was not exported')
  }
  return module.exports.copyHighlightedText
}

describe('highlighted text clipboard', () => {
  const copyHighlightedText = loadCopyHighlightedText()

  it('copies non-empty text through OSC 52 and clipboardy', () => {
    const osc52: string[] = []
    const write: string[] = []
    const text = '  line one\nline two  '
    copyHighlightedText(text, {
      osc52(value: string) {
        osc52.push(value)
      },
      write(value: string) {
        write.push(value)
        return Promise.resolve()
      },
    })
    expect(osc52).to.deep.equal([text])
    expect(write).to.deep.equal([text])
  })

  it('copies whitespace-only text exactly', () => {
    const osc52: string[] = []
    const write: string[] = []
    copyHighlightedText(' \n\t', {
      osc52(value: string) {
        osc52.push(value)
      },
      write(value: string) {
        write.push(value)
        return Promise.resolve()
      },
    })
    expect(osc52).to.deep.equal([' \n\t'])
    expect(write).to.deep.equal([' \n\t'])
  })

  it('does not copy an empty string', () => {
    const osc52: string[] = []
    const write: string[] = []
    copyHighlightedText('', {
      osc52(value: string) {
        osc52.push(value)
      },
      write(value: string) {
        write.push(value)
        return Promise.resolve()
      },
    })
    expect(osc52).to.deep.equal([])
    expect(write).to.deep.equal([])
  })

  it('still writes when OSC 52 throws', () => {
    const write: string[] = []
    expect(() => {
      copyHighlightedText('keep', {
        osc52() {
          throw new Error('osc52 unsupported')
        },
        write(value: string) {
          write.push(value)
          return Promise.resolve()
        },
      })
    }).to.not.throw()
    expect(write).to.deep.equal(['keep'])
  })

  it('does not throw when the clipboard write rejects', async () => {
    const osc52: string[] = []
    expect(() => {
      copyHighlightedText('keep', {
        osc52(value: string) {
          osc52.push(value)
        },
        write() {
          return Promise.reject(new Error('clipboard unavailable'))
        },
      })
    }).to.not.throw()
    expect(osc52).to.deep.equal(['keep'])
    await new Promise(resolve => setImmediate(resolve))
  })

  it('does not throw when the clipboard write throws synchronously', () => {
    const osc52: string[] = []
    expect(() => {
      copyHighlightedText('keep', {
        osc52(value: string) {
          osc52.push(value)
        },
        write() {
          throw new Error('clipboard threw')
        },
      })
    }).to.not.throw()
    expect(osc52).to.deep.equal(['keep'])
  })
})
