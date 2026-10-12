import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM and imports @opentui/core. Transpile the pure helper only.
function loadHelper(): {
  isBuilderModelCommandVisible: (mode: 'dev' | 'production' | 'on-host') => boolean
  sortBuilderModels: <T extends {id: string}>(models: readonly T[]) => T[]
  initialBuilderModelIndex: (models: readonly {id: string}[], currentId: string) => number
  wrapBuilderModelIndex: (index: number, delta: number, length: number) => number
  builderModelWindow: (length: number, selected: number, maxRows: number) => {start: number; end: number}
  isSameBuilderModel: (currentId: string, selectedId: string) => boolean
  shouldApplyBuilderModel: (currentId: string, selectedId: string) => boolean
  builderModelApplyArgv: (id: string) => string[]
  builderModelListArgv: () => string[]
  builderModelCurrentArgv: () => string[]
  formatBuilderModelRow: (id: string, selected: boolean, current: boolean) => string
  builderModelFocusReturnTarget: () => string
  builderModelSuccessMessage: (id: string, agentName: string) => string
  CAST_CLI_NOT_FOUND: string
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/builder-model.ts')
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

describe('builder model picker', () => {
  const helper = loadHelper()

  it('shows /model only in dev mode', () => {
    expect(helper.isBuilderModelCommandVisible('dev')).to.equal(true)
    expect(helper.isBuilderModelCommandVisible('production')).to.equal(false)
    expect(helper.isBuilderModelCommandVisible('on-host')).to.equal(false)

    const registry = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    const command = registry.slice(registry.indexOf("name: 'model'"))
    expect(command.slice(0, command.indexOf('handler'))).to.match(/modes: \['dev'\]/)
    expect(command.slice(0, command.indexOf('handler'))).to.not.include('production')
    expect(command.slice(0, command.indexOf('handler'))).to.not.include('on-host')
  })

  it('sorts models alphabetically by full id', () => {
    const sorted = helper.sortBuilderModels([
      {id: 'openrouter/openai/gpt-4o'},
      {id: 'anthropic/claude-3.5-sonnet'},
      {id: 'minimax/minimax-m2.5'},
    ])
    expect(sorted.map(model => model.id)).to.deep.equal([
      'anthropic/claude-3.5-sonnet',
      'minimax/minimax-m2.5',
      'openrouter/openai/gpt-4o',
    ])
  })

  it('selects the catalog row for a stored openrouter id and keeps it on screen', () => {
    const models = [
      {id: 'anthropic/claude-3-haiku'},
      {id: 'google/gemini-2.5-pro'},
      {id: 'minimax/minimax-m2.5'},
      {id: 'openai/gpt-4o'},
    ]
    const index = helper.initialBuilderModelIndex(models, 'openrouter/minimax/minimax-m2.5')
    expect(models[index].id).to.equal('minimax/minimax-m2.5')
    expect(helper.isSameBuilderModel('openrouter/minimax/minimax-m2.5', 'minimax/minimax-m2.5')).to.equal(true)
    expect(helper.shouldApplyBuilderModel('openrouter/minimax/minimax-m2.5', 'minimax/minimax-m2.5')).to.equal(false)
    const window = helper.builderModelWindow(models.length, index, 2)
    expect(window.start).to.be.at.most(index)
    expect(window.end).to.be.greaterThan(index)
    expect(window.end - window.start).to.equal(2)
  })

  it('does not apply when the selected row is already current', () => {
    const models = helper.sortBuilderModels([
      {id: 'minimax/minimax-m2.5'},
      {id: 'anthropic/claude-3.5-sonnet'},
    ])
    const current = 'anthropic/claude-3.5-sonnet'
    const index = helper.initialBuilderModelIndex(models, current)
    expect(models[index].id).to.equal(current)
    expect(helper.shouldApplyBuilderModel(current, models[index].id)).to.equal(false)
    expect(helper.shouldApplyBuilderModel(current, 'minimax/minimax-m2.5')).to.equal(true)
    expect(helper.formatBuilderModelRow(current, true, true)).to.equal(`▸ ${current}  (current)`)
    expect(helper.formatBuilderModelRow('minimax/minimax-m2.5', false, false)).to.equal('  minimax/minimax-m2.5')
  })

  it('builds cast model <id> argv for apply', () => {
    expect(helper.builderModelApplyArgv('anthropic/claude-3.5-sonnet')).to.deep.equal([
      'model',
      'anthropic/claude-3.5-sonnet',
    ])
    expect(helper.builderModelListArgv()).to.deep.equal(['model', '--list', '--json'])
    expect(helper.builderModelCurrentArgv()).to.deep.equal(['model', '--current', '--json'])
  })

  it('wraps the selection index', () => {
    expect(helper.wrapBuilderModelIndex(0, -1, 3)).to.equal(2)
    expect(helper.wrapBuilderModelIndex(2, 1, 3)).to.equal(0)
    expect(helper.wrapBuilderModelIndex(1, 1, 3)).to.equal(2)
  })

  it('returns focus to the input', () => {
    expect(helper.builderModelFocusReturnTarget()).to.equal('input')
    expect(helper.builderModelSuccessMessage('anthropic/claude-3.5-sonnet', 'email-assistant')).to.equal(
      'Builder model changed to anthropic/claude-3.5-sonnet.\nRestart the builder to apply: cast dev email-assistant',
    )
    expect(helper.CAST_CLI_NOT_FOUND).to.equal('cast CLI not found in PATH.')
  })
})
