import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'

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
  })
})
