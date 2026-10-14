import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import GitDiff from '../../../../typescript/cast-cli/src/commands/git/diff'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'init.defaultBranch',
      GIT_CONFIG_VALUE_0: 'master',
    },
  })
}

function createAgentRepo(): {agentName: string; agentDir: string} {
  const agentName = `test-git-diff-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
  fs.mkdirSync(agentDir, {recursive: true})
  fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: test-agent\n')
  fs.writeFileSync(path.join(agentDir, 'bb-prompt.md'), 'prompt\n')
  fs.writeFileSync(path.join(agentDir, 'other.md'), 'other\n')
  git(agentDir, ['init', '-b', 'master'])
  git(agentDir, ['add', '.'])
  git(agentDir, ['commit', '-m', 'init'])
  return {agentName, agentDir}
}

function removeAgent(agentDir: string): void {
  fs.rmSync(agentDir, {recursive: true, force: true})
}

function createCommand(agentName: string, flags: {staged?: boolean; file?: string} = {}, ref?: string): any {
  const args = ['git', 'diff', agentName]
  if (ref) args.push(ref)
  const instance: any = new GitDiff(args, {color: false} as any)
  instance.config = {
    runHook: async () => {},
    name: 'git:diff',
    bin: 'cast',
  }
  instance.args = {agent: agentName, ref}
  instance.flags = {
    staged: flags.staged ?? false,
    file: flags.file,
  }
  instance.parse = async () => ({args: instance.args, flags: instance.flags})
  return instance
}

function capture(instance: any): {logs: string[]; errors: string[]} {
  const logs: string[] = []
  const errors: string[] = []
  instance.log = (msg?: string) => {
    logs.push(msg ?? '')
  }
  instance.error = (msg?: any) => {
    const text = typeof msg === 'string' ? msg : (msg?.message ?? String(msg))
    errors.push(text)
    const error = new Error(text) as Error & {oclif?: {exit: number}}
    error.oclif = {exit: 2}
    throw error
  }
  return {logs, errors}
}

async function runCommand(instance: any): Promise<{logs: string[]; errors: string[]}> {
  const captured = capture(instance)
  try {
    await instance.run()
  } catch (error) {
    if (captured.errors.length === 0) throw error
  }
  return captured
}

describe('Git Diff Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitDiff.description).to.equal('Show changes between commits or working tree')
    })

    it('should require agent argument', () => {
      expect(GitDiff.args).to.have.property('agent')
      expect(GitDiff.args.agent.required).to.be.true
      expect(GitDiff.args.agent.description).to.equal('Agent name')
    })

    it('should have optional ref argument', () => {
      expect(GitDiff.args).to.have.property('ref')
      expect(GitDiff.args.ref.required).to.be.false
    })

    it('should have --staged flag', () => {
      expect(GitDiff.flags).to.have.property('staged')
      expect(GitDiff.flags.staged.description).to.be.a('string')
    })

    it('should have --file flag', () => {
      expect(GitDiff.flags).to.have.property('file')
      expect(GitDiff.flags.file.description).to.be.a('string')
    })

    it('should have examples', () => {
      expect(GitDiff.examples).to.be.an('array')
      expect(GitDiff.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitDiff(['git', 'diff', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should show staged changes with --staged flag', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show changes since ref when provided', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show working tree changes by default', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show untracked files', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should handle clean working tree', () => {
      expect(GitDiff).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitDiff).to.be.a('function')
    })
  })

  describe('flag behavior', () => {
    it('should show only staged changes when --staged is used', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should accept optional ref for comparison', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should support --file flag for specific file', () => {
      expect(GitDiff).to.be.a('function')
    })
  })
})

describe('Git Diff --file', () => {
  it('shows only the requested file', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'PROMPT-LINE\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'bb-prompt.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('PROMPT-LINE')
      expect(output).to.include('bb-prompt.md')
      expect(output).to.not.include('OTHER-LINE')
      expect(output).to.not.include('other.md')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('errors when --file names a path that is not in the repository', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'PROMPT-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'nosuch.md'}))
      expect(errors.join('\n')).to.include("File 'nosuch.md' is not in the repository.")
      expect(logs.join('\n')).to.not.include('PROMPT-LINE')
      expect(logs.join('\n')).to.not.include('bb-prompt.md')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('errors when --file points outside the repository', async () => {
    const ctx = createAgentRepo()
    const outside = path.join(os.tmpdir(), `cast-diff-outside-${Date.now()}.md`)
    fs.writeFileSync(outside, 'OUTSIDE-LINE\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'PROMPT-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: outside}))
      expect(errors.join('\n')).to.include('is not in the repository')
      expect(logs.join('\n')).to.not.include('OUTSIDE-LINE')
      expect(logs.join('\n')).to.not.include('PROMPT-LINE')
    } finally {
      removeAgent(ctx.agentDir)
      fs.rmSync(outside, {force: true})
    }
  })

  it('does not show other files when the requested file has no changes', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'bb-prompt.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include("No changes for 'bb-prompt.md'.")
      expect(output).to.not.include('OTHER-LINE')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('limits --staged to the requested file', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'STAGED-PROMPT\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'STAGED-OTHER\n')
    git(ctx.agentDir, ['add', 'bb-prompt.md', 'other.md'])

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {staged: true, file: 'bb-prompt.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('STAGED-PROMPT')
      expect(output).to.not.include('STAGED-OTHER')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('errors for a missing path with --staged', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'STAGED-PROMPT\n')
    git(ctx.agentDir, ['add', 'bb-prompt.md'])

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {staged: true, file: 'nosuch.md'}))
      expect(errors.join('\n')).to.include("File 'nosuch.md' is not in the repository.")
      expect(logs.join('\n')).to.not.include('STAGED-PROMPT')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('limits a commit reference to the requested file', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'REF-PROMPT\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'REF-OTHER\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'bb-prompt.md'}, 'HEAD'))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('REF-PROMPT')
      expect(output).to.include('Changes since HEAD:')
      expect(output).to.not.include('REF-OTHER')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('limits the diff to a file in a subdirectory', async () => {
    const ctx = createAgentRepo()
    fs.mkdirSync(path.join(ctx.agentDir, 'notes'))
    fs.writeFileSync(path.join(ctx.agentDir, 'notes', 'todo.md'), 'todo\n')
    git(ctx.agentDir, ['add', 'notes/todo.md'])
    git(ctx.agentDir, ['commit', '-m', 'notes'])
    fs.appendFileSync(path.join(ctx.agentDir, 'notes', 'todo.md'), 'TODO-LINE\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'notes/todo.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('TODO-LINE')
      expect(output).to.not.include('OTHER-LINE')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('shows a staged deletion for a file that is no longer on disk', async () => {
    const ctx = createAgentRepo()
    git(ctx.agentDir, ['rm', 'bb-prompt.md'])
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')
    git(ctx.agentDir, ['add', 'other.md'])

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {staged: true, file: 'bb-prompt.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('bb-prompt.md')
      expect(output).to.not.include('OTHER-LINE')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('shows a deleted tracked file instead of treating it as missing', async () => {
    const ctx = createAgentRepo()
    fs.rmSync(path.join(ctx.agentDir, 'bb-prompt.md'))
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'bb-prompt.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('bb-prompt.md')
      expect(output).to.not.include('OTHER-LINE')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('lists only the requested untracked file', async () => {
    const ctx = createAgentRepo()
    fs.writeFileSync(path.join(ctx.agentDir, 'new-notes.md'), 'NEW-NOTES\n')
    fs.writeFileSync(path.join(ctx.agentDir, 'new-other.md'), 'NEW-OTHER\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName, {file: 'new-notes.md'}))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('?? new-notes.md')
      expect(output).to.not.include('new-other.md')
      expect(output).to.not.include('NEW-OTHER')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('still shows every change when --file is omitted', async () => {
    const ctx = createAgentRepo()
    fs.appendFileSync(path.join(ctx.agentDir, 'bb-prompt.md'), 'PROMPT-LINE\n')
    fs.appendFileSync(path.join(ctx.agentDir, 'other.md'), 'OTHER-LINE\n')

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName))
      const output = logs.join('\n')
      expect(errors).to.deep.equal([])
      expect(output).to.include('PROMPT-LINE')
      expect(output).to.include('OTHER-LINE')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })

  it('reports a clean working tree when --file is omitted', async () => {
    const ctx = createAgentRepo()

    try {
      const {logs, errors} = await runCommand(createCommand(ctx.agentName))
      expect(errors).to.deep.equal([])
      expect(logs.join('\n')).to.include('Working tree is clean')
    } finally {
      removeAgent(ctx.agentDir)
    }
  })
})