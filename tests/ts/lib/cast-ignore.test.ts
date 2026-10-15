import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CAST_IGNORE_LINES,
  DOCKER_DEPLOY_IGNORE_LINES,
  MEMORY_DATABASE_IGNORE_LINES,
  MEMORY_NOTES_IGNORE_LINES,
  defaultCastIgnoreContents,
  ensureDockerDeployArtifactsIgnored,
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
    expect(CAST_IGNORE_LINES).to.include('memory/notes.md')
    for (const line of MEMORY_NOTES_IGNORE_LINES) {
      expect(contents).to.contain(`${line}\n`)
    }
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

  it('ignores the legacy versions directory and tracks the undo log', () => {
    const agent = path.join(root, 'undo-log')
    initRepo(agent)
    writeDefaultIgnoreFiles(agent)

    const changes = path.join(agent, '.cast', 'changes', '001.tar.gz')
    const legacy = path.join(agent, '.cast', 'versions', '001.tar.gz')
    fs.mkdirSync(path.dirname(changes), {recursive: true})
    fs.mkdirSync(path.dirname(legacy), {recursive: true})
    fs.writeFileSync(changes, '')
    fs.writeFileSync(legacy, '')

    const ignored = (file: string): boolean => {
      try {
        git(agent, ['check-ignore', '-q', '--', file])
        return true
      } catch {
        return false
      }
    }

    expect(ignored('.cast/versions/001.tar.gz')).to.equal(true)
    expect(ignored('.cast/changes/001.tar.gz')).to.equal(false)
    expect(ignored('.cast/changes/changes.json')).to.equal(false)
    expect(ignored('.cast/releases/1.0.tar.gz')).to.equal(false)

    const status = git(agent, ['status', '--porcelain', '--untracked-files=all'])
    expect(status).to.contain('.cast/changes/001.tar.gz')
    expect(status).to.not.contain('.cast/versions/')
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

  it('ignores memory/notes.md in a repository created from the defaults', () => {
    const agent = path.join(root, 'notes-defaults')
    initRepo(agent)
    writeDefaultIgnoreFiles(agent)
    fs.mkdirSync(path.join(agent, 'memory'))
    fs.writeFileSync(path.join(agent, 'memory', 'notes.md'), 'sk-or-v1-dummy\n')
    fs.writeFileSync(path.join(agent, 'README.md'), 'public\n')

    const status = git(agent, ['status', '--porcelain'])
    expect(status).to.not.contain('memory/notes.md')
    expect(status).to.not.contain('sk-or-v1-dummy')
    expect(status).to.contain('README.md')

    git(agent, ['add', '-A'])
    const staged = git(agent, ['diff', '--cached', '--name-only'])
    expect(staged).to.not.contain('memory/notes.md')
    expect(staged).to.not.contain('sk-or-v1-dummy')
    expect(staged).to.contain('README.md')
    const match = git(agent, ['check-ignore', '-v', '--', 'memory/notes.md'])
    expect(match).to.contain('.gitignore')
    expect(match).to.contain('memory/notes.md')
  })

  it('adds memory/notes.md to an older repository once', () => {
    const agent = path.join(root, 'notes-legacy')
    initRepo(agent)
    const legacy = '.cast/versions/\ncast.db\n*.log\n.env\n__pycache__/\n'
    fs.writeFileSync(path.join(agent, '.castignore'), legacy)
    fs.writeFileSync(path.join(agent, '.gitignore'), legacy)
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: legacy\n')
    git(agent, ['add', '.'])
    git(agent, ['commit', '-m', 'initial'])

    fs.mkdirSync(path.join(agent, 'memory'))
    fs.writeFileSync(path.join(agent, 'memory', 'notes.md'), 'sk-or-v1-dummy\n')

    ensureMemoryDatabaseIgnored(agent)
    const once = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')
    ensureMemoryDatabaseIgnored(agent)
    const twice = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')

    expect(twice).to.equal(once)
    expect(once).to.contain('memory/notes.md\n')
    expect(fs.readFileSync(path.join(agent, '.castignore'), 'utf8')).to.contain('memory/notes.md\n')
    const status = git(agent, ['status', '--porcelain'])
    expect(status).to.not.contain('memory/notes.md')
    expect(status).to.not.contain('sk-or-v1-dummy')
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

  it('ignores Docker deploy artifacts at the agent root and keeps nested copies', () => {
    const agent = path.join(root, 'docker-defaults')
    initRepo(agent)
    writeDefaultIgnoreFiles(agent)

    fs.writeFileSync(path.join(agent, 'Dockerfile'), 'FROM scratch\n')
    fs.writeFileSync(path.join(agent, 'docker-compose.yml'), 'AUTH_TOKEN=sekret\n')
    fs.writeFileSync(path.join(agent, 'requirements.txt'), 'requests\n')
    const runtimeFile = path.join(agent, '.cast-runtime', 'cast', 'runtime.py')
    fs.mkdirSync(path.dirname(runtimeFile), {recursive: true})
    fs.writeFileSync(runtimeFile, '')
    fs.mkdirSync(path.join(agent, 'tools'))
    fs.writeFileSync(path.join(agent, 'tools', 'requirements.txt'), 'local\n')
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: demo\n')

    const ignored = (file: string): boolean => {
      try {
        git(agent, ['check-ignore', '-q', '--', file])
        return true
      } catch {
        return false
      }
    }

    expect(ignored('Dockerfile')).to.equal(true)
    expect(ignored('docker-compose.yml')).to.equal(true)
    expect(ignored('requirements.txt')).to.equal(true)
    expect(ignored('.cast-runtime/cast/runtime.py')).to.equal(true)
    expect(ignored('tools/requirements.txt')).to.equal(false)
    expect(ignored('agent.yaml')).to.equal(false)

    git(agent, ['add', '-A'])
    const staged = git(agent, ['diff', '--cached', '--name-only'])
    expect(staged).to.not.contain('docker-compose.yml')
    expect(staged).to.not.contain('AUTH_TOKEN')
    expect(staged).to.contain('agent.yaml')
    expect(staged).to.contain('tools/requirements.txt')
  })

  it('adds Docker deploy ignore rules to an older repository once', () => {
    const agent = path.join(root, 'docker-legacy')
    initRepo(agent)
    const legacy = '.cast/versions/\ncast.db\n*.log\n.env\n__pycache__/\n'
    fs.writeFileSync(path.join(agent, '.castignore'), legacy)
    fs.writeFileSync(path.join(agent, '.gitignore'), legacy)
    fs.writeFileSync(path.join(agent, 'docker-compose.yml'), 'AUTH_TOKEN=sekret\n')

    ensureDockerDeployArtifactsIgnored(agent)
    const once = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')
    ensureDockerDeployArtifactsIgnored(agent)
    const twice = fs.readFileSync(path.join(agent, '.gitignore'), 'utf8')

    expect(twice).to.equal(once)
    expect(fs.readFileSync(path.join(agent, '.castignore'), 'utf8')).to.equal(once)
    for (const line of DOCKER_DEPLOY_IGNORE_LINES) {
      expect(once).to.contain(`${line}\n`)
    }
    expect(CAST_IGNORE_LINES).to.include.members([...DOCKER_DEPLOY_IGNORE_LINES])

    const status = git(agent, ['status', '--porcelain'])
    expect(status).to.not.contain('docker-compose.yml')
    expect(status).to.not.contain('sekret')
  })

  it('matches the TUI /git init ignore list', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    const marker = 'Keep in sync with typescript/cast-cli/src/lib/cast-ignore.ts.'
    const at = source.indexOf(marker)
    expect(at).to.be.greaterThan(-1)
    const block = source.slice(at, source.indexOf('.join(', at))
    const lines = [...block.matchAll(/'([^']+)'/g)].map(match => match[1])
    expect(lines).to.deep.equal([...CAST_IGNORE_LINES])
  })
})
