import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM. Transpile the pure helper so Node can load it.
function loadHelper(): typeof import('../../../typescript/cast-tui/src/lib/git-commit-args') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/git-commit-args.ts')
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

/** Same split as the TUI input handler in screens/chat.ts. */
function slashArgs(input: string): string[] {
  const parts = input.trim().slice(1).split(' ')
  return parts.slice(1).filter(Boolean)
}

describe('tui /git commit message', () => {
  const helper = loadHelper()
  const registry = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
    'utf8',
  )
  const gitCommand = registry.slice(registry.indexOf("name: 'git'"), registry.indexOf("name: 'release'"))

  function messageAfter(input: string): string {
    const parsed = helper.parseGitCommitArgs(slashArgs(input).slice(1))
    expect(parsed.error, input).to.equal(undefined)
    return parsed.message
  }

  it('parses -m as the message flag instead of commit text', () => {
    expect(messageAfter('/git commit -m tui-commit')).to.equal('tui-commit')
    expect(messageAfter("/git commit -m 'msg'")).to.equal('msg')
    expect(messageAfter('/git commit -m "Switched to Claude 3.7"')).to.equal('Switched to Claude 3.7')
    expect(messageAfter("/git commit -m 'Switched to Claude 3.7'")).to.equal('Switched to Claude 3.7')
  })

  it('accepts --message and a positional message', () => {
    expect(messageAfter('/git commit --message tui-commit')).to.equal('tui-commit')
    expect(messageAfter('/git commit --message=tui-commit')).to.equal('tui-commit')
    expect(messageAfter('/git commit --message "Switched to Claude 3.7"')).to.equal('Switched to Claude 3.7')
    expect(messageAfter('/git commit tui-commit')).to.equal('tui-commit')
    expect(messageAfter('/git commit "Switched to Claude 3.7"')).to.equal('Switched to Claude 3.7')
    expect(messageAfter('/git commit fix the -m flag')).to.equal('fix the -m flag')
  })

  it('leaves an omitted message empty and rejects a bare -m flag', () => {
    expect(messageAfter('/git commit')).to.equal('')
    const missing = helper.parseGitCommitArgs(['-m'])
    expect(missing.message).to.equal('')
    expect(missing.error).to.include('Usage: /git commit [-m] <msg>')
    expect(missing.error).to.include('-m is the message flag')
    expect(helper.parseGitCommitArgs(['--message']).error).to.include('-m is the message flag')
    expect(helper.parseGitCommitArgs(['--message=']).error).to.include('-m is the message flag')
    expect(helper.parseGitCommitArgs(['-m', '""']).error).to.include('-m is the message flag')
    expect(helper.parseGitCommitArgs(['-m', "''"]).error).to.include('-m is the message flag')
  })

  it('wires the parser into /git and shows the flag in help', () => {
    expect(gitCommand).to.include('parseGitCommitArgs(args.slice(1))')
    expect(gitCommand).to.include('parsed.error')
    expect(gitCommand).to.include('/git commit [-m] <msg>')
    expect(gitCommand).to.not.include("let message = args.slice(1).join(' ')")
  })
})
