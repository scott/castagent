import {expect} from 'chai'
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
  })
})
