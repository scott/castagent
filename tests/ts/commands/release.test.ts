import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'
import * as yaml from 'yaml'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

describe('release command', () => {
  let Release: any

  before(async () => {
    Release = await loadTestCommand('release')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Release.description).to.equal('Create a semantic release for an agent')
    })

    it('should require agent argument', () => {
      expect(Release.args.agent.required).to.be.true
      expect(Release.args.agent.description).to.equal('Agent name')
    })

    it('should require version argument', () => {
      expect(Release.args.version.required).to.be.true
      expect(Release.args.version.description).to.include('Semantic version')
    })

    it('should have message flag', () => {
      expect(Release.flags.message).to.exist
      expect(Release.flags.message.description).to.equal('Release message')
    })

    it('should have examples', () => {
      expect(Release.examples).to.be.an('array')
      expect(Release.examples.length).to.be.greaterThan(0)
    })

    it('should include version in examples', () => {
      const hasVersionExample = Release.examples.some((ex: string) => /\d+\.\d+/.test(ex))
      expect(hasVersionExample).to.be.true
    })
  })

  describe('command behavior', () => {
    let sandbox: sinon.SinonSandbox
    // Use a name that the global cleanup knows about
    const agentName = `release-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const realAgentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      // Create a real agent directory in ~/.cast/agents/ so the existence
      // check passes.
      fs.mkdirSync(realAgentDir, {recursive: true})
      fs.writeFileSync(
        path.join(realAgentDir, 'agent.yaml'),
        yaml.stringify({
          name: agentName,
          version: '0.0',
          description: 'Test agent',
        })
      )
    })

    afterEach(() => {
      sandbox.restore()
      try {
        fs.rmSync(realAgentDir, {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should error when agent does not exist', async () => {
      const instance = new Release(['release', 'nonexistent-agent-name-zzz', '1.0'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: 'nonexistent-agent-name-zzz', version: '1.0'},
        flags: {},
        argv: ['release', 'nonexistent-agent-name-zzz', '1.0'],
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

    it('should error for invalid semantic version', async () => {
      const instance = new Release(['release', agentName, 'invalid'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName, version: 'invalid'},
        flags: {},
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

      expect(errorMessage).to.include('Invalid semantic version')
    })

    it('should error when version already exists', async () => {
      // Plant a releases.json that already has 1.0
      const releasesDir = path.join(realAgentDir, '.cast', 'releases')
      fs.mkdirSync(releasesDir, {recursive: true})
      fs.writeFileSync(
        path.join(releasesDir, 'releases.json'),
        JSON.stringify({
          releases: [{version: '1.0', change_number: 1, message: '', changelog: '', created_at: '', tarball_path: ''}],
          current: {version: '1.0', change_number: 1}
        })
      )

      // Stub out the Python-backed listReleases to return the existing release
      const releasesModule = require('../../../typescript/cast-cli/src/lib/releases')
      sandbox.stub(releasesModule, 'listReleases').resolves([
        {version: '1.0', change_number: 1, message: '', changelog: '', created_at: '', tarball_path: ''}
      ])

      const instance = new Release(['release', agentName, '1.0'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName, version: '1.0'},
        flags: {},
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

      expect(errorMessage).to.include('already exists')
    })

    it('should reject a release lower than agent.yaml and leave the file unchanged', async () => {
      const yamlPath = path.join(realAgentDir, 'agent.yaml')
      const original = [
        'name: bb-git',
        'version: 1.1.0',
        'description: "Keep this quoting"',
        'tools:',
        '  builtin:',
        '    - bash',
        '    - read',
        '    - glob',
        '',
      ].join('\n')
      fs.writeFileSync(yamlPath, original)

      const instance = new Release(['release', agentName, '1.0'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName, version: '1.0'},
        flags: {},
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

      expect(errorMessage).to.include('lower than')
      expect(errorMessage).to.include('1.1.0')
      expect(fs.readFileSync(yamlPath, 'utf8')).to.equal(original)
      expect(fs.existsSync(path.join(realAgentDir, '.cast', 'releases', 'releases.json'))).to.equal(false)
    })
  })
})
