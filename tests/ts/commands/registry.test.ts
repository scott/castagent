import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

describe('registry command', () => {
  let Registry: any

  before(async () => {
    Registry = await loadTestCommand('registry')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Registry.description).to.include('releases')
    })

    it('should have optional agent argument', () => {
      expect(Registry.args.agent).to.exist
      // Optional, no required: true
      expect(Registry.args.agent.required).to.be.undefined
    })

    it('should have json flag', () => {
      expect(Registry.flags.json).to.exist
      expect(Registry.flags.json.default).to.equal(false)
    })

    it('should have examples', () => {
      expect(Registry.examples).to.be.an('array')
      expect(Registry.examples.length).to.be.greaterThan(0)
    })
  })

  describe('command behavior', () => {
    it('should show empty message when no releases exist', async () => {
      // Use the live db but expect empty releases list
      // First clean any old test releases
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')

      const instance = new Registry(['registry'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      // Stub the database methods to return empty
      const original = db.listAllReleases
      db.listAllReleases = () => []

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      try {
        await instance.run()
      } finally {
        db.listAllReleases = original
      }

      const combined = logs.join('\n')
      expect(combined).to.include('No releases found')
    })

    it('should show all releases when they exist', async () => {
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
      const instance = new Registry(['registry'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      // Stub the database to return sample releases
      const sampleReleases = [
        {
          agent_name: 'demo-agent',
          version: '1.6',
          created_at: '2024-01-01T00:00:00Z',
          change_number: 5,
          message: 'Latest',
          changelog: '',
          tarball_path: '/tmp/1.6.tar.gz',
        },
        {
          agent_name: 'demo-agent',
          version: '1.0',
          created_at: '2023-12-01T00:00:00Z',
          change_number: 1,
          message: 'Initial',
          changelog: '',
          tarball_path: '/tmp/1.0.tar.gz',
        },
      ]
      const original = db.listAllReleases
      db.listAllReleases = () => sampleReleases

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      try {
        await instance.run()
      } finally {
        db.listAllReleases = original
      }

      const combined = logs.join('\n')
      expect(combined).to.include('demo-agent')
      expect(combined).to.include('1.6')
      expect(combined).to.include('1.0')
      expect(combined).to.include('Total: 2 release(s)')
    })

    it('should output JSON when --json flag is set', async () => {
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
      const instance = new Registry(['registry', '--json'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {},
        flags: {json: true},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const sampleReleases = [
        {
          agent_name: 'json-agent',
          version: '1.0',
          created_at: '2024-01-01T00:00:00Z',
          change_number: 1,
          message: 'JSON',
          changelog: '',
          tarball_path: '/tmp/1.0.tar.gz',
        },
      ]
      const original = db.listAllReleases
      db.listAllReleases = () => sampleReleases

      const originalLog = console.log
      let captured = ''
      console.log = (msg: string) => {
        captured = msg
      }

      try {
        instance.log = () => {}
        instance.error = (msg: string) => {
          throw new Error(msg)
        }

        await instance.run()
        const parsed = JSON.parse(captured)
        expect(parsed).to.have.length(1)
        expect(parsed[0].agent_name).to.equal('json-agent')
      } finally {
        console.log = originalLog
        db.listAllReleases = original
      }
    })

    it('should show deployment info when deployment is linked', async () => {
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
      const instance = new Registry(['registry'], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      // Release with a deployment
      const sampleReleases = [
        {
          agent_name: 'deployed-agent',
          version: '1.0',
          created_at: '2024-01-01T00:00:00Z',
          change_number: 1,
          message: 'Initial',
          changelog: '',
          tarball_path: '/tmp/1.0.tar.gz',
          deployment_sha: 'abc123',
          provider: 'railway',
        },
      ]
      const original = db.listAllReleases
      db.listAllReleases = () => sampleReleases

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      try {
        await instance.run()
      } finally {
        db.listAllReleases = original
      }

      const combined = logs.join('\n')
      expect(combined).to.include('DEPLOYED')
      expect(combined).to.include('RAILWAY')
      expect(combined).to.include('abc123')
    })

    describe('showAgentDeployments (agent name provided)', () => {
      const agentName = `registry-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const realAgentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

      beforeEach(() => {
        fs.mkdirSync(realAgentDir, {recursive: true})
        fs.writeFileSync(
          path.join(realAgentDir, 'agent.yaml'),
          'name: test\nversion: "1.0"'
        )
      })

      afterEach(() => {
        try {
          fs.rmSync(realAgentDir, {recursive: true, force: true})
        } catch {
          // Ignore cleanup errors
        }
      })

      it('should show empty message when agent has no deployments', async () => {
        const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
        const instance = new Registry(['registry', agentName], {} as any)
        instance.config = {runHook: async () => ({successes: [], failures: []})}
        instance.parse = async () => ({
          args: {agent: agentName},
          flags: {},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        })

        const original = db.listAllDeploymentsForAgent
        db.listAllDeploymentsForAgent = () => []

        const logs: string[] = []
        instance.log = (msg: string) => {
          logs.push(msg)
        }
        instance.error = (msg: string) => {
          throw new Error(msg)
        }

        try {
          await instance.run()
        } finally {
          db.listAllDeploymentsForAgent = original
        }

        const combined = logs.join('\n')
        expect(combined).to.include('No deployments found')
      })

      it('should show deployments for the agent in a table', async () => {
        const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
        const instance = new Registry(['registry', agentName], {} as any)
        instance.config = {runHook: async () => ({successes: [], failures: []})}
        instance.parse = async () => ({
          args: {agent: agentName},
          flags: {},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        })

        const sampleDeployments = [
          {
            deployment_sha: 'abc123',
            provider: 'railway',
            deployed_version: '1.6',
            deployed_at: '2024-01-01T00:00:00Z',
            deployment_url: 'https://example.com',
          },
        ]
        const original = db.listAllDeploymentsForAgent
        db.listAllDeploymentsForAgent = () => sampleDeployments

        const logs: string[] = []
        instance.log = (msg: string) => {
          logs.push(msg)
        }
        instance.error = (msg: string) => {
          throw new Error(msg)
        }

        try {
          await instance.run()
        } finally {
          db.listAllDeploymentsForAgent = original
        }

        const combined = logs.join('\n')
        expect(combined).to.include('Local Agent Registry')
        expect(combined).to.include(agentName)
        expect(combined).to.include('abc123')
        expect(combined).to.include('railway')
        expect(combined).to.include('1.6')
        expect(combined).to.include('https://example.com')
        expect(combined).to.include('Total: 1 deployment(s)')
      })
    })
  })
})
