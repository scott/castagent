import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {simpleGit} from 'simple-git'
import * as tar from 'tar'
import {GITPYTHON_REQUIREMENT} from '../../../../typescript/cast-cli/src/lib/deploy/requirements'

const ROOT = path.resolve(__dirname, '../../../..')

/** Numeric compare for dotted versions such as 7.5.22. Pre-release tags are not used here. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(part => Number(part))
  const b = right.split('.').map(part => Number(part))
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function lockedPackageVersion(name: string): string {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, {version?: string}>
  }
  // Cast resolves this top-level package. Nested copies bundled inside other
  // tools are not the module import('tar') or import('simple-git') loads.
  const version = lock.packages[`node_modules/${name}`]?.version
  expect(version, `lockfile entry for ${name}`).to.be.a('string')
  return version as string
}

function readJson(relativePath: string): {dependencies?: Record<string, string>; devDependencies?: Record<string, string>} {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

async function expectPluginRejection(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    expect(message).to.match(pattern)
    return
  }
  expect.fail(`expected simple-git to reject a call matching ${pattern}`)
}

async function initRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, {recursive: true})
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'cast-test@example.com')
  await git.addConfig('user.name', 'cast-test')
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n')
  await git.add(['README.md'])
  await git.commit('init fixture')
}

describe('runtime dependency advisories', () => {
  it('locks simple-git at 4.0.2 or newer', () => {
    for (const manifest of ['typescript/cast-cli/package.json', 'typescript/cast-tui/package.json']) {
      expect(readJson(manifest).dependencies?.['simple-git']).to.equal('^4.0.2')
    }
    expect(compareVersions(lockedPackageVersion('simple-git'), '4.0.2')).to.be.at.least(0)
  })

  it('locks tar newer than 7.5.20', () => {
    expect(readJson('typescript/cast-cli/package.json').dependencies?.tar).to.equal('^7.5.22')
    expect(compareVersions(lockedPackageVersion('tar'), '7.5.20')).to.be.greaterThan(0)
  })

  it('does not depend on the unused ws package', () => {
    const cli = readJson('typescript/cast-cli/package.json')
    expect(cli.dependencies).to.not.have.property('ws')
    expect(cli.devDependencies).to.not.have.property('@types/ws')
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, {dependencies?: Record<string, string>; devDependencies?: Record<string, string>}>
    }
    const workspace = lock.packages['typescript/cast-cli']
    expect(workspace.dependencies).to.not.have.property('ws')
    expect(workspace.devDependencies).to.not.have.property('@types/ws')
  })

  it('requires a GitPython release outside the historical OSV ranges and pins it', () => {
    const pyproject = fs.readFileSync(path.join(ROOT, 'python/pyproject.toml'), 'utf8')
    expect(pyproject).to.include('GitPython>=3.2.1')
    expect(GITPYTHON_REQUIREMENT).to.equal('GitPython>=3.2.1')

    const floor = '3.2.1'
    for (const vulnerable of ['3.1.0', '3.1.30', '3.1.41', '3.1.61']) {
      expect(compareVersions(vulnerable, floor)).to.be.lessThan(0)
    }

    const lock = fs.readFileSync(path.join(ROOT, 'python/requirements.lock'), 'utf8')
    const pins = lock
      .split('\n')
      .map(line => line.trim().replace(/\\$/, '').trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('--hash'))
    expect(pins.length).to.be.greaterThan(0)
    for (const pin of pins) {
      expect(pin).to.match(/^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]/)
    }
    const gitpython = pins.find(pin => pin.toLowerCase().startsWith('gitpython=='))
    expect(gitpython, 'GitPython pin').to.be.a('string')
    const version = gitpython!.split('==')[1]
    expect(compareVersions(version, floor)).to.be.at.least(0)
  })

  describe('simple-git guards', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-simple-git-'))
    const repo = path.join(root, 'repo')

    before(async () => {
      await initRepo(repo)
    })

    after(() => {
      fs.rmSync(root, {recursive: true, force: true})
    })

    it('rejects trailer command configuration', async () => {
      const git = simpleGit(repo)
      await expectPluginRejection(
        () => git.raw(['-c', 'trailer.sign.cmd=blocked', 'status']),
        /allowUnsafeCommandBinaries/,
      )
      await expectPluginRejection(
        () => git.raw(['config', 'trailer.sign.command', 'blocked']),
        /allowUnsafeCommandBinaries/,
      )
    })

    it('rejects include.path configuration', async () => {
      await expectPluginRejection(
        () => simpleGit(repo).raw(['-c', 'include.path=blocked', 'status']),
        /allowUnsafeInclude/,
      )
    })

    it('rejects abbreviated long options used to bypass the pack guard', async () => {
      await expectPluginRejection(
        () => simpleGit(repo).raw(['push', '--receive-p=blocked']),
        /abbreviat|allowUnsafePack/i,
      )
    })

    it('still clones and runs status, log, diff, and commit', async () => {
      const origin = path.join(root, 'origin')
      const clone = path.join(root, 'clone')
      await initRepo(origin)
      await simpleGit().clone(origin, clone, ['--single-branch'])

      const git = simpleGit(clone)
      const status = await git.status()
      expect(status.isClean()).to.equal(true)
      const log = await git.log({maxCount: 1})
      expect(log.total).to.be.greaterThan(0)
      expect(await git.diff()).to.equal('')

      fs.writeFileSync(path.join(clone, 'notes.txt'), 'note\n')
      await git.add(['notes.txt'])
      const commit = await git.commit('add notes')
      expect(commit.commit).to.match(/^[0-9a-f]{7,}$/)
      const after = await git.status()
      expect(after.isClean()).to.equal(true)

      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: clone, encoding: 'utf8'}).trim()
      expect(head.length).to.be.greaterThan(0)
    })
  })

  describe('tar guards', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tar-'))

    after(() => {
      fs.rmSync(root, {recursive: true, force: true})
    })

    it('aborts extraction when a gzip archive exceeds the default decompression ratio', async () => {
      const source = path.join(root, 'bomb-src')
      const archive = path.join(root, 'bomb.tar.gz')
      const dest = path.join(root, 'bomb-out')
      fs.mkdirSync(source, {recursive: true})
      fs.mkdirSync(dest, {recursive: true})
      // Highly compressible payload, large enough to pass the default ratio of 1000.
      fs.writeFileSync(path.join(source, 'zeros.bin'), Buffer.alloc(8 * 1024 * 1024))
      await tar.create({gzip: true, file: archive, cwd: source, portable: true}, ['zeros.bin'])

      let caught: unknown
      try {
        await tar.extract({file: archive, cwd: dest})
      } catch (error) {
        caught = error
      }
      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/max decompression ratio exceeded/)
      expect(fs.existsSync(path.join(dest, 'zeros.bin'))).to.equal(false)
    })

    it('does not walk a selected member path past the recursion cap', async () => {
      // One header with a long path, and no parent directory headers. A parent
      // entry would be cached and the walk would never reach the cap.
      const source = path.join(root, 'deep-src')
      fs.mkdirSync(source, {recursive: true})
      const deepRelative = `${Array.from({length: 120}, () => 'a').join('/')}/file.txt`
      const deepFile = path.join(source, deepRelative)
      fs.mkdirSync(path.dirname(deepFile), {recursive: true})
      fs.writeFileSync(deepFile, 'deep\n')
      const shallowFile = path.join(source, 'a', 'b.txt')
      fs.mkdirSync(path.dirname(shallowFile), {recursive: true})
      fs.writeFileSync(shallowFile, 'shallow\n')

      const deepArchive = path.join(root, 'deep.tar')
      const shallowArchive = path.join(root, 'shallow.tar')
      await tar.create({file: deepArchive, cwd: source, portable: true}, [deepRelative])
      await tar.create({file: shallowArchive, cwd: source, portable: true}, ['a/b.txt'])

      const deepEntries: string[] = []
      await tar.list({
        file: deepArchive,
        onReadEntry: entry => {
          deepEntries.push(entry.path)
        },
      })
      expect(deepEntries).to.deep.equal([deepRelative])

      const selectedDeep: string[] = []
      await tar.list(
        {
          file: deepArchive,
          onReadEntry: entry => {
            selectedDeep.push(entry.path)
          },
        },
        ['a'],
      )
      expect(selectedDeep).to.deep.equal([])

      const selectedShallow: string[] = []
      await tar.list(
        {
          file: shallowArchive,
          onReadEntry: entry => {
            selectedShallow.push(entry.path)
          },
        },
        ['a'],
      )
      expect(selectedShallow.some(entry => entry.endsWith('b.txt'))).to.equal(true)
    })

    it('extracts a normal release-style archive', async () => {
      const source = path.join(root, 'release-src')
      const archive = path.join(root, 'release.tar.gz')
      const dest = path.join(root, 'release-out')
      fs.mkdirSync(path.join(source, 'skills'), {recursive: true})
      fs.mkdirSync(dest, {recursive: true})
      fs.writeFileSync(path.join(source, 'agent.yaml'), 'name: fixture\n')
      fs.writeFileSync(path.join(source, 'skills', 'demo.md'), 'demo\n')
      await tar.create({gzip: true, file: archive, cwd: source, portable: true}, ['agent.yaml', 'skills'])

      await tar.extract({file: archive, cwd: dest})
      expect(fs.readFileSync(path.join(dest, 'agent.yaml'), 'utf8')).to.equal('name: fixture\n')
      expect(fs.readFileSync(path.join(dest, 'skills', 'demo.md'), 'utf8')).to.equal('demo\n')
    })
  })
})
