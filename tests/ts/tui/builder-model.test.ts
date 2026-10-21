import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM and imports @opentui/core. Transpile the pure helper only.
function loadHelper(): {
  isBuilderModelCommandVisible: (mode: 'dev' | 'production' | 'on-host') => boolean
  sortBuilderModels: <T extends {id: string}>(models: readonly T[]) => T[]
  initialBuilderModelIndex: (models: readonly {id: string}[], currentId: string, prefixes?: readonly string[]) => number
  wrapBuilderModelIndex: (index: number, delta: number, length: number) => number
  builderModelWindow: (length: number, selected: number, maxRows: number) => {start: number; end: number}
  isSameBuilderModel: (currentId: string, selectedId: string, prefixes?: readonly string[]) => boolean
  shouldApplyBuilderModel: (currentId: string, selectedId: string, prefixes?: readonly string[]) => boolean
  builderModelApplyArgv: (id: string) => string[]
  builderModelListArgv: () => string[]
  builderModelCurrentArgv: () => string[]
  formatBuilderModelRow: (id: string, selected: boolean, current: boolean) => string
  builderModelFocusReturnTarget: () => string
  builderModelSuccessMessage: (id: string, agentName: string) => string
  builderModelModalInnerRows: (termHeight: number) => number
  builderModelMaxRows: (termHeight: number, hasError?: boolean) => number
  builderModelContentColumns: (termWidth: number) => number
  fitBuilderModelLine: (text: string, columns: number) => string
  buildBuilderModelLines: (options: {
    models: readonly {id: string}[]
    selected: number
    currentId: string
    termHeight: number
    columns: number
    prefixes?: readonly string[]
    error?: string | null
  }) => Array<{text: string; tone: string}>
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

const PREFIXES = ['openrouter/', 'digitalocean/']

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
    const index = helper.initialBuilderModelIndex(models, 'openrouter/minimax/minimax-m2.5', PREFIXES)
    expect(models[index].id).to.equal('minimax/minimax-m2.5')
    expect(helper.isSameBuilderModel('openrouter/minimax/minimax-m2.5', 'minimax/minimax-m2.5', PREFIXES)).to.equal(true)
    expect(helper.shouldApplyBuilderModel('openrouter/minimax/minimax-m2.5', 'minimax/minimax-m2.5', PREFIXES)).to.equal(false)
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

  function catalogIds(): string[] {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-cli/src/lib/models.ts'),
      'utf8',
    )
    const start = source.indexOf('const MODEL_IDS = [')
    const end = source.indexOf(']', start)
    return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1])
  }

  function frame(ids: string[], selected: number, termHeight = 50, termWidth = 200, error: string | null = null) {
    const columns = helper.builderModelContentColumns(termWidth)
    const lines = helper.buildBuilderModelLines({
      models: ids.map(id => ({id})),
      selected,
      currentId: 'openrouter/minimax/minimax-m2.5',
      termHeight,
      columns,
      prefixes: PREFIXES,
      error,
    })
    return {columns, lines}
  }

  function highlighted(lines: Array<{text: string}>): string {
    const rows = lines.filter(line => line.text.startsWith('▸ '))
    expect(rows).to.have.length(1)
    return rows[0].text.trimEnd()
  }

  it('fits every catalog id on its own row while scrolling', () => {
    const ids = helper.sortBuilderModels(catalogIds().map(id => ({id}))).map(model => model.id)
    expect(ids).to.have.length(21)
    expect(ids).to.include('meta-llama/llama-3.1-70b-instruct')
    expect(ids).to.include('meta-llama/llama-3.1-8b-instruct')
    expect(ids).to.include('openai/gpt-4-turbo')
    expect(ids).to.include('cohere/command-r-plus-08-2024')
    expect(ids).to.include('minimax/minimax-m2.5')

    const termHeight = 50
    const inner = helper.builderModelModalInnerRows(termHeight)
    const maxRows = helper.builderModelMaxRows(termHeight, false)
    // The old budget reserved a fixed 6 rows from the outer 80% and
    // then forced at least 5. That is taller than the inner box, so
    // the rows flex-shrink onto each other.
    const oldMax = Math.max(5, Math.floor(termHeight * 0.8) - 6)
    expect(oldMax + 6).to.be.greaterThan(inner)
    expect(maxRows + 6).to.be.at.most(inner)

    const seen = new Set<string>()
    let previousStart = 0
    for (let selected = 0; selected < ids.length; selected++) {
      const {columns, lines} = frame(ids, selected, termHeight, 200)
      expect(lines.length).to.be.at.most(inner)
      for (const line of lines) {
        expect(line.text).to.have.length(columns)
        expect(line.text).to.not.include('instructnstruct')
      }
      const span = helper.builderModelWindow(ids.length, selected, maxRows)
      expect(span.end - span.start).to.equal(Math.min(maxRows, ids.length))
      expect(selected).to.be.at.least(span.start)
      expect(selected).to.be.below(span.end)
      expect(span.start - previousStart).to.be.at.most(1)
      previousStart = span.start

      const visible = ids.slice(span.start, span.end)
      for (const id of visible) {
        const row = helper.formatBuilderModelRow(id, id === ids[selected], id === 'minimax/minimax-m2.5')
        expect(lines.filter(line => line.text.trimEnd() === row)).to.have.length(1)
        seen.add(id)
      }
      expect(highlighted(lines)).to.equal(
        helper.formatBuilderModelRow(ids[selected], true, ids[selected] === 'minimax/minimax-m2.5'),
      )
    }
    expect([...seen].sort()).to.deep.equal([...ids].sort())

    const longer = ids.indexOf('meta-llama/llama-3.1-70b-instruct')
    const shorter = ids.indexOf('meta-llama/llama-3.1-8b-instruct')
    expect(shorter - longer).to.equal(1)
    const glued = frame(ids, shorter, termHeight, 200)
    const longerRow = helper.formatBuilderModelRow(ids[longer], false, false)
    const shorterRow = helper.formatBuilderModelRow(ids[shorter], true, false)
    expect(glued.lines.filter(line => line.text.trimEnd() === longerRow)).to.have.length(1)
    expect(glued.lines.filter(line => line.text.trimEnd() === shorterRow)).to.have.length(1)
    expect(helper.fitBuilderModelLine(shorterRow, glued.columns).length).to.be.at.least(longerRow.length)

    let selected = ids.indexOf('cohere/command-r7b-12-2024')
    const moved: string[] = []
    for (let press = 0; press < 3; press++) {
      selected = helper.wrapBuilderModelIndex(selected, -1, ids.length)
      const {lines} = frame(ids, selected)
      expect(highlighted(lines)).to.equal(helper.formatBuilderModelRow(ids[selected], true, false))
      moved.push(ids[selected])
    }
    expect(moved).to.deep.equal([
      'cohere/command-r-plus-08-2024',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.5',
    ])

    const withError = frame(ids, shorter, termHeight, 200, 'could not write config')
    expect(withError.lines.length).to.be.at.most(inner)
    expect(withError.lines.some(line => line.text.trimEnd() === 'could not write config')).to.equal(true)
    expect(highlighted(withError.lines)).to.equal(shorterRow)

    const modal = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/builder-model-modal.ts'),
      'utf8',
    )
    expect(modal).to.include('buildBuilderModelLines')
    expect(modal).to.not.include('Math.floor(height * 0.8) - 6')
    expect(modal).to.include("wrapMode: 'none'")
    expect(modal).to.include('flexShrink: 0')
    expect(modal).to.include('height: 1')
    expect(modal).to.include("overflow: 'hidden'")
  })

  it('returns focus to the input', () => {
    expect(helper.builderModelFocusReturnTarget()).to.equal('input')
    expect(helper.builderModelSuccessMessage('anthropic/claude-3.5-sonnet', 'email-assistant')).to.equal(
      'Builder model changed to anthropic/claude-3.5-sonnet.\nRestart the builder to apply: cast dev email-assistant',
    )
    expect(helper.CAST_CLI_NOT_FOUND).to.equal('cast CLI not found in PATH.')
  })
})
