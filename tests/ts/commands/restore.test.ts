import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

describe('restore command', () => {
  let Restore: any

  before(async () => {
    Restore = await loadTestCommand('restore')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Restore.description).to.include('Restore')
    })

    it('should require agent argument', () => {
      expect(Restore.args.agent.required).to.be.true
    })

    it('should have --release flag', () => {
      expect(Restore.flags.release).to.exist
      expect(Restore.flags.release.required).to.be.true
    })

    it('should not have a --change flag (use cast undo instead)', () => {
      expect(Restore.flags.change).to.be.undefined
    })

    it('should have examples', () => {
      expect(Restore.examples).to.be.an('array')
      expect(Restore.examples.length).to.be.greaterThan(0)
    })
  })

  describe('command behavior', () => {
    const agentName = `restore-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const realAgentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    beforeEach(() => {
      fs.mkdirSync(realAgentDir, {recursive: true})
    })

    afterEach(() => {
      try {
        fs.rmSync(realAgentDir, {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should error when agent does not exist', async () => {
      const instance = new Restore(['restore', 'nonexistent-agent-zzz', '--release', '1.0'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: 'nonexistent-agent-zzz'},
        flags: {release: '1.0'},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      let errorMessage = ''
      instance.error = (msg: string) => {
        errorMessage = msg
        throw new Error(msg)
      }
      instance.log = () => {}

      try {
        await instance.run()
      } catch (e: any) {
        // Expected
      }

      expect(errorMessage).to.include('not found')
    })

    it('should error when the specified release does not exist', async () => {
      // Empty releases dir
      const releasesDir = path.join(realAgentDir, '.cast', 'releases')
      fs.mkdirSync(releasesDir, {recursive: true})

      // Stub listReleases to return empty
      const releasesModule = require('../../../typescript/cast-cli/src/lib/releases')
      const sandbox = sinon.createSandbox()
      sandbox.stub(releasesModule, 'listReleases').resolves([])

      try {
        const instance = new Restore(['restore', agentName, '--release', '1.0'], {} as any)
        instance.config = {runHook: async () => ({successes: [], failures: []})}
        instance.parse = async () => ({
          args: {agent: agentName},
          flags: {release: '1.0'},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        })

        let errorMessage = ''
        instance.error = (msg: string) => {
          errorMessage = msg
          throw new Error(msg)
        }
        instance.log = () => {}

        try {
          await instance.run()
        } catch (e: any) {
          // Expected
        }

        expect(errorMessage).to.include('not found')
      } finally {
        sandbox.restore()
      }
    })

    it('restores the configured prompt and removes files added later', async () => {
      const prompt = path.join(realAgentDir, 'bb-prompt.md')
      const skillDir = path.join(realAgentDir, 'skills', 'triage')
      const toolsDir = path.join(realAgentDir, 'tools')
      fs.mkdirSync(skillDir, {recursive: true})
      fs.mkdirSync(toolsDir, {recursive: true})
      fs.writeFileSync(path.join(realAgentDir, 'agent.yaml'), 'name: bb-git\nversion: "0.0"\nbrain:\n  instructions_file: bb-prompt.md\n')
      fs.writeFileSync(path.join(realAgentDir, 'instructions.md'), '# unused leftover\n')
      fs.writeFileSync(prompt, 'PROMPT v1\n')
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# triage\n')
      fs.writeFileSync(path.join(toolsDir, 'old.py'), '# old\n')
      fs.writeFileSync(path.join(realAgentDir, '.env'), 'SECRET=1\n')
      fs.writeFileSync(path.join(realAgentDir, '.castignore'), '*.log\n.env\n__pycache__/\n')

      const releases = require('../../../typescript/cast-cli/src/lib/releases')
      await releases.createRelease(agentName, '1.0', 'bb rel')

      fs.writeFileSync(prompt, 'AFTER\n')
      fs.writeFileSync(path.join(toolsDir, 'bbnew.py'), '# new\n')
      fs.writeFileSync(path.join(realAgentDir, '.env'), 'SECRET=changed\n')

      try {
        const instance = new Restore(['restore', agentName, '--release', '1.0'], {} as any)
        instance.config = {runHook: async () => ({successes: [], failures: []})}
        instance.parse = async () => ({
          args: {agent: agentName},
          flags: {release: '1.0'},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        })
        instance.error = (msg: string) => {
          throw new Error(msg)
        }
        instance.log = () => {}

        await instance.run()

        expect(fs.readFileSync(prompt, 'utf8')).to.equal('PROMPT v1\n')
        expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).to.equal('# triage\n')
        expect(fs.readFileSync(path.join(toolsDir, 'old.py'), 'utf8')).to.equal('# old\n')
        expect(fs.existsSync(path.join(toolsDir, 'bbnew.py'))).to.equal(false)
        expect(fs.readFileSync(path.join(realAgentDir, '.env'), 'utf8')).to.equal('SECRET=changed\n')
        expect(fs.readFileSync(path.join(realAgentDir, 'instructions.md'), 'utf8')).to.equal('# unused leftover\n')
      } finally {
        try { db.deleteRelease(agentName, '1.0') } catch {}
      }
    })
  })
})
