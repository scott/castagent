import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the import-command decisions and run that JavaScript instead.
function loadImportCommand(): typeof import('../../../typescript/cast-tui/src/lib/import-command') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/import-command.ts')
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

describe('/import command decisions', () => {
  const {
    formatImportSuccess,
    handleImportCommand,
    importModalSpec,
    initialImportModalFields,
    mapImportError,
    planImportInvocation,
    reduceImportModal,
  } = loadImportCommand()

  function host(overrides: Partial<{
    importAgent: (source: string, options: {name?: string}) => Promise<{name: string}>
    openModal: (spec: ReturnType<typeof importModalSpec>) => Promise<
      | {type: 'submit'; source: string; name?: string}
      | {type: 'cancel'; focus: 'input'}
    >
  }> = {}) {
    const calls: Array<{source: string; options: {name?: string}}> = []
    const messages: string[] = []
    const modals: Array<ReturnType<typeof importModalSpec>> = []
    return {
      calls,
      messages,
      modals,
      importAgent: overrides.importAgent ?? (async (source: string, options: {name?: string}) => {
        calls.push({source, options})
        return {name: options.name || 'derived'}
      }),
      openModal: overrides.openModal ?? (async (spec: ReturnType<typeof importModalSpec>) => {
        modals.push(spec)
        return {type: 'cancel' as const, focus: spec.focusOnClose}
      }),
      addAgentMessage: (text: string) => {
        messages.push(text)
      },
    }
  }

  it('requests the modal when /import has no args', async () => {
    const ui = host()
    const plan = planImportInvocation([])
    expect(plan).to.deep.equal({type: 'modal'})

    await handleImportCommand([], ui)
    expect(ui.modals).to.have.length(1)
    const spec = ui.modals[0]
    expect(spec.title).to.equal('Import Cast Agent')
    expect(spec.footer).to.equal('Enter Submit  ESC Close')
    expect(spec.width).to.equal('90%')
    expect(spec.height).to.equal('80%')
    expect(spec.centered).to.equal(true)
    expect(spec.overlay).to.equal(true)
    expect(spec.focusOnClose).to.equal('input')
    expect(spec.fields.map((field) => field.placeholder)).to.deep.equal([
      'GitHub URL, user/repo, or local path',
      'Local agent name (leave blank to use default)',
    ])
    expect(spec.fields[0].required).to.equal(true)
    expect(spec.fields[1].required).to.equal(false)
    expect(ui.calls).to.deep.equal([])
    expect(ui.messages).to.deep.equal([])
  })

  it('submits typed fields to import with the source and name', async () => {
    let fields = initialImportModalFields()
    expect(fields).to.deep.equal({source: '', name: '', active: 'source'})

    for (const ch of 'acme/widget') {
      const next = reduceImportModal(fields, {name: ch})
      expect(next.type).to.equal('update')
      if (next.type === 'update') fields = next.fields
    }
    const switched = reduceImportModal(fields, {name: 'tab'})
    expect(switched.type).to.equal('update')
    if (switched.type === 'update') fields = switched.fields
    expect(fields.active).to.equal('name')
    for (const ch of 'widget-local') {
      const next = reduceImportModal(fields, {name: ch})
      if (next.type === 'update') fields = next.fields
    }
    const submitted = reduceImportModal(fields, {name: 'enter'})
    expect(submitted).to.deep.equal({type: 'submit', source: 'acme/widget', name: 'widget-local'})

    const ui = host({
      openModal: async () => ({type: 'submit', source: 'acme/widget', name: 'widget-local'}),
    })
    await handleImportCommand([], ui)
    expect(ui.calls).to.deep.equal([{source: 'acme/widget', options: {name: 'widget-local'}}])
    expect(ui.messages).to.deep.equal([formatImportSuccess('widget-local', 'acme/widget')])
    expect(ui.messages[0]).to.equal(
      "Imported 'widget-local' from acme/widget.\n" +
      '\n' +
      'Next steps:\n' +
      '- cast dev widget-local\n' +
      '- cast edit widget-local\n' +
      '- cast deploy widget-local --provider docker',
    )
  })

  it('runs immediately when a source is provided and omits a blank name', async () => {
    expect(planImportInvocation(['./agents/demo'])).to.deep.equal({type: 'run', source: './agents/demo'})
    expect(planImportInvocation(['./agents/demo', 'custom'])).to.deep.equal({
      type: 'run',
      source: './agents/demo',
      name: 'custom',
    })

    const ui = host()
    await handleImportCommand(['./agents/demo'], ui)
    expect(ui.modals).to.deep.equal([])
    expect(ui.calls).to.deep.equal([{source: './agents/demo', options: {}}])
    expect(ui.messages[0]).to.include("Imported 'derived' from ./agents/demo.")
  })

  it('ESC closes the modal and names the input as the focus target', () => {
    const fields = initialImportModalFields()
    fields.source = 'half-typed'
    const closed = reduceImportModal(fields, {name: 'escape'})
    expect(closed).to.deep.equal({type: 'close', focus: 'input'})
    expect(importModalSpec().focusOnClose).to.equal('input')
  })

  it('does not import when the modal is cancelled', async () => {
    const ui = host()
    await handleImportCommand([], ui)
    expect(ui.calls).to.deep.equal([])
  })

  it('keeps the modal open when source is empty', () => {
    const effect = reduceImportModal(initialImportModalFields(), {name: 'return'})
    expect(effect).to.deep.equal({
      type: 'invalid',
      message: 'Source is required.',
      fields: initialImportModalFields(),
    })
  })

  it('maps import failures onto the TUI sentences', () => {
    expect(mapImportError({
      name: 'AgentImportError',
      code: 'auth',
      message: 'Permission denied (publickey).',
    })).to.equal('Authentication failed. Check SSH keys or use a GitHub token for HTTPS.')

    expect(mapImportError({
      name: 'AgentImportError',
      code: 'missing-agent-yaml',
      message: 'Directory does not contain a Cast agent (missing agent.yaml).',
    })).to.equal('Source is not a Cast agent (missing agent.yaml).')

    expect(mapImportError({
      name: 'AgentImportError',
      code: 'missing-agent-yaml',
      message: "Cloned repository does not contain a valid Cast agent.\nExpected to find 'agent.yaml' in the root directory.",
    })).to.equal('Source is not a Cast agent (missing agent.yaml).')

    expect(mapImportError({
      name: 'AgentImportError',
      code: 'name-collision',
      agentName: 'demo',
      message: 'exists',
    })).to.equal("Agent 'demo' already exists. Use a different name or run `cast delete demo` first.")

    expect(mapImportError({
      name: 'AgentImportError',
      code: 'other',
      message: 'Could not resolve host: github.com',
    })).to.equal('Could not resolve host: github.com')

    expect(mapImportError({
      name: 'AgentImportError',
      code: 'missing-path',
      message: "Path './missing' does not exist.",
    })).to.equal("Path './missing' does not exist.")
  })

  it('adds the mapped error and does not leave the command throwing', async () => {
    const ui = host({
      importAgent: async () => {
        const error = new Error('Directory does not contain a Cast agent (missing agent.yaml).') as Error & {code?: string}
        error.name = 'AgentImportError'
        error.code = 'missing-agent-yaml'
        throw error
      },
    })
    await handleImportCommand(['./not-agent'], ui)
    expect(ui.messages).to.deep.equal(['Source is not a Cast agent (missing agent.yaml).'])
  })
})
