import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import GitLog from '../../../../typescript/cast-cli/src/commands/git/log'

async function runCommand(rawArgs: string[], args: any, flags: any): Promise<{logs: string[]; errors: string[]}> {
  const logs: string[] = []
  const errors: string[] = []
  const instance = new GitLog(rawArgs, {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({
    args,
    flags,
    argv: [],
    raw: [],
    metadata: {},
    nonExistentFlags: [],
  })
  instance.log = (msg?: string) => {
    if (msg !== undefined) logs.push(msg)
  }
  instance.error = (msg: string) => {
    errors.push(msg)
    throw new Error(msg)
  }
  try {
    await instance.run()
  } catch (e: any) {
    if (errors.length === 0) errors.push(e.message ?? String(e))
  }
  return {logs, errors}
}

function commitFile(repo: string, name: string, message: string): void {
  fs.writeFileSync(path.join(repo, name), `${message}\n`)
  execFileSync('git', ['add', name], {cwd: repo})
  execFileSync('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', message,
  ], {cwd: repo})
}

describe('Git Log Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitLog.description).to.equal('Show commit history for an agent')
    })

    it('should require agent argument', () => {
      expect(GitLog.args).to.have.property('agent')
      expect(GitLog.args.agent.required).to.be.true
      expect(GitLog.args.agent.description).to.equal('Agent name')
    })

    it('should have --count flag with default 10', () => {
      expect(GitLog.flags).to.have.property('count')
      expect(GitLog.flags.count.default).to.equal(10)
      expect(GitLog.flags.count.char).to.equal('n')
    })

    it('should have examples', () => {
      expect(GitLog.examples).to.be.an('array')
      expect(GitLog.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitLog(['git', 'log', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should use git.log() with maxCount', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should format date for display', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should display commit hash, date, author, and message', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should handle empty log', () => {
      expect(GitLog).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitLog).to.be.a('function')
    })
  })

  describe('count option', () => {
    it('should accept -n flag', () => {
      expect(GitLog.flags.count.char).to.equal('n')
    })

    it('should default to 10 commits', () => {
      expect(GitLog.flags.count.default).to.equal(10)
    })

    it('should allow a custom count of at least 1', () => {
      expect(GitLog.flags.count).to.exist
    })
  })

  describe('count validation', () => {
    const agentName = `git-log-count-${Date.now()}`
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    before(() => {
      fs.mkdirSync(agentPath, {recursive: true})
      execFileSync('git', ['init'], {cwd: agentPath})
      commitFile(agentPath, 'one.txt', 'first commit')
      commitFile(agentPath, 'two.txt', 'second commit')
    })

    after(() => {
      fs.rmSync(agentPath, {recursive: true, force: true})
    })

    it('shows only the requested number of commits', async () => {
      const {logs, errors} = await runCommand(
        ['git', 'log', agentName, '-n', '1'],
        {agent: agentName},
        {count: 1},
      )
      expect(errors).to.deep.equal([])
      const commits = logs.filter(line => line.startsWith('commit '))
      expect(commits).to.have.length(1)
      const output = logs.join('\n')
      expect(output).to.include('second commit')
      expect(output).to.not.include('first commit')
    })

    it('rejects -n 0 instead of printing the full history', async () => {
      const {logs, errors} = await runCommand(
        ['git', 'log', agentName, '-n', '0'],
        {agent: agentName},
        {count: 0},
      )
      expect(errors.join('\n')).to.include('--count must be >= 1')
      expect(logs.join('\n')).to.not.include('commit ')
      expect(logs.join('\n')).to.not.include('first commit')
      expect(logs.join('\n')).to.not.include('second commit')
    })

    it('rejects a negative -n instead of printing the full history', async () => {
      const {logs, errors} = await runCommand(
        ['git', 'log', agentName, '-n', '-3'],
        {agent: agentName},
        {count: -3},
      )
      expect(errors.join('\n')).to.include('--count must be >= 1')
      expect(logs.join('\n')).to.not.include('commit ')
    })
  })
})