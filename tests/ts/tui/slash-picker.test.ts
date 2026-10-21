import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module that imports @opentui/core, so Mocha's CJS loader
// cannot import the picker or the slash registry. Transpile the pure helper
// and read command metadata from the registry source instead.

type SlashUiMode = 'dev' | 'production' | 'on-host'
type SlashPickerCategory = 'chat' | 'agent' | 'session' | 'git'

interface SlashPickerCommand {
  name: string
  description: string
  category: SlashPickerCategory
  args?: string
  modes?: readonly SlashUiMode[]
}

type SlashPickerRow<T extends SlashPickerCommand = SlashPickerCommand> =
  | {kind: 'header'; category: SlashPickerCategory; label: string}
  | {kind: 'command'; command: T}

interface SlashPickerApi {
  commandVisibleInMode: (
    command: {modes?: readonly SlashUiMode[] | undefined},
    mode: SlashUiMode,
  ) => boolean
  groupSlashCommands: <T extends SlashPickerCommand>(
    commands: readonly T[],
    query?: string,
  ) => SlashPickerRow<T>[]
  moveSlashSelection: (commandCount: number, index: number, delta: number) => number
  formatSlashHelp: (commands: readonly SlashPickerCommand[]) => string
}

function loadSlashPicker(): SlashPickerApi {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/slash-picker.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as SlashPickerApi}
  const sandbox = {exports: module.exports, module, require}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

interface RegistryCommand extends SlashPickerCommand {
  modes?: SlashUiMode[]
}

const CATEGORIES: readonly SlashPickerCategory[] = ['chat', 'agent', 'session', 'git']
const MODES: readonly SlashUiMode[] = ['dev', 'production', 'on-host']

function readString(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  throw new Error(`expected string literal, got ${ts.SyntaxKind[expr.kind]}`)
}

function loadRegistryCommands(): RegistryCommand[] {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts')
  const source = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: RegistryCommand[] = []

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'commands' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) {
          throw new Error('slash command element is not an object literal')
        }
        const cmd: Partial<RegistryCommand> = {}
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop) || !prop.initializer) continue
          const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
          if (key === 'name') cmd.name = readString(prop.initializer)
          else if (key === 'description') cmd.description = readString(prop.initializer)
          else if (key === 'category') {
            const category = readString(prop.initializer)
            if (!CATEGORIES.includes(category as SlashPickerCategory)) {
              throw new Error(`unknown category ${category}`)
            }
            cmd.category = category as SlashPickerCategory
          } else if (key === 'args') cmd.args = readString(prop.initializer)
          else if (key === 'modes') {
            if (!ts.isArrayLiteralExpression(prop.initializer)) throw new Error('modes is not an array')
            cmd.modes = prop.initializer.elements.map((element) => {
              const mode = readString(element)
              if (!MODES.includes(mode as SlashUiMode)) throw new Error(`unknown mode ${mode}`)
              return mode as SlashUiMode
            })
          }
        }
        if (!cmd.name || !cmd.description || !cmd.category) {
          throw new Error(`incomplete slash command: ${JSON.stringify(cmd)}`)
        }
        found.push(cmd as RegistryCommand)
      }
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  if (found.length === 0) throw new Error('did not find const commands in slash-registry.ts')
  return found
}

function isCommandRow<T extends SlashPickerCommand>(
  row: SlashPickerRow<T>,
): row is Extract<SlashPickerRow<T>, {kind: 'command'}> {
  return row.kind === 'command'
}

function namesOf<T extends SlashPickerCommand>(rows: readonly SlashPickerRow<T>[]): string[] {
  return rows.filter(isCommandRow).map((row) => row.command.name)
}

function labelsOf<T extends SlashPickerCommand>(rows: readonly SlashPickerRow<T>[]): string[] {
  return rows.filter((row) => row.kind === 'header').map((row) => row.label)
}

function rowText<T extends SlashPickerCommand>(row: SlashPickerRow<T>): string {
  if (row.kind === 'header') return row.label
  return row.command.name
}

const shuffled: SlashPickerCommand[] = [
  {name: 'quit', description: 'Exit the TUI', category: 'session'},
  {name: 'git', description: 'Git operations for the current agent', category: 'git'},
  {name: 'mode?', description: 'Show current mode', category: 'chat'},
  {name: 'help', description: 'Show all available slash commands', category: 'chat'},
  {name: 'deploy', description: 'Deploy the current agent', category: 'agent'},
  {name: 'clear', description: 'Clear all messages from the chat', category: 'chat'},
  {name: 'describe', description: 'Show details for the current agent', category: 'agent'},
  {name: 'copy', description: 'Copy the last agent response to clipboard', category: 'chat'},
  {name: 'connect', description: 'Connect to a different agent', category: 'session'},
  {name: 'mode', description: 'Toggle or set plan/build mode', category: 'chat', args: '[plan|build]'},
]

describe('slash picker rows', () => {
  const {
    commandVisibleInMode,
    groupSlashCommands,
    moveSlashSelection,
    formatSlashHelp,
  } = loadSlashPicker()

  describe('commandVisibleInMode', () => {
    const devOnly = {modes: ['dev'] as const}
    const devAndProduction = {modes: ['dev', 'production'] as const}

    it('treats a missing modes list as visible in every UI mode', () => {
      expect(commandVisibleInMode({}, 'dev')).to.equal(true)
      expect(commandVisibleInMode({}, 'production')).to.equal(true)
      expect(commandVisibleInMode({}, 'on-host')).to.equal(true)
    })

    it('hides dev-only commands outside dev', () => {
      expect(commandVisibleInMode(devOnly, 'dev')).to.equal(true)
      expect(commandVisibleInMode(devOnly, 'production')).to.equal(false)
      expect(commandVisibleInMode(devOnly, 'on-host')).to.equal(false)
    })

    it('hides dev and production commands on-host', () => {
      expect(commandVisibleInMode(devAndProduction, 'dev')).to.equal(true)
      expect(commandVisibleInMode(devAndProduction, 'production')).to.equal(true)
      expect(commandVisibleInMode(devAndProduction, 'on-host')).to.equal(false)
    })
  })

  describe('groupSlashCommands', () => {
    it('orders categories and alphabetizes names inside each one', () => {
      const rows = groupSlashCommands(shuffled)
      expect(labelsOf(rows)).to.deep.equal(['Chat', 'Agent', 'Session', 'Git'])
      expect(namesOf(rows)).to.deep.equal([
        'clear', 'copy', 'help', 'mode', 'mode?',
        'deploy', 'describe',
        'connect', 'quit',
        'git',
      ])
      expect(namesOf(rows).indexOf('mode')).to.be.lessThan(namesOf(rows).indexOf('mode?'))
    })

    it('does not mutate the input order', () => {
      const input = shuffled.map((command) => ({...command}))
      const before = input.map((command) => command.name)
      groupSlashCommands(input)
      expect(input.map((command) => command.name)).to.deep.equal(before)
    })

    it('omits empty categories', () => {
      const withoutGit = shuffled.filter((command) => command.category !== 'git')
      const rows = groupSlashCommands(withoutGit)
      expect(labelsOf(rows)).to.deep.equal(['Chat', 'Agent', 'Session'])
      expect(rows.some((row) => row.kind === 'header' && row.label === 'Git')).to.equal(false)
    })

    it('drops Chat for prefix s when nothing in Chat matches', () => {
      const rows = groupSlashCommands(shuffled, 's')
      expect(labelsOf(rows)).to.deep.equal([])
      expect(namesOf(rows)).to.deep.equal([])

      const withSession = shuffled.concat([
        {name: 'session', description: 'Start or resume a session', category: 'session'},
        {name: 'skills', description: 'Add or remove skills on this agent', category: 'agent'},
      ])
      const matched = groupSlashCommands(withSession, 's')
      expect(labelsOf(matched)).to.deep.equal(['Agent', 'Session'])
      expect(namesOf(matched)).to.deep.equal(['skills', 'session'])
      expect(matched.some((row) => row.kind === 'header' && row.category === 'chat')).to.equal(false)
    })

    it('matches prefixes without regard to case', () => {
      expect(namesOf(groupSlashCommands(shuffled, 'H'))).to.deep.equal(['help'])
      expect(namesOf(groupSlashCommands(shuffled, 'MO'))).to.deep.equal(['mode', 'mode?'])
    })

    it('returns no rows when nothing matches', () => {
      expect(groupSlashCommands(shuffled, 'zzz')).to.deep.equal([])
    })

    it('wraps selection among commands and skips headers', () => {
      const rows = groupSlashCommands(shuffled)
      const selectable = rows.flatMap((row, index) => row.kind === 'command' ? [index] : [])
      expect(rows[0].kind).to.equal('header')
      expect(selectable.length).to.equal(namesOf(rows).length)
      expect(selectable.length).to.be.lessThan(rows.length)
      for (let i = 0; i < selectable.length; i++) {
        expect(rows[selectable[i]].kind).to.equal('command')
        const next = selectable[moveSlashSelection(selectable.length, i, 1)]
        const prev = selectable[moveSlashSelection(selectable.length, i, -1)]
        expect(rows[next].kind).to.equal('command')
        expect(rows[prev].kind).to.equal('command')
      }
      expect(moveSlashSelection(selectable.length, 0, -1)).to.equal(selectable.length - 1)
      expect(moveSlashSelection(selectable.length, selectable.length - 1, 1)).to.equal(0)
      expect(moveSlashSelection(0, 0, 1)).to.equal(0)
    })

    it('formats help in the same order, including args', () => {
      const text = formatSlashHelp(shuffled)
      expect(text.indexOf('Chat:')).to.be.lessThan(text.indexOf('Agent:'))
      expect(text.indexOf('Agent:')).to.be.lessThan(text.indexOf('Session:'))
      expect(text.indexOf('Session:')).to.be.lessThan(text.indexOf('Git:'))
      expect(text.indexOf('  /clear - ')).to.be.lessThan(text.indexOf('  /mode [plan|build] - '))
      expect(text.indexOf('  /mode [plan|build] - ')).to.be.lessThan(text.indexOf('  /mode? - '))
      expect(text).to.contain('  /mode [plan|build] - Toggle or set plan/build mode')
    })
  })

  describe('registry mode contract', () => {
    const registry = loadRegistryCommands()
    const visible = (mode: SlashUiMode) => registry.filter((command) => commandVisibleInMode(command, mode))

    it('leaves only help, clear, copy, quit, and exit unrestricted', () => {
      const unrestricted = registry.filter((command) => !command.modes).map((command) => command.name).sort()
      expect(unrestricted).to.deep.equal(['clear', 'copy', 'exit', 'help', 'quit'])
    })

    it('keeps undo, redo, model, and builder-skills dev-only', () => {
      const devOnly = registry
        .filter((command) => command.modes?.length === 1 && command.modes[0] === 'dev')
        .map((command) => command.name)
        .sort((a, b) => a.localeCompare(b))
      expect(devOnly).to.deep.equal(['builder-skills', 'model', 'provider', 'redo', 'undo'])
    })

    it('limits /session and /sessions to dev and production', () => {
      for (const name of ['session', 'sessions']) {
        const command = registry.find((candidate) => candidate.name === name)
        expect(command, name).to.not.equal(undefined)
        expect(command?.modes).to.deep.equal(['dev', 'production'])
      }
    })

    it('lists every dev command, with dev-only names under Agent in alphabetical order', () => {
      const rows = groupSlashCommands(visible('dev'))
      expect(labelsOf(rows)).to.deep.equal(['Chat', 'Agent', 'Session', 'Git'])
      const agentNames = rows
        .filter(isCommandRow)
        .filter((row) => row.command.category === 'agent')
        .map((row) => row.command.name)
      expect(agentNames).to.deep.equal(
        visible('dev')
          .filter((command) => command.category === 'agent')
          .map((command) => command.name)
          .sort((a, b) => a.localeCompare(b)),
      )
      expect(agentNames).to.include.members(['builder-skills', 'model', 'provider', 'redo', 'undo'])
      const agentHeader = rows.findIndex((row) => row.kind === 'header' && row.label === 'Agent')
      expect(agentHeader).to.be.greaterThan(-1)
      expect(rows[agentHeader].kind).to.equal('header')
      expect(rows[agentHeader + 1].kind).to.equal('command')
      for (const name of ['builder-skills', 'model', 'provider', 'redo', 'undo']) {
        const index = rows.findIndex((row) => isCommandRow(row) && row.command.name === name)
        expect(rows[index].kind).to.equal('command')
        expect(index).to.be.greaterThan(agentHeader)
      }
    })

    it('hides the four dev-only commands in production and keeps import, deploy, shutdown, sessions, and session', () => {
      const rows = groupSlashCommands(visible('production'))
      const names = namesOf(rows)
      expect(names).to.include.members(['import', 'deploy', 'shutdown', 'sessions', 'session'])
      expect(names).to.not.include.members(['undo', 'redo', 'model', 'provider', 'builder-skills'])
      expect(labelsOf(rows)).to.deep.equal(['Chat', 'Agent', 'Session', 'Git'])
    })

    it('lists only Chat and Session commands on-host', () => {
      const rows = groupSlashCommands(visible('on-host'))
      expect(rows.map(rowText)).to.deep.equal([
        'Chat',
        'clear',
        'copy',
        'help',
        'Session',
        'exit',
        'quit',
      ])
      expect(labelsOf(rows)).to.not.include('Agent')
      expect(labelsOf(rows)).to.not.include('Git')
      expect(namesOf(rows)).to.not.include('session')
      expect(namesOf(rows)).to.not.include('sessions')
    })

    it('drops Chat for prefix s in dev', () => {
      const rows = groupSlashCommands(visible('dev'), 's')
      expect(labelsOf(rows)).to.deep.equal(['Agent', 'Session'])
      expect(namesOf(rows)).to.deep.equal([
        'shutdown', 'skills', 'stop',
        'save', 'session', 'sessions',
      ])
      expect(rows.some((row) => row.kind === 'command' && row.command.category === 'chat')).to.equal(false)
    })

    it('prints the same on-host list from /help', () => {
      const text = formatSlashHelp(visible('on-host'))
      expect(text).to.equal([
        'Available commands:',
        '',
        'Chat:',
        '  /clear - Clear all messages from the chat',
        '  /copy - Copy the last agent response to clipboard',
        '  /help - Show all available slash commands',
        '',
        'Session:',
        '  /exit - Exit the TUI',
        '  /quit - Exit the TUI',
        '',
      ].join('\n'))
      expect(text).to.not.contain('On-host commands')
      expect(text).to.not.contain('/session')
    })
  })
})
