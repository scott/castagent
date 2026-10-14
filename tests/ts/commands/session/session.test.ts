import {Parser} from '@oclif/core'
import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

function shellTokens(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

async function loadTestCommand(parts: string[]): Promise<any> {
  // __dirname is tests/ts/commands/session, so we need to go up three levels
  // to reach the workspace root, then into the commands tree.
  const commandPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'typescript',
    'cast-cli',
    'src',
    'commands',
    ...parts,
  ) + '.ts'
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

describe('session CLI commands', () => {
  // Use an isolated temp dir as the cast home so we don't pollute the real one
  const tempHome = path.join(os.tmpdir(), `cast-session-cli-test-${Date.now()}`)
  const realHome = os.homedir()

  before(() => {
    process.env.CAST_TEST_HOME = tempHome
    fs.mkdirSync(path.join(tempHome, 'agents'), {recursive: true})
    // Symlink the python package so SessionStore can import it
    try {
      fs.symlinkSync(
        path.join(realHome, '.cast', 'python'),
        path.join(tempHome, 'python'),
      )
    } catch {
      // If we can't symlink, skip — the python call will fail
    }
  })

  after(() => {
    try {
      fs.rmSync(tempHome, {recursive: true, force: true})
    } catch {
      // ignore
    }
  })

  describe('session (parent) command', () => {
    it('prints subcommand list', async () => {
      const Session = await loadTestCommand(['session', 'index'])
      const {logs} = await runCommand(Session, ['session'], {}, {})
      const combined = logs.join('\n')
      expect(combined).to.include('list')
      expect(combined).to.include('show')
      expect(combined).to.include('new')
      expect(combined).to.include('resume')
      expect(combined).to.include('rename')
      expect(combined).to.include('fork')
      expect(combined).to.include('delete')
      expect(combined).to.include('export')
      expect(combined).to.include('import')
      expect(combined).to.include('prune')
    })
  })

  describe('session list', () => {
    it('has correct description and flags', async () => {
      const Cmd = await loadTestCommand(['session', 'list'])
      expect(Cmd.description).to.include('sessions')
      expect(Cmd.flags.agent).to.exist
      expect(Cmd.flags.limit.default).to.equal(50)
      expect(Cmd.flags.json.default).to.be.false
    })
  })

  describe('session show', () => {
    it('errors when session is not found', async () => {
      const Cmd = await loadTestCommand(['session', 'show'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'show', 'nonexistent-id-zzz'],
        {identifier: 'nonexistent-id-zzz'},
        {},
      )
      expect(errors.join('\n')).to.include('not found')
    })
  })

  describe('session new', () => {
    it('errors when agent does not exist', async () => {
      const Cmd = await loadTestCommand(['session', 'new'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'new', 'no-such-agent-zzz'],
        {agent: 'no-such-agent-zzz'},
        {},
      )
      expect(errors.join('\n')).to.include('not found')
    })

    it('has correct flags and default mode', async () => {
      const Cmd = await loadTestCommand(['session', 'new'])
      expect(Cmd.flags.mode.default).to.equal('build')
      expect(Cmd.flags['ui-mode'].default).to.equal('dev')
      expect(Cmd.args.agent.required).to.be.true
    })
  })

  describe('session resume', () => {
    it('requires an identifier argument', async () => {
      const Cmd = await loadTestCommand(['session', 'resume'])
      expect(Cmd.args.identifier.required).to.be.true
    })
  })

  describe('session rename', () => {
    it('requires both identifier and name', async () => {
      const Cmd = await loadTestCommand(['session', 'rename'])
      expect(Cmd.args.identifier.required).to.be.true
      expect(Cmd.args.name.required).to.be.true
    })

    it('errors when session is not found', async () => {
      const Cmd = await loadTestCommand(['session', 'rename'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'rename', 'nope-zzz', 'new-name'],
        {identifier: 'nope-zzz', name: 'new-name'},
        {},
      )
      expect(errors.join('\n')).to.match(/not found|not found/i)
    })
  })

  describe('session fork', () => {
    it('help examples use --name and parse', async () => {
      const Cmd = await loadTestCommand(['session', 'fork'])
      const Session = await loadTestCommand(['session', 'index'])
      const List = await loadTestCommand(['session', 'list'])

      const forkExample = Session.examples.find((example: string) => example.includes('session fork'))
      expect(forkExample).to.equal('<%= config.bin %> session fork <id> [--name <name>]')
      expect(forkExample).to.not.include('[name]')

      const hints = List.commandHints.join('\n')
      expect(hints).to.include('cast session fork <id|name> --name')
      expect(hints).to.not.include('[name]')

      for (const example of Cmd.examples as string[]) {
        const rendered = example
          .replace(/<%= config.bin %>/g, 'cast')
          .replace(/<%= command.id %>/g, 'session fork')
        const argv = shellTokens(rendered).slice(3)
        const parsed = await Parser.parse(argv, {
          args: Cmd.args,
          flags: Cmd.flags,
          strict: true,
        })
        expect(parsed.args.identifier).to.be.a('string').and.not.empty
        if (rendered.includes('--name')) {
          expect(parsed.flags.name).to.equal('alt approach')
        }
      }
    })

    it('rejects a positional name and accepts --name', async () => {
      const Cmd = await loadTestCommand(['session', 'fork'])
      const flags = {args: Cmd.args, flags: Cmd.flags, strict: true}

      try {
        await Parser.parse(['01JABC', 'alt approach'], flags)
        expect.fail('positional name should be rejected')
      } catch (error: any) {
        expect(error.message).to.match(/Unexpected argument: alt approach/)
        expect(error.oclif.exit).to.equal(2)
      }

      const parsed = await Parser.parse(['01JABC', '--name', 'alt approach'], flags)
      expect(parsed.args.identifier).to.equal('01JABC')
      expect(parsed.flags.name).to.equal('alt approach')
    })

    it('errors when source session is not found', async () => {
      const Cmd = await loadTestCommand(['session', 'fork'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'fork', 'nope-zzz'],
        {identifier: 'nope-zzz'},
        {},
      )
      expect(errors.join('\n')).to.match(/not found|not found/i)
    })
  })

  describe('session delete', () => {
    it('prompts without --force and skips deletion', async () => {
      const Cmd = await loadTestCommand(['session', 'delete'])
      // Use a synthetic id we know doesn't exist so it errors first
      const {errors} = await runCommand(
        Cmd,
        ['session', 'delete', 'synthetic-zzz'],
        {identifier: 'synthetic-zzz'},
        {},
      )
      expect(errors.join('\n')).to.include('not found')
    })

    it('has --force flag', async () => {
      const Cmd = await loadTestCommand(['session', 'delete'])
      expect(Cmd.flags.force).to.exist
      expect(Cmd.flags.force.default).to.be.false
    })
  })

  describe('session export', () => {
    it('errors when session is not found', async () => {
      const Cmd = await loadTestCommand(['session', 'export'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'export', 'nope-zzz'],
        {identifier: 'nope-zzz'},
        {},
      )
      expect(errors.join('\n')).to.match(/not found|not found/i)
    })
  })

  describe('session import', () => {
    it('errors when file is missing', async () => {
      const Cmd = await loadTestCommand(['session', 'import'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'import', '/tmp/does-not-exist-cast-cli-zzz.json'],
        {file: '/tmp/does-not-exist-cast-cli-zzz.json'},
        {},
      )
      expect(errors.join('\n')).to.include('not found')
    })

    it('has --keep-id flag', async () => {
      const Cmd = await loadTestCommand(['session', 'import'])
      expect(Cmd.flags['keep-id']).to.exist
      expect(Cmd.flags['keep-id'].default).to.be.false
    })
  })

  describe('session prune', () => {
    it('rejects --days < 1', async () => {
      const Cmd = await loadTestCommand(['session', 'prune'])
      const {errors} = await runCommand(
        Cmd,
        ['session', 'prune', '--days', '0'],
        {},
        {days: 0},
      )
      expect(errors.join('\n')).to.include('>= 1')
    })

    it('prompts without --force and skips deletion', async () => {
      const Cmd = await loadTestCommand(['session', 'prune'])
      const {logs} = await runCommand(
        Cmd,
        ['session', 'prune', '--days', '30'],
        {},
        {days: 30},
      )
      expect(logs.join('\n')).to.include('Re-run with --force')
    })
  })
})
