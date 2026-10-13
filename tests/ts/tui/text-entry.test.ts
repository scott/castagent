import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the text-entry helper and run that JavaScript instead.
function loadTextEntry(): typeof import('../../../typescript/cast-tui/src/lib/text-entry') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/text-entry.ts')
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

describe('skill field text entry', () => {
  const {
    applyEntryKey,
    clipFieldError,
    createTextEntry,
    deleteBackward,
    deleteForward,
    insertText,
    moveCursor,
    previewField,
    recordFailedSubmit,
  } = loadTextEntry()

  it('inserts at the cursor instead of appending', () => {
    const next = insertText({text: 'ac', cursor: 1}, 'b', 'single')
    expect(next).to.deep.equal({text: 'abc', cursor: 2})
  })

  it('moves left and right by one character', () => {
    const entry = {text: 'abcd', cursor: 2}
    expect(moveCursor(entry, 'left')).to.deep.equal({text: 'abcd', cursor: 1})
    expect(moveCursor(entry, 'right')).to.deep.equal({text: 'abcd', cursor: 3})
    expect(moveCursor({text: 'abcd', cursor: 0}, 'left').cursor).to.equal(0)
    expect(moveCursor({text: 'abcd', cursor: 4}, 'right').cursor).to.equal(4)
  })

  it('backspace and delete remove the character at the cursor', () => {
    const entry = {text: 'abcd', cursor: 2}
    expect(deleteBackward(entry)).to.deep.equal({text: 'acd', cursor: 1})
    expect(deleteForward(entry)).to.deep.equal({text: 'abd', cursor: 2})
    expect(deleteBackward({text: 'abcd', cursor: 0})).to.deep.equal({text: 'abcd', cursor: 0})
    expect(deleteForward({text: 'abcd', cursor: 4})).to.deep.equal({text: 'abcd', cursor: 4})
  })

  it('home and end move to the ends of the current line', () => {
    const entry = {text: 'ab\ncd\nef', cursor: 4}
    expect(moveCursor(entry, 'home')).to.deep.equal({text: 'ab\ncd\nef', cursor: 3})
    expect(moveCursor(entry, 'end')).to.deep.equal({text: 'ab\ncd\nef', cursor: 5})
    expect(moveCursor({text: 'hello', cursor: 2}, 'home').cursor).to.equal(0)
    expect(moveCursor({text: 'hello', cursor: 2}, 'end').cursor).to.equal(5)
  })

  it('pastes in the middle of the field', () => {
    const entry = {text: 'hello', cursor: 2}
    const next = applyEntryKey(entry, {name: 'v', ctrl: true}, {kind: 'single'}, () => 'XY')
    expect(next.handled).to.equal(true)
    expect(next.entry).to.deep.equal({text: 'heXYllo', cursor: 4})
    const meta = applyEntryKey(entry, {name: 'v', meta: true}, {kind: 'body'}, () => 'Z')
    expect(meta.entry).to.deep.equal({text: 'heZllo', cursor: 3})
  })

  it('strips newlines on single-line fields and keeps them in the body', () => {
    const entry = {text: 'hello', cursor: 5}
    expect(insertText(entry, 'a\r\nb', 'single')).to.deep.equal({text: 'helloab', cursor: 7})
    expect(insertText(entry, 'a\r\nb', 'body')).to.deep.equal({text: 'helloa\nb', cursor: 8})
    const pasted = applyEntryKey({text: 'ac', cursor: 1}, {name: 'v', ctrl: true}, {kind: 'single'}, () => 'b\nc')
    expect(pasted.entry).to.deep.equal({text: 'abcc', cursor: 3})
    const body = applyEntryKey({text: 'ac', cursor: 1}, {name: 'V', super: true}, {kind: 'body'}, () => 'b\nc')
    expect(body.entry).to.deep.equal({text: 'ab\ncc', cursor: 4})
  })

  it('leaves the cursor unchanged when a submit fails', () => {
    const entry = createTextEntry('owner/repo')
    entry.cursor = 3
    const failed = recordFailedSubmit(entry, 'clone failed')
    expect(failed.entry).to.equal(entry)
    expect(failed.entry.cursor).to.equal(3)
    expect(failed.entry.text).to.equal('owner/repo')
    expect(failed.error).to.equal('clone failed')
    const blocked = insertText(entry, 'x', 'single', entry.text.length)
    expect(blocked).to.equal(entry)
    expect(blocked.cursor).to.equal(3)
  })

  it('edits through key names without resetting a failed field', () => {
    let entry = {text: 'ab', cursor: 1}
    entry = applyEntryKey(entry, {name: 'left'}, {kind: 'single'}, () => '').entry
    entry = applyEntryKey(entry, {name: 'c', sequence: 'c'}, {kind: 'single'}, () => '').entry
    entry = applyEntryKey(entry, {name: 'end'}, {kind: 'single'}, () => '').entry
    entry = applyEntryKey(entry, {name: 'backspace'}, {kind: 'single'}, () => '').entry
    expect(entry).to.deep.equal({text: 'ca', cursor: 2})
    const failed = recordFailedSubmit(entry, 'nope')
    const moved = applyEntryKey(failed.entry, {name: 'home'}, {kind: 'single'}, () => {
      throw new Error('clipboard down')
    })
    expect(moved.entry).to.deep.equal({text: 'ca', cursor: 0})
    expect(failed.entry).to.equal(entry)
    expect(failed.entry.cursor).to.equal(2)
  })

  it('keeps the cursor on screen and clips a long error', () => {
    const shown = previewField({text: 'abcdefghijklmnopqrstuvwxyz', cursor: 10}, {
      multiline: false,
      columns: 5,
      showCursor: true,
    })
    expect(shown).to.include('_')
    expect(shown.length).to.equal(5)
    const body = previewField({text: 'one\ntwo\nthree', cursor: 5}, {
      multiline: true,
      columns: 10,
      maxLines: 3,
      showCursor: true,
    })
    expect(body).to.include('t_wo')
    const clipped = clipFieldError('abcdefghij\nsecond', 4, 2)
    expect(clipped.split('\n')).to.have.length(2)
    expect(clipped.startsWith('abcd')).to.equal(true)
    expect(clipped.endsWith('...')).to.equal(true)
  })
})
