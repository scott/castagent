import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the list helper and run that JavaScript instead.
function loadList(): {
  truncateSkillDescription: (description: string, limit?: number) => string
  sortBuilderSkillRows: <T extends {name: string}>(rows: readonly T[]) => T[]
  wrapSkillIndex: (index: number, delta: number, length: number) => number
  formatBuilderSkillRow: (row: {name: string; description: string}, selected: boolean) => string
  formatBuilderSkillRows: (rows: Array<{name: string; description: string}>, selectedIndex: number) => string[]
  classifyBuilderSkillAddSource: (source: string, directoryExists: boolean) => 'folder' | 'github' | 'invalid'
  parseGithubSkillSource: (input: string) => {owner: string; repo: string; ref?: string; subpath?: string} | null
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/builder-skills-list.ts')
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

describe('builder skills list formatting', () => {
  const {
    truncateSkillDescription,
    sortBuilderSkillRows,
    wrapSkillIndex,
    formatBuilderSkillRow,
    formatBuilderSkillRows,
    classifyBuilderSkillAddSource,
    parseGithubSkillSource,
  } = loadList()

  it('sorts alphabetically, marks the selection, and does not number rows', () => {
    const rows = [
      {name: 'zeta', description: 'Last skill'},
      {name: 'alpha', description: 'First skill'},
      {name: 'mid', description: 'Middle skill'},
    ]
    const lines = formatBuilderSkillRows(rows, 1)
    expect(lines).to.deep.equal([
      '  alpha  First skill',
      '▸ mid  Middle skill',
      '  zeta  Last skill',
    ])
    for (const line of lines) {
      expect(line).to.not.match(/^\s*\d+[\.\)]/)
    }
    expect(formatBuilderSkillRow({name: 'alpha', description: ''}, true)).to.equal('▸ alpha')
    expect(formatBuilderSkillRow({name: 'alpha', description: ''}, false)).to.equal('  alpha')
    expect(sortBuilderSkillRows(rows).map((row) => row.name)).to.deep.equal(['alpha', 'mid', 'zeta'])
    expect(rows.map((row) => row.name)).to.deep.equal(['zeta', 'alpha', 'mid'])
  })

  it('truncates descriptions to 50 characters', () => {
    expect(truncateSkillDescription('a'.repeat(50))).to.equal('a'.repeat(50))
    expect(truncateSkillDescription('a'.repeat(51))).to.equal('a'.repeat(47) + '...')
    const lines = formatBuilderSkillRows([{name: 'long', description: 'b'.repeat(60)}], 0)
    expect(lines[0]).to.equal(`▸ long  ${'b'.repeat(47)}...`)
  })

  it('wraps the selection index', () => {
    expect(wrapSkillIndex(0, -1, 3)).to.equal(2)
    expect(wrapSkillIndex(2, 1, 3)).to.equal(0)
    expect(wrapSkillIndex(1, 1, 3)).to.equal(2)
    expect(wrapSkillIndex(0, 1, 0)).to.equal(0)
  })

  it('classifies an add source as a folder, a GitHub repo, or neither', () => {
    expect(classifyBuilderSkillAddSource('owner/repo', true)).to.equal('folder')
    expect(classifyBuilderSkillAddSource('owner/repo', false)).to.equal('github')
    expect(classifyBuilderSkillAddSource('https://github.com/owner/repo/tree/main/skills/tool', false)).to.equal('github')
    expect(parseGithubSkillSource('owner/repo@dev')).to.deep.equal({owner: 'owner', repo: 'repo', ref: 'dev'})
    expect(classifyBuilderSkillAddSource('write it in the modal', false)).to.equal('invalid')
  })
})
