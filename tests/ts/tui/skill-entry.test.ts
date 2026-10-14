import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

function loadTsModule(file: string, cache = new Map<string, any>()): any {
  const resolved = path.resolve(file)
  const cached = cache.get(resolved)
  if (cached) return cached
  const source = fs.readFileSync(resolved, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {} as any}
  const dirname = path.dirname(resolved)
  function localRequire(id: string) {
    if (!id.startsWith('.')) return require(id)
    const target = path.resolve(dirname, id)
    const candidates = [target, `${target}.ts`, target.replace(/\.js$/, '.ts')]
    const hit = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    if (!hit) throw new Error(`cannot resolve ${id} from ${resolved}`)
    return loadTsModule(hit, cache)
  }
  const sandbox: any = {
    exports: module.exports,
    module,
    require: localRequire,
    __dirname: dirname,
    __filename: resolved,
    console,
    process,
  }
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox, {filename: resolved})
  cache.set(resolved, module.exports)
  return module.exports
}

const helper = loadTsModule(path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/skill-entry.ts'))
const lists = loadTsModule(path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/skill-list.ts'))

const INVALID_NAME = "Skill name '' is invalid. Names must match [a-z0-9][a-z0-9-]*."

function typeText(draft: any, text: string): any {
  let current = draft
  for (const ch of text) {
    const effect = helper.applySkillEntryKey(current, {name: ch, sequence: ch}, () => '')
    expect(effect.type).to.equal('draft')
    current = effect.draft
  }
  return current
}

function rowText(lines: Array<{text: string}>, label: string): string {
  const index = lines.findIndex((line) => line.text.trim() === label)
  expect(index).to.be.at.least(0)
  return lines[index + 1].text.trimEnd()
}

describe('tui skill entry form', () => {
  const modal = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/skills-modal.ts'),
    'utf8',
  )

  it('opens the inline form on Name after 3 then Enter', () => {
    const highlighted = lists.sourceListAction('3', 0, lists.ADD_SOURCE_LABELS.length)
    expect(highlighted).to.deep.equal({type: 'move', index: 2})
    expect(lists.ADD_SOURCE_LABELS[highlighted.index]).to.equal('Enter a skill in this modal')
    const opened = lists.sourceListAction('enter', highlighted.index, lists.ADD_SOURCE_LABELS.length)
    expect(opened).to.deep.equal({type: 'open', index: 2})

    const draft = helper.createSkillEntryDraft()
    expect(draft.field).to.equal('name')
    const lines = helper.buildSkillEntryLines({draft, columns: 66, termHeight: 24})
    expect(rowText(lines, 'Name')).to.equal('_')
    expect(rowText(lines, 'Description')).to.equal('')
    expect(lines.filter((line: {tone: string}) => line.tone === 'error')).to.have.length(0)
  })

  it('keeps typed name, description, and body on their own fields', () => {
    let draft = helper.createSkillEntryDraft()
    draft = typeText(draft, 'bb-tuiskill')
    let effect = helper.applySkillEntryKey(draft, {name: 'tab'}, () => '')
    draft = effect.draft
    expect(draft.field).to.equal('description')
    draft = typeText(draft, 'tui desc')
    effect = helper.applySkillEntryKey(draft, {name: 'tab'}, () => '')
    draft = effect.draft
    expect(draft.field).to.equal('body')
    draft = typeText(draft, 'BBMARKER4')
    effect = helper.applySkillEntryKey(draft, {name: 's', ctrl: true}, () => '')
    expect(effect.type).to.equal('submit')
    expect(effect.draft.name.text).to.equal('bb-tuiskill')
    expect(effect.draft.description.text).to.equal('tui desc')
    expect(effect.draft.body.text).to.equal('BBMARKER4')

    const lines = helper.buildSkillEntryLines({draft, columns: 66, termHeight: 24})
    expect(rowText(lines, 'Name')).to.equal('bb-tuiskill')
    expect(rowText(lines, 'Description')).to.equal('tui desc')
    expect(rowText(lines, 'Body')).to.equal('BBMARKER4_')
    const joined = lines.map((line: {text: string}) => line.text.trimEnd()).join('\n')
    const nameAt = joined.indexOf('Name')
    const nameValueAt = joined.indexOf('bb-tuiskill')
    const descriptionAt = joined.indexOf('Description')
    const descriptionValueAt = joined.indexOf('tui desc')
    const bodyAt = joined.indexOf('Body')
    const bodyValueAt = joined.indexOf('BBMARKER4_')
    expect(nameAt).to.be.lessThan(nameValueAt)
    expect(nameValueAt).to.be.lessThan(descriptionAt)
    expect(descriptionAt).to.be.lessThan(descriptionValueAt)
    expect(descriptionValueAt).to.be.lessThan(bodyAt)
    expect(bodyAt).to.be.lessThan(bodyValueAt)
  })

  it('moves Shift+Tab back to Name and does not jump to Save', () => {
    let draft = helper.createSkillEntryDraft()
    draft = {...draft, field: 'description'}
    let effect = helper.applySkillEntryKey(draft, {name: 'tab', shift: true}, () => '')
    expect(effect.draft.field).to.equal('name')
    effect = helper.applySkillEntryKey(effect.draft, {name: 'tab', shift: true}, () => '')
    expect(effect.draft.field).to.equal('name')

    draft = {...helper.createSkillEntryDraft(), field: 'body'}
    effect = helper.applySkillEntryKey(draft, {name: 'tab', shift: true}, () => '')
    expect(effect.draft.field).to.equal('description')
    effect = helper.applySkillEntryKey({...draft, field: 'save'}, {name: 'tab', shift: true}, () => '')
    expect(effect.draft.field).to.equal('body')
  })

  it('pads the invalid-name error so the regex tail cannot stick to the line', () => {
    const draft = {...helper.createSkillEntryDraft(), field: 'save', error: INVALID_NAME}
    const wide = helper.buildSkillEntryLines({draft, columns: 66, termHeight: 24})
    const wideError = wide.filter((line: {tone: string}) => line.tone === 'error')
    expect(wideError).to.have.length(1)
    expect(wideError[0].text.length).to.equal(66)
    expect(wideError[0].text.trimEnd()).to.equal(INVALID_NAME)
    expect(wideError[0].text.slice(INVALID_NAME.length)).to.match(/^ +$/)

    const narrow = helper.buildSkillEntryLines({draft, columns: 49, termHeight: 24})
    const narrowError = narrow.filter((line: {tone: string}) => line.tone === 'error')
    expect(narrowError.length).to.be.greaterThan(1)
    for (const line of narrow) expect(line.text.length).to.equal(49)
    expect(narrowError[0].text.trimEnd()).to.equal(INVALID_NAME.slice(0, 49))
    expect(narrowError.map((line: {text: string}) => line.text.trimEnd()).join('')).to.equal(INVALID_NAME)
    expect(narrowError.map((line: {text: string}) => line.text.trimEnd()).join('')).to.not.include('*.9]')
  })

  it('gives every entry row a fixed height so fields cannot overlap', () => {
    expect(modal).to.include('sourceListAction')
    expect(modal).to.include('applySkillEntryKey')
    expect(modal).to.include('buildSkillEntryLines')
    expect(modal).to.include('height: 1')
    expect(modal).to.include("wrapMode: 'none'")
    expect(modal).to.include('flexShrink: 0')
    const lines = helper.buildSkillEntryLines({
      draft: helper.createSkillEntryDraft(),
      columns: 40,
      termHeight: 24,
    })
    expect(lines.length).to.be.at.most(helper.skillEntryInnerRows(24))
    for (const line of lines) expect(line.text.length).to.equal(40)
  })
})
