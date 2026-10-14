import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM and imports @opentui/core. Transpile the pure helper only.
function loadHelper(): typeof import('../../../typescript/cast-tui/src/lib/agent-update') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/agent-update.ts')
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

describe('tui /update', () => {
  const helper = loadHelper()
  const registry = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
    'utf8',
  )
  const modalSource = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/agent-update-modal.ts'),
    'utf8',
  )
  const cliSource = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-cli/src/commands/update.ts'),
    'utf8',
  )
  const command = registry.slice(registry.indexOf("name: 'update'"), registry.indexOf("name: 'upgrade'"))

  const snapshot = helper.snapshotFromConfig({
    description: 'Summarize pull requests',
    version: '1.0',
    brain: {model: 'openrouter/minimax/minimax-m2.5', instructions_file: 'instructions.md'},
    tools: {builtin: ['bash', 'read']},
    harness: {
      principles: ['Be concise'],
      permissions: {read: 'ask', bash: 'always-allow'},
    },
    runtime: {python_version: '3.11', requirements: ['requests']},
  })

  it('registers /update for dev and production and no longer tells the user to use the CLI', () => {
    expect(command).to.include("description: 'Update the current agent'")
    expect(command).to.include("modes: ['dev', 'production']")
    expect(command).to.include("args: '[flags]'")
    expect(command).to.include('requireSubjectAgent')
    expect(command).to.include('openAgentUpdateModal')
    expect(command).to.include('parseUpdateArgs')
    expect(command).to.include('runAgentUpdateFromArgs')
    expect(command).to.not.include('from the CLI for now')
    expect(registry).to.not.include('from the CLI for now')
    expect(helper.isUpdateCommandVisible('dev')).to.equal(true)
    expect(helper.isUpdateCommandVisible('production')).to.equal(true)
    expect(helper.isUpdateCommandVisible('on-host')).to.equal(false)
  })

  it('uses the default centered modal, returns focus to the input, and shells out to cast update', () => {
    const modalCall = modalSource.slice(
      modalSource.indexOf('createModal('),
      modalSource.indexOf('modal.box.overflow'),
    )
    expect(modalCall).to.include('createModal(ctx.renderer, ctx.input')
    expect(modalCall).to.include('overlay: true')
    expect(modalCall).to.not.include('width')
    expect(modalCall).to.not.include('height')
    expect(helper.updateFocusReturnTarget()).to.equal('input')
    expect(modalSource).to.include("key.name === 'escape'")
    expect(modalSource).to.include("key.name === 'up'")
    expect(modalSource).to.include("key.name === 'down'")
    expect(modalSource).to.include('wrapUpdateIndex')
    expect(modalSource).to.include('stdio: CAPTURED_CHILD_STDIO')
    expect(helper.updateArgv('bb-summarizer', ['--model', 'openai/gpt-4o'])).to.deep.equal([
      'update',
      'bb-summarizer',
      '--model',
      'openai/gpt-4o',
    ])
    expect(helper.updateModalTitle('bb-summarizer')).to.equal('Update: bb-summarizer')
    expect(helper.updateModalTitle('bb-summarizer', 'Model')).to.equal('Update Model: bb-summarizer')
  })

  it('lists the same flags and allowed values as cast update', () => {
    expect(cliSource).to.include("const VALID_TOOLS = ['bash', 'read', 'glob']")
    expect(cliSource).to.include("const VALID_PERMISSION_LEVELS = ['always-allow', 'ask', 'deny']")
    expect(cliSource).to.include("const SUPPORTED_PYTHON_VERSIONS = ['3.11', '3.12']")
    expect(helper.VALID_TOOLS).to.deep.equal(['bash', 'read', 'glob'])
    expect(helper.VALID_PERMISSION_LEVELS).to.deep.equal(['always-allow', 'ask', 'deny'])
    expect(helper.SUPPORTED_PYTHON_VERSIONS).to.deep.equal(['3.11', '3.12'])
    for (const field of helper.UPDATE_FIELDS) {
      expect(helper.UPDATE_VALUE_FLAGS).to.include(field.flag)
      const cliName = field.flag.slice(2)
      expect(cliSource).to.include(cliName.includes('-') ? `'${cliName}'` : `${cliName}:`)
    }
    expect(helper.UPDATE_FIELDS.map((field) => field.id)).to.deep.equal([
      'model',
      'description',
      'version',
      'instructions-text',
      'instructions',
      'add-tool',
      'remove-tool',
      'add-principle',
      'remove-principle',
      'permission',
      'remove-permission',
      'python-version',
      'add-requirement',
      'remove-requirement',
    ])
  })

  it('parses slash flags, including values that were split on spaces', () => {
    expect(helper.parseUpdateArgs([])).to.deep.equal({ok: false, message: helper.UPDATE_USAGE})
    expect(helper.parseUpdateArgs(['bb-summarizer']).ok).to.equal(false)
    expect(helper.parseUpdateArgs(['--model'])).to.deep.equal({
      ok: false,
      message: `Missing value for --model.\n${helper.UPDATE_USAGE}`,
    })
    expect(helper.parseUpdateArgs(['--nope', 'x']).ok).to.equal(false)
    expect(helper.parseUpdateArgs(['--model', 'openrouter/anthropic/claude-3.7-sonnet'])).to.deep.equal({
      ok: true,
      flags: ['--model', 'openrouter/anthropic/claude-3.7-sonnet'],
    })
    expect(helper.parseUpdateArgs(['--description', 'My', 'new', 'description'])).to.deep.equal({
      ok: true,
      flags: ['--description', 'My new description'],
    })
    expect(helper.parseUpdateArgs([
      '--dry-run',
      '--add-tool',
      'bash',
      '--add-principle',
      'Be',
      'concise',
      '--permission',
      'bash=ask',
    ])).to.deep.equal({
      ok: true,
      flags: ['--dry-run', '--add-tool', 'bash', '--add-principle', 'Be concise', '--permission', 'bash=ask'],
    })
  })

  it('reads the current agent.yaml fields and builds one flag per choice', () => {
    expect(helper.currentForField('model', snapshot)).to.equal('openrouter/minimax/minimax-m2.5')
    expect(helper.currentForField('description', snapshot)).to.equal('Summarize pull requests')
    expect(helper.currentForField('add-tool', snapshot)).to.equal('bash, read')
    expect(helper.currentForField('permission', snapshot)).to.equal('bash=always-allow, read=ask')
    expect(helper.currentForField('python-version', snapshot)).to.equal('3.11')
    expect(helper.choicesForField('add-tool', snapshot)).to.deep.equal(['bash', 'read', 'glob'])
    expect(helper.choicesForField('remove-tool', snapshot)).to.deep.equal(['bash', 'read'])
    expect(helper.choicesForField('remove-principle', snapshot)).to.deep.equal(['Be concise'])
    expect(helper.choicesForField('remove-permission', snapshot)).to.deep.equal(['bash', 'read'])
    expect(helper.choicesForField('remove-requirement', snapshot)).to.deep.equal(['requests'])
    expect(helper.choicesForField('python-version', snapshot)).to.deep.equal(['3.11', '3.12'])
    expect(helper.choicesForField('remove-tool', helper.emptyAgentSnapshot())).to.deep.equal([])
    expect(helper.emptyChoiceMessage('remove-tool')).to.equal('This agent has no built-in tools to remove.')
    expect(helper.flagsForField('model', 'openai/gpt-4o')).to.deep.equal(['--model', 'openai/gpt-4o'])
    expect(helper.flagsForField('permission', helper.permissionValue('bash', 'ask'))).to.deep.equal([
      '--permission',
      'bash=ask',
    ])
    expect(helper.choiceNote('python-version', '3.11', snapshot)).to.equal('(current)')
    expect(helper.choiceNote('add-tool', 'bash', snapshot)).to.equal('(added)')
    expect(helper.choiceNote('permission', 'always-allow', snapshot, 'bash')).to.equal('(current)')
  })

  it('rejects an empty value, expands a home path, and skips a value that is already set', () => {
    expect(helper.blankUpdateValueMessage()).to.equal('Enter a value.')
    expect(helper.normalizeFieldValue('description', '  hello  ', '/home/me')).to.equal('hello')
    expect(helper.normalizeFieldValue('instructions', '~/prompts/new.md', '/home/me')).to.equal('/home/me/prompts/new.md')
    expect(helper.normalizeFieldValue('instructions', '~', '/home/me')).to.equal('/home/me')
    expect(helper.normalizeFieldValue('model', ' openai/gpt-4o ', '/home/me')).to.equal('openai/gpt-4o')
    expect(helper.unchangedUpdateMessage('model', snapshot.model, snapshot)).to.equal(
      `Model is already ${snapshot.model}.`,
    )
    expect(helper.unchangedUpdateMessage('model', 'openai/gpt-4o', snapshot)).to.equal(null)
    expect(helper.unchangedUpdateMessage('add-tool', 'bash', snapshot)).to.equal(
      "Tool 'bash' is already on this agent.",
    )
    expect(helper.unchangedUpdateMessage('permission', 'bash=always-allow', snapshot)).to.equal(
      'Permission bash is already always-allow.',
    )
    expect(helper.unchangedUpdateMessage('python-version', '3.12', snapshot)).to.equal(null)
    expect(helper.snapshotFromConfig(null)).to.deep.equal(helper.emptyAgentSnapshot())
  })

  it('wraps the selection and keeps the selected field on screen', () => {
    expect(helper.wrapUpdateIndex(0, -1, helper.UPDATE_FIELDS.length)).to.equal(helper.UPDATE_FIELDS.length - 1)
    expect(helper.wrapUpdateIndex(helper.UPDATE_FIELDS.length - 1, 1, 14)).to.equal(0)
    expect(helper.wrapUpdateIndex(0, 1, 1)).to.equal(0)
    expect(helper.wrapUpdateIndex(3, 0, 14)).to.equal(3)

    const currents = helper.UPDATE_FIELDS.map((field) => helper.currentForField(field.id, snapshot))
    const top = helper.buildUpdateFieldLines({
      fields: helper.UPDATE_FIELDS,
      currents,
      selected: 0,
      termHeight: 24,
      columns: 80,
      error: null,
    })
    const topText = top.filter((line) => line.tone === 'text')
    expect(topText.length).to.be.lessThan(helper.UPDATE_FIELDS.length)
    expect(topText.filter((line) => line.selected)).to.have.length(1)
    expect(topText[0].text.startsWith('▸ Model')).to.equal(true)
    expect(topText[0].text).to.include('openrouter/minimax/minimax-m2.5')
    expect(topText.some((line) => line.text.includes('Remove requirement'))).to.equal(false)
    for (const line of topText.slice(1)) {
      expect(line.text.startsWith('  ')).to.equal(true)
      expect(line.text.startsWith('▸')).to.equal(false)
    }
    expect(top.some((line) => line.text.trim() === '↑↓ Select   Enter Edit   ESC Close')).to.equal(true)

    const bottom = helper.buildUpdateFieldLines({
      fields: helper.UPDATE_FIELDS,
      currents,
      selected: helper.UPDATE_FIELDS.length - 1,
      termHeight: 24,
      columns: 80,
      error: null,
    })
    const bottomText = bottom.filter((line) => line.tone === 'text')
    const selected = bottomText.find((line) => line.selected)
    expect(selected?.text.startsWith('▸ Remove requirement')).to.equal(true)
    expect(bottomText.some((line) => line.text.startsWith('▸ Model'))).to.equal(false)
    expect(bottom.some((line) => line.tone === 'hint' && line.text.trim() === '...')).to.equal(true)
  })

  it('truncates a long current value to 50 characters and formats choice rows', () => {
    const long = 'x'.repeat(60)
    expect(helper.truncateUpdateValue(long)).to.have.length(50)
    expect(helper.truncateUpdateValue(long).endsWith('...')).to.equal(true)
    const row = helper.formatUpdateFieldRow('Description', true, long)
    expect(row.startsWith('▸ Description')).to.equal(true)
    expect(row).to.include('...')
    expect(helper.formatUpdateFieldRow('Model', false, '')).to.equal('  Model')
    expect(helper.formatUpdateChoiceRow('bash', true, '(added)')).to.equal('▸ bash  (added)')
    expect(helper.formatUpdateChoiceRow('glob', false, '')).to.equal('  glob')
    const choices = helper.buildUpdateChoiceLines({
      choices: ['3.11', '3.12'],
      notes: ['(current)', ''],
      selected: 1,
      termHeight: 24,
      columns: 40,
      error: 'Unsupported Python version.',
      footer: '↑↓ Select   Enter Apply   ESC Back',
    })
    expect(choices.filter((line) => line.selected).map((line) => line.text.trim())).to.deep.equal(['▸ 3.12'])
    expect(choices.some((line) => line.tone === 'error' && line.text.includes('Unsupported Python version.'))).to.equal(true)
  })

  it('reports a successful write, a dry run, and a no-op without a restart line', () => {
    const wrote = helper.updateAppliedMessage('bb-summarizer', [
      'Proposed changes:',
      '  + Model: openai/gpt-4o',
      "Agent 'bb-summarizer' configuration updated successfully.",
    ].join('\n'))
    expect(wrote).to.equal([
      "Updated 'bb-summarizer'.",
      '+ Model: openai/gpt-4o',
      'Restart the local agent so it picks up the change: cast dev bb-summarizer',
    ].join('\n'))
    const dry = helper.updateAppliedMessage('bb-summarizer', '  + Model: openai/gpt-4o\nDry run mode - no changes written.\n')
    expect(dry).to.equal("Dry run for 'bb-summarizer'. No changes written.\n+ Model: openai/gpt-4o")
    expect(dry).to.not.include('Restart')
    expect(helper.updateAppliedMessage('bb-summarizer', 'No changes made. Use flags to update configuration.\n')).to.equal(
      "No changes made for 'bb-summarizer'. Pick a field with /update.",
    )
    expect(helper.missingAgentMessage('bb-summarizer', '/tmp/bb-summarizer')).to.equal(
      "Agent 'bb-summarizer' not found at /tmp/bb-summarizer.\nCreate the agent first with: cast dev bb-summarizer --no-tui",
    )
    expect(helper.missingAgentYamlMessage('/tmp/bb-summarizer/agent.yaml')).to.equal(
      'Agent YAML not found at /tmp/bb-summarizer/agent.yaml.\nThe agent directory may be corrupted. Try recreating the agent.',
    )
    expect(helper.agentYamlParseMessage('bad indent')).to.equal(
      'Failed to parse agent.yaml: bad indent\nPlease fix the YAML syntax and try again.',
    )
    expect(helper.CAST_CLI_NOT_FOUND).to.equal('cast CLI not found in PATH.')
  })
})
