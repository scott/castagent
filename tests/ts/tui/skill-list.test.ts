import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

function loadSkillList(): {
  sortSkillsByName: <T extends {name: string; subpath?: string}>(items: T[]) => T[]
  truncateDescription: (description: string, max?: number) => string
  formatSkillRow: (skill: {name: string; description: string}, selected: boolean) => string
  formatNumberedRow: (index: number, label: string, selected: boolean) => string
  wrapIndex: (index: number, delta: number, length: number) => number
  numberKeyIndex: (keyName: string | undefined, count: number) => number | null
  ADD_SOURCE_LABELS: string[]
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/skill-list.ts')
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

describe('skill list formatting', () => {
  const {
    sortSkillsByName,
    truncateDescription,
    formatSkillRow,
    formatNumberedRow,
    wrapIndex,
    numberKeyIndex,
    ADD_SOURCE_LABELS,
  } = loadSkillList()

  it('sorts skills alphabetically without mutating the input', () => {
    const input = [
      {name: 'zeta', description: 'Last'},
      {name: 'alpha', description: 'First'},
      {name: 'alpha', description: 'Other', subpath: 'b'},
      {name: 'alpha', description: 'Other', subpath: 'a'},
    ]
    const sorted = sortSkillsByName(input)
    expect(sorted.map((skill) => `${skill.name}:${skill.subpath ?? ''}`)).to.deep.equal([
      'alpha:',
      'alpha:a',
      'alpha:b',
      'zeta:',
    ])
    expect(input[0].name).to.equal('zeta')
  })

  it('prefixes the selected row with ▸ and the others with two spaces', () => {
    expect(formatSkillRow({name: 'triage', description: 'Sort mail'}, true)).to.equal('▸ triage  Sort mail')
    expect(formatSkillRow({name: 'triage', description: 'Sort mail'}, false)).to.equal('  triage  Sort mail')
    expect(formatSkillRow({name: 'triage', description: 'Sort mail'}, true).startsWith('▸ ')).to.equal(true)
    expect(formatSkillRow({name: 'triage', description: 'Sort mail'}, false).startsWith('  ')).to.equal(true)
  })

  it('truncates a one-line description at 50 characters', () => {
    expect(truncateDescription('short')).to.equal('short')
    expect(truncateDescription('a'.repeat(50))).to.equal('a'.repeat(50))
    expect(truncateDescription('a'.repeat(51))).to.equal(`${'a'.repeat(47)}...`)
    expect(truncateDescription('line one\nline two continues past the limit of fifty characters')).to.equal(
      'line one line two continues past the limit of f...',
    )
    const row = formatSkillRow({name: 'triage', description: 'a'.repeat(51)}, false)
    expect(row).to.equal(`  triage  ${'a'.repeat(47)}...`)
  })

  it('wraps the selected index with modulo', () => {
    expect(wrapIndex(0, -1, 3)).to.equal(2)
    expect(wrapIndex(2, 1, 3)).to.equal(0)
    expect(wrapIndex(1, 1, 3)).to.equal(2)
    expect(wrapIndex(0, 1, 0)).to.equal(0)
  })

  it('maps number keys for the source list', () => {
    expect(ADD_SOURCE_LABELS).to.deep.equal([
      'GitHub repository',
      'Folder on this machine',
      'Enter a skill in this modal',
    ])
    expect(numberKeyIndex('1', 3)).to.equal(0)
    expect(numberKeyIndex('3', 3)).to.equal(2)
    expect(numberKeyIndex('4', 3)).to.equal(null)
    expect(formatNumberedRow(0, ADD_SOURCE_LABELS[0], true)).to.equal('▸ 1. GitHub repository')
    expect(formatNumberedRow(1, ADD_SOURCE_LABELS[1], false)).to.equal('  2. Folder on this machine')
  })
})
