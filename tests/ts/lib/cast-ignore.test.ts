import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CAST_IGNORE_LINES,
  MEMORY_DATABASE_IGNORE_LINES,
  defaultCastIgnoreContents,
  ensureMemoryDatabaseIgnored,
  writeDefaultIgnoreFiles,
} from '../../../typescript/cast-cli/src/lib/cast-ignore'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'})
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, {recursive: true})
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'cast-test@example.com'])
  git(dir, ['config', 'user.name', 'Cast Test'])
}

describe('cast ignore rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ignore-'))

  after(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('includes the runtime memory database in the default ignore text', () => {
    const contents = defaultCastIgnoreContents()
    for (const line of MEMORY_DATABASE_IGNORE_LINES) {
      expect(contents).to.contain(`${line}\n`)
    }
    expect(CAST_IGNORE_LINES).to.include('memory/memory.db')
  })

  it('writes the same rules to .castignore and .gitignore', () => {
    const agent = path.join(root, 'fresh')
    fs.mkdirSync(agent)
    writeDefaultIgnoreFiles(agent)

    const castIgnore = fs.readFileSync(path.join(agent, '.castignore'), 'utf8')
    const gitignore = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')
    expect(gitignore).to.equal(castIgnore)
    expect(castIgnore).to.equal(defaultCastIgnoreContents())
  })

  it('ignores memory/memory.db in a repository created from the defaults', () => {
    const agent = path.join(root, 'init-defaults')
    initRepo(agent)
    writeDefaultIgnoreFiles(agent)
    fs.mkdirSync(path.join(agent, 'memory'))
    fs.writeFileSync(path.join(agent, 'memory', 'memory.db'), '')

    const status = git(agent, ['status', '--porcelain'])
    expect(status).to.not.contain('memory/memory.db')
    const match = git(agent, ['check-ignore', '-v', '--', 'memory/memory.db'])
    expect(match).to.contain('.gitignore')
  })

  it('adds the memory database rules to an older cast git init repo', () => {
    const agent = path.join(root, 'legacy')
    initRepo(agent)
    fs.writeFileSync(path.join(agent, '.castignore'), '.cast/versions/\ncast.db\n*.log\n.env\n__pycache__/\n')
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: legacy\n')
    git(agent, ['add', '.'])
    git(agent, ['commit', '-m', 'initial'])

    fs.mkdirSync(path.join(agent, 'memory'))
    fs.writeFileSync(path.join(agent, 'memory', 'memory.db'), '')

    ensureMemoryDatabaseIgnored(agent)

    const castIgnore = fs.readFileSync(path.join(agent, '.castignore'), 'utf8')
    const gitignore = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')
    expect(castIgnore).to.contain('memory/memory.db\n')
    expect(gitignore).to.contain('.cast/versions/\n')
    expect(gitignore).to.contain('memory/memory.db\n')

    const status = git(agent, ['status', '--porcelain'])
    expect(status).to.not.contain('memory/memory.db')
    expect(status).to.contain('.gitignore')
  })

  it('appends the memory database rules to an existing .gitignore once', () => {
    const agent = path.join(root, 'existing-gitignore')
    initRepo(agent)
    fs.writeFileSync(path.join(agent, '.gitignore'), '*.log\n')
    fs.writeFileSync(path.join(agent, '.castignore'), '*.log\n')

    ensureMemoryDatabaseIgnored(agent)
    const once = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')
    ensureMemoryDatabaseIgnored(agent)
    const twice = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')

    expect(twice).to.equal(once)
    expect(once.startsWith('*.log\n')).to.equal(true)
    for (const line of MEMORY_DATABASE_IGNORE_LINES) {
      expect(once.match(new RegExp(`^${line}$`, 'm'))).to.not.equal(null)
    }
  })

  it('leaves a directory that is not a git repo alone', () => {
    const agent = path.join(root, 'no-git')
    fs.mkdirSync(agent)
    fs.writeFileSync(path.join(agent, '.castignore'), '*.log\n')

    ensureMemoryDatabaseIgnored(agent)

    expect(fs.readFileSync(path.join(agent, '.castignore'), 'utf8')).to.equal('*.log\n')
    expect(fs.existsSync(path.join(agent, '.gitignore'))).to.equal(false)
  })
})
