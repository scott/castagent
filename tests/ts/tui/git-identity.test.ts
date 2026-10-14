import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'
import {GIT_IDENTITY_HINT as cliHint} from '../../../typescript/cast-cli/src/lib/git-identity'

function loadHelper(): typeof import('../../../typescript/cast-tui/src/lib/git-identity') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/git-identity.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require, process}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

describe('tui /git init identity', () => {
  const helper = loadHelper()
  const registry = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
    'utf8',
  )
  const gitCommand = registry.slice(registry.indexOf("name: 'git'"), registry.indexOf("name: 'release'"))

  it('uses the same hint as the CLI', () => {
    expect(helper.GIT_IDENTITY_HINT).to.equal(cliHint)
    expect(helper.GIT_IDENTITY_HINT).to.include('git config --global user.email')
  })

  it('stops /git init on main when git has no email', async () => {
    expect(gitCommand).to.include('assertGitAuthorIdentity(agentPath)')
    expect(gitCommand).to.include("git.raw(['init', '-b', 'main'])")
    expect(gitCommand).to.include('GIT_IDENTITY_HINT')
    expect(gitCommand).to.not.include('await git.init()')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tui-git-identity-'))
    const empty = path.join(root, 'empty-gitconfig')
    fs.writeFileSync(empty, '')
    const saved = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      EMAIL: process.env.EMAIL,
    }
    process.env.GIT_CONFIG_GLOBAL = empty
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.EMAIL
    try {
      let caught: unknown
      try {
        await helper.assertGitAuthorIdentity(root)
      } catch (error) {
        caught = error
      }
      expect(helper.isGitIdentityFailure(caught)).to.equal(true)
      expect((caught as {message?: string}).message).to.equal(helper.GIT_IDENTITY_HINT)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(root, {recursive: true, force: true})
    }
  })
})
