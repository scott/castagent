import {expect} from 'chai'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

async function loadTestCommand(name: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'typescript',
    'cast-cli',
    'src',
    'commands',
    `${name}.ts`,
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

async function runCommand(Cmd: any, rawArgs: string[], args: any, flags: any): Promise<{logs: string[]; errors: string[]}> {
  const logs: string[] = []
  const errors: string[] = []
  const instance = new Cmd(rawArgs, {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({
    args,
    flags,
    argv: [],
    raw: [],
    metadata: {},
    nonExistentFlags: [],
  })
  instance.log = (msg: string) => logs.push(msg)
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

describe('cast undo / cast redo commands', () => {
  describe('undo command', () => {
    it('requires agent argument', async () => {
      const Undo = await loadTestCommand('undo')
      expect(Undo.args.agent.required).to.be.true
    })

    it('has --steps flag with default 1', async () => {
      const Undo = await loadTestCommand('undo')
      expect(Undo.flags.steps).to.exist
      expect(Undo.flags.steps.default).to.equal(1)
    })

    it('has --message flag', async () => {
      const Undo = await loadTestCommand('undo')
      expect(Undo.flags.message).to.exist
    })

    it('errors when agent does not exist', async () => {
      const Undo = await loadTestCommand('undo')
      const {errors} = await runCommand(
        Undo,
        ['undo', 'no-such-agent-zzz-987654321'],
        {agent: 'no-such-agent-zzz-987654321'},
        {steps: 1},
      )
      expect(errors.join('\n')).to.include('not found')
    })

    it('rejects --steps < 1', async () => {
      const Undo = await loadTestCommand('undo')
      const agentName = 'undo-cli-test-noop-' + Date.now()
      fs.mkdirSync(path.join(os.homedir(), '.cast', 'agents', agentName), {recursive: true})
      try {
        const {errors} = await runCommand(
          Undo,
          ['undo', agentName, '--steps', '0'],
          {agent: agentName},
          {steps: 0},
        )
        expect(errors.join('\n')).to.include('>= 1')
      } finally {
        fs.rmSync(path.join(os.homedir(), '.cast', 'agents', agentName), {recursive: true, force: true})
      }
    })

    it('reports Nothing to undo for an empty log without a Python traceback', async () => {
      const Undo = await loadTestCommand('undo')
      const agentName = 'undo-cli-test-empty-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), `name: ${agentName}\n`)
      const stderr = captureStderr()
      try {
        const {errors} = await runCommand(
          Undo,
          ['undo', agentName],
          {agent: agentName},
          {steps: 1},
        )
        const text = errors.join('\n')
        expect(text).to.include('Nothing to undo')
        expect(text).to.not.include('ModuleNotFoundError')
        expect(text).to.not.include('Traceback')
        expect(stderr()).to.not.include('Traceback')
        expect(stderr()).to.not.include('ModuleNotFoundError')
      } finally {
        stderr.restore()
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('runs cast.undo from the checkout, not ~/.cast/python', async () => {
      const Undo = await loadTestCommand('undo')
      const agentName = 'undo-cli-test-path-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      const checkout = path.resolve(__dirname, '../../../python')
      const stale = path.join(os.homedir(), '.cast', 'python')
      const undoLib = loadUndoLib()
      let command = ''
      let script = ''
      let options: childProcess.ExecFileSyncOptions | undefined
      undoLib._setExecPythonForTests((file: string, args: string[], opts: childProcess.ExecFileSyncOptionsWithStringEncoding) => {
        command = file
        options = opts
        script = fs.readFileSync(args[0], 'utf8')
        return 'false'
      })
      try {
        const {errors} = await runCommand(
          Undo,
          ['undo', agentName],
          {agent: agentName},
          {steps: 1},
        )
        expect(errors.join('\n')).to.include('Nothing to undo')
        expect(script).to.include('from cast.undo import *')
        expect(script).to.include(JSON.stringify(checkout))
        expect(script).to.not.include(JSON.stringify(stale))
        expect(options?.stdio).to.deep.equal(['ignore', 'pipe', 'pipe'])
        const pythonPath = String(options?.env?.PYTHONPATH || '').split(path.delimiter)[0]
        expect(pythonPath).to.equal(checkout)
        const venvPython3 = path.join(checkout, '.venv', 'bin', 'python3')
        const venvPython = path.join(checkout, '.venv', 'bin', 'python')
        if (fs.existsSync(venvPython3)) expect(command).to.equal(venvPython3)
        else if (fs.existsSync(venvPython)) expect(command).to.equal(venvPython)
        else expect(command).to.equal(process.platform === 'win32' ? 'python' : 'python3')
      } finally {
        undoLib._setExecPythonForTests(null)
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('reports a Python import failure instead of Nothing to undo', async () => {
      const Undo = await loadTestCommand('undo')
      const agentName = 'undo-cli-test-import-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      const undoLib = loadUndoLib()
      const failure = Object.assign(new Error('Command failed: python3 /tmp/cast_undo.py'), {
        stderr: [
          'Traceback (most recent call last):',
          '  File "/tmp/cast_undo_x.py", line 4, in <module>',
          '    from cast.undo import *',
          "ModuleNotFoundError: No module named 'cast.undo'",
        ].join('\n'),
        status: 1,
      })
      undoLib._setExecPythonForTests(() => {
        throw failure
      })
      try {
        const {errors} = await runCommand(
          Undo,
          ['undo', agentName],
          {agent: agentName},
          {steps: 1},
        )
        const text = errors.join('\n')
        expect(text).to.include("No module named 'cast.undo'")
        expect(text).to.not.include('Nothing to undo')
        expect(text).to.not.include('Traceback')
      } finally {
        undoLib._setExecPythonForTests(null)
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })
  })

  describe('redo command', () => {
    it('requires agent argument', async () => {
      const Redo = await loadTestCommand('redo')
      expect(Redo.args.agent.required).to.be.true
    })

    it('has --steps flag with default 1', async () => {
      const Redo = await loadTestCommand('redo')
      expect(Redo.flags.steps).to.exist
      expect(Redo.flags.steps.default).to.equal(1)
    })

    it('errors when agent does not exist', async () => {
      const Redo = await loadTestCommand('redo')
      const {errors} = await runCommand(
        Redo,
        ['redo', 'no-such-agent-zzz-987654321'],
        {agent: 'no-such-agent-zzz-987654321'},
        {steps: 1},
      )
      expect(errors.join('\n')).to.include('not found')
    })

    it('rejects --steps < 1', async () => {
      const Redo = await loadTestCommand('redo')
      const agentName = 'redo-cli-test-noop-' + Date.now()
      fs.mkdirSync(path.join(os.homedir(), '.cast', 'agents', agentName), {recursive: true})
      try {
        const {errors} = await runCommand(
          Redo,
          ['redo', agentName, '--steps', '0'],
          {agent: agentName},
          {steps: 0},
        )
        expect(errors.join('\n')).to.include('>= 1')
      } finally {
        fs.rmSync(path.join(os.homedir(), '.cast', 'agents', agentName), {recursive: true, force: true})
      }
    })

    it('reports a Python import failure instead of Nothing to redo', async () => {
      const Redo = await loadTestCommand('redo')
      const agentName = 'redo-cli-test-import-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      const undoLib = loadUndoLib()
      const failure = Object.assign(new Error('Command failed: python3 /tmp/cast_undo.py'), {
        stderr: "ModuleNotFoundError: No module named 'cast.undo'\n",
        status: 1,
      })
      undoLib._setExecPythonForTests(() => {
        throw failure
      })
      try {
        const {errors} = await runCommand(
          Redo,
          ['redo', agentName],
          {agent: agentName},
          {steps: 1},
        )
        const text = errors.join('\n')
        expect(text).to.include("No module named 'cast.undo'")
        expect(text).to.not.include('Nothing to redo')
      } finally {
        undoLib._setExecPythonForTests(null)
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })
  })
})

function loadUndoLib(): {
  _setExecPythonForTests: (impl: ((
    command: string,
    args: string[],
    options: childProcess.ExecFileSyncOptionsWithStringEncoding,
  ) => string) | null) => void
} {
  return require('../../../typescript/cast-cli/src/lib/undo')
}

function captureStderr(): (() => string) & {restore: () => void} {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    return true
  }) as typeof process.stderr.write
  const read = (() => chunks.join('')) as (() => string) & {restore: () => void}
  read.restore = () => {
    process.stderr.write = original
  }
  return read
}
