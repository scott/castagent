import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the git log helper and run that JavaScript instead.
function loadGitLog(): {
  DEFAULT_GIT_LOG_COUNT: number
  GIT_LOG_USAGE: string
  parseGitLogCount: (args: readonly string[]) => {ok: true; maxCount: number} | {ok: false; message: string}
  loadRecentCommits: (repoPath: string, maxCount: number) => Promise<Array<{
    shortHash: string
    authorName: string
    date: string
    message: string
  }>>
  formatGitLog: (agentName: string, commits: ReadonlyArray<{
    shortHash: string
    authorName: string
    date: string
    message: string
  }>) => string
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/git-log.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require, Buffer, process, console}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

function commitFile(repo: string, name: string, message: string): void {
  fs.writeFileSync(path.join(repo, name), `${message}\n`)
  git(repo, ['add', name])
  git(repo, ['commit', '-m', message])
}

describe('TUI /git log count', () => {
  const {DEFAULT_GIT_LOG_COUNT, parseGitLogCount, loadRecentCommits, formatGitLog} = loadGitLog()

  describe('parseGitLogCount', () => {
    it('defaults to 5 when -n is omitted', () => {
      expect(parseGitLogCount([])).to.deep.equal({ok: true, maxCount: DEFAULT_GIT_LOG_COUNT})
      expect(DEFAULT_GIT_LOG_COUNT).to.equal(5)
    })

    it('reads -n 1 as a single commit', () => {
      expect(parseGitLogCount(['-n', '1'])).to.deep.equal({ok: true, maxCount: 1})
    })

    it('reads the count forms documented for the CLI and for git', () => {
      expect(parseGitLogCount(['-n', '20'])).to.deep.equal({ok: true, maxCount: 20})
      expect(parseGitLogCount(['-n1'])).to.deep.equal({ok: true, maxCount: 1})
      expect(parseGitLogCount(['-n=1'])).to.deep.equal({ok: true, maxCount: 1})
      expect(parseGitLogCount(['--count', '3'])).to.deep.equal({ok: true, maxCount: 3})
      expect(parseGitLogCount(['--count=3'])).to.deep.equal({ok: true, maxCount: 3})
      expect(parseGitLogCount(['--max-count', '1'])).to.deep.equal({ok: true, maxCount: 1})
      expect(parseGitLogCount(['--max-count=2'])).to.deep.equal({ok: true, maxCount: 2})
    })

    it('lets a later count replace an earlier one', () => {
      expect(parseGitLogCount(['-n', '5', '--count', '1'])).to.deep.equal({ok: true, maxCount: 1})
    })

    it('rejects a missing, zero, or negative count', () => {
      const missing = parseGitLogCount(['-n'])
      expect(missing.ok).to.equal(false)
      if (!missing.ok) expect(missing.message).to.include('Missing commit count')

      for (const args of [['-n', '0'], ['-n', '-1'], ['--count', '0'], ['-n0'], ['--count=-3']]) {
        const parsed = parseGitLogCount(args)
        expect(parsed.ok, args.join(' ')).to.equal(false)
        if (!parsed.ok) expect(parsed.message).to.include('at least 1')
      }
    })

    it('rejects a non-numeric count and unknown arguments', () => {
      const nan = parseGitLogCount(['-n', 'abc'])
      expect(nan.ok).to.equal(false)
      if (!nan.ok) expect(nan.message).to.include('abc')

      const extra = parseGitLogCount(['-n', '1', 'extra'])
      expect(extra.ok).to.equal(false)
      if (!extra.ok) expect(extra.message).to.include('extra')
    })
  })

  describe('loadRecentCommits', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tui-git-log-'))

    before(() => {
      git(repo, ['init', '-q', '-b', 'main'])
      commitFile(repo, 'one.txt', 'oldest-marker')
      commitFile(repo, 'two.txt', 'middle-marker')
      commitFile(repo, 'three.txt', 'newest-marker')
    })

    after(() => {
      fs.rmSync(repo, {recursive: true, force: true})
    })

    it('prints only the newest commit when the count is 1', async () => {
      const commits = await loadRecentCommits(repo, 1)
      expect(commits).to.have.length(1)
      expect(commits[0].message).to.equal('newest-marker')
      expect(commits[0].shortHash).to.have.length(7)

      const text = formatGitLog('bb-git', commits)
      expect(text).to.include(`commit ${commits[0].shortHash}`)
      expect(text).to.include('newest-marker')
      expect(text).to.not.include('middle-marker')
      expect(text).to.not.include('oldest-marker')
      expect(text.match(/commit /g)).to.have.length(1)
    })

    it('shows every commit when the history is shorter than the default of 5', async () => {
      const commits = await loadRecentCommits(repo, 5)
      expect(commits.map(commit => commit.message)).to.deep.equal([
        'newest-marker',
        'middle-marker',
        'oldest-marker',
      ])
    })

    it('refuses a count below 1 before asking git', async () => {
      try {
        await loadRecentCommits(repo, 0)
        expect.fail('expected a rejection')
      } catch (err) {
        // The helper runs in a vm, so the thrown error is not this realm's Error.
        expect((err as {message?: string}).message).to.include('at least 1')
      }
    })
  })

  it('wires /git log through the parsed count', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    expect(source).to.include('parseGitLogCount(args.slice(1))')
    expect(source).to.include('loadRecentCommits(agentPath, parsed.maxCount)')
    expect(source).to.not.match(/git\.log\(\{\s*maxCount:\s*5\s*\}\)/)
  })
})
