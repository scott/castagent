import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

function loadHelper(): {
  initialPermissionIndex: () => number
  wrapPermissionIndex: (index: number, delta: number) => number
  permissionChoiceApproved: (index: number) => boolean
  permissionKeyDecision: (key: string | undefined, selected: number) => {
    type: string
    selected?: number
    approved?: boolean
  }
  buildPermissionLines: (options: {
    tool: string
    args: Record<string, unknown>
    selected: number
    columns: number
  }) => Array<{text: string; tone: string}>
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/permission-prompt.ts')
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

describe('tool permission prompt', () => {
  const helper = loadHelper()

  it('starts on Deny and wraps between Approve and Deny', () => {
    expect(helper.initialPermissionIndex()).to.equal(1)
    expect(helper.permissionChoiceApproved(helper.initialPermissionIndex())).to.equal(false)
    expect(helper.wrapPermissionIndex(1, 1)).to.equal(0)
    expect(helper.wrapPermissionIndex(0, -1)).to.equal(1)
    expect(helper.permissionChoiceApproved(0)).to.equal(true)
  })

  it('Enter approves only the Approve row and ESC denies', () => {
    expect(helper.permissionKeyDecision('enter', 1)).to.deep.equal({type: 'choose', approved: false})
    expect(helper.permissionKeyDecision('return', 0)).to.deep.equal({type: 'choose', approved: true})
    expect(helper.permissionKeyDecision('escape', 0)).to.deep.equal({type: 'deny'})
    expect(helper.permissionKeyDecision('down', 1)).to.deep.equal({type: 'move', selected: 0})
    expect(helper.permissionKeyDecision('up', 0)).to.deep.equal({type: 'move', selected: 1})
  })

  it('shows the tool name, arguments, and an unnumbered choice list', () => {
    const lines = helper.buildPermissionLines({
      tool: 'bash',
      args: {command: 'date +%s'},
      selected: 1,
      columns: 80,
    })
    const text = lines.map(line => line.text)
    expect(text).to.include('Tool: bash')
    expect(text).to.include('  command: date +%s')
    expect(text).to.include('  Approve')
    expect(text).to.include('▸ Deny')
    expect(text.filter(line => line === '  Approve' || line === '▸ Deny')).to.deep.equal([
      '  Approve',
      '▸ Deny',
    ])
    expect(text.join('\n')).to.not.match(/^\d+\. /m)
  })

  it('truncates a long command', () => {
    const lines = helper.buildPermissionLines({
      tool: 'bash',
      args: {command: 'x'.repeat(80)},
      selected: 1,
      columns: 20,
    })
    const command = lines.find(line => line.text.includes('command'))
    expect(command?.text.endsWith('...')).to.equal(true)
    expect(command?.text.length).to.equal(20)
  })

  it('chat asks with the modal and sends the answer', () => {
    const chat = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/screens/chat.ts'),
      'utf8',
    )
    expect(chat).to.include('promptToolPermission')
    expect(chat).to.include('respondToPermission')
    const modal = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/permission-modal.ts'),
      'utf8',
    )
    expect(modal).to.include('createModal')
    expect(modal).to.include("title: `Allow ${request.tool}`")
  })
})