import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {createDockerignore} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {createSpriteAgentArchive} from '../../../../typescript/cast-cli/src/lib/deploy/sprites'

function normalizeEntry(name: string): string {
  let rel = name.replace(/\\/g, '/').replace(/\/+$/, '')
  while (rel.startsWith('./')) rel = rel.slice(2)
  return rel
}

function archiveEntries(tarPath: string): string[] {
  const listed = execFileSync('tar', ['-tzf', tarPath], {encoding: 'utf8'})
  return listed
    .split(/\r?\n/)
    .map(normalizeEntry)
    .filter(name => name.length > 0)
}

function writeFixture(root: string): void {
  const files = [
    'agent.yaml',
    'skills/search.md',
    'skills/x.log',
    'skills/data.zip',
    'skills/__pycache__/m.pyc',
    '.cast-runtime/cast/__init__.py',
    '.cast/releases/1.0.0.tar.gz',
    '.cast/releases/releases.json',
    '.cast/changes/0001.json',
    '.git/HEAD',
    '.env',
    '.env.local',
    '__pycache__/mod.pyc',
    'cast.db',
    '.castignore',
    'debug.log',
    'extra.tar.gz',
    '.dockerignore',
  ]
  for (const rel of files) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, rel === 'agent.yaml' ? 'name: fixture\n' : 'x')
  }
}

describe('Sprites agent archive', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-sprite-archive-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('leaves out .cast releases and the other build-context paths', async () => {
    const agentPath = path.join(dir, 'agent')
    fs.mkdirSync(agentPath)
    writeFixture(agentPath)
    const tarPath = path.join(dir, 'agent.tar.gz')

    await createSpriteAgentArchive(agentPath, tarPath)
    const entries = archiveEntries(tarPath)

    expect(entries).to.include('agent.yaml')
    expect(entries).to.include('skills/search.md')
    expect(entries).to.include('skills/x.log')
    expect(entries).to.include('skills/data.zip')
    expect(entries).to.include('skills/__pycache__/m.pyc')
    expect(entries).to.include('.cast-runtime/cast/__init__.py')
    expect(entries).to.not.include('.cast')
    expect(entries).to.not.include('.cast/releases/1.0.0.tar.gz')
    expect(entries).to.not.include('.cast/releases/releases.json')
    expect(entries).to.not.include('.cast/changes/0001.json')
    expect(entries).to.not.include('.git')
    expect(entries).to.not.include('.git/HEAD')
    expect(entries).to.not.include('.env')
    expect(entries).to.not.include('.env.local')
    expect(entries).to.not.include('__pycache__')
    expect(entries).to.not.include('__pycache__/mod.pyc')
    expect(entries).to.not.include('cast.db')
    expect(entries).to.not.include('.castignore')
    expect(entries).to.not.include('debug.log')
    expect(entries).to.not.include('extra.tar.gz')
    expect(entries).to.not.include('.dockerignore')
    expect(entries.some(name => name === '.cast' || name.startsWith('.cast/'))).to.equal(false)
  })

  it('packs an agent whose releases.json cannot be read', async function () {
    if (process.getuid?.() === 0) this.skip()
    const agentPath = path.join(dir, 'agent')
    fs.mkdirSync(agentPath)
    writeFixture(agentPath)
    const releasesJson = path.join(agentPath, '.cast', 'releases', 'releases.json')
    fs.chmodSync(releasesJson, 0o000)
    const tarPath = path.join(dir, 'agent.tar.gz')

    try {
      expect(() => fs.readFileSync(releasesJson)).to.throw(/EACCES|permission denied/i)
      await createSpriteAgentArchive(agentPath, tarPath)
    } finally {
      fs.chmodSync(releasesJson, 0o644)
    }

    const entries = archiveEntries(tarPath)
    expect(entries).to.include('agent.yaml')
    expect(entries).to.include('skills/search.md')
    expect(entries).to.not.include('.cast/releases/releases.json')
    expect(entries).to.not.include('.cast/releases/1.0.0.tar.gz')
    expect(entries.some(name => name === '.cast' || name.startsWith('.cast/'))).to.equal(false)
  })

  it('writes a dockerignore with the same exclusion lines', () => {
    const agentPath = path.join(dir, 'agent')
    fs.mkdirSync(agentPath)
    createDockerignore(agentPath)
    const written = fs.readFileSync(path.join(agentPath, '.dockerignore'), 'utf8')
    expect(written).to.equal([
      '.git',
      '.gitignore',
      '*.tar',
      '*.tar.gz',
      '*.zip',
      '__pycache__/',
      '*.py[cod]',
      '*.pyc',
      '.DS_Store',
      '.AppleDouble',
      '.LSOverride',
      '*.log',
      '.env',
      '.env.*',
      'cast.db',
      'cast.db-*',
      '.cast/',
      '.castignore',
      '.cloud-init.yml',
      '.dockerignore',
      '',
    ].join('\n'))
  })
})
