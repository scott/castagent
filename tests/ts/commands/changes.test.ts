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

describe('changes command', () => {
  let Changes: any

  before(async () => {
    Changes = await loadTestCommand('changes')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Changes.description).to.equal('List all changes of an agent')
    })

    it('should require agent argument', () => {
      expect(Changes.args.agent.required).to.be.true
      expect(Changes.args.agent.description).to.equal('Agent name')
    })

    it('should have json flag', () => {
      expect(Changes.flags.json).to.exist
      expect(Changes.flags.json.default).to.equal(false)
    })

    it('should have examples', () => {
      expect(Changes.examples).to.be.an('array')
      expect(Changes.examples.length).to.be.greaterThan(0)
    })
  })

  describe('command behavior', () => {
    const agentName = `changes-test-${Date.now()}`
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

    it('should show empty message when no changes file exists', async () => {
      const instance = new Changes(['changes', agentName], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()
      const combined = logs.join('\n')
      expect(combined).to.include('No changes found')
    })

    it('should read changes from new changes/ location', async () => {
      const changesDir = path.join(realAgentDir, '.cast', 'changes')
      fs.mkdirSync(changesDir, {recursive: true})
      fs.writeFileSync(
        path.join(changesDir, 'changes.json'),
        JSON.stringify({
          current: 2,
          versions: [
            {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'Initial'},
            {id: 2, timestamp: '2024-01-02T00:00:00Z', source: 'cli', message: 'Updated'},
          ],
        })
      )

      const instance = new Changes(['changes', agentName], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()
      const combined = logs.join('\n')
      expect(combined).to.include('Current change: 2')
      expect(combined).to.include('v1')
      expect(combined).to.include('v2')
      expect(combined).to.include('Initial')
      expect(combined).to.include('Updated')
    })

    it('should fall back to old versions/ location when changes/ does not exist', async () => {
      const versionsDir = path.join(realAgentDir, '.cast', 'versions')
      fs.mkdirSync(versionsDir, {recursive: true})
      fs.writeFileSync(
        path.join(versionsDir, 'versions.json'),
        JSON.stringify({
          current: 1,
          versions: [
            {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'Old format'},
          ],
        })
      )

      const instance = new Changes(['changes', agentName], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()
      const combined = logs.join('\n')
      expect(combined).to.include('Current change: 1')
      expect(combined).to.include('Old format')
    })

    it('should label create source as CREATED', async () => {
      const changesDir = path.join(realAgentDir, '.cast', 'changes')
      fs.mkdirSync(changesDir, {recursive: true})
      fs.writeFileSync(
        path.join(changesDir, 'changes.json'),
        JSON.stringify({
          current: 1,
          versions: [
            {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'First'},
          ],
        })
      )

      const instance = new Changes(['changes', agentName], {} as any)
      instance.config = {runHook: async () => ({successes: [], failures: []})}
      instance.parse = async () => ({
        args: {agent: agentName},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()
      const combined = logs.join('\n')
      expect(combined).to.include('CREATED')
    })

    it('should output JSON when --json flag is set', async () => {
      const changesDir = path.join(realAgentDir, '.cast', 'changes')
      fs.mkdirSync(changesDir, {recursive: true})
      fs.writeFileSync(
        path.join(changesDir, 'changes.json'),
        JSON.stringify({
          current: 1,
          versions: [
            {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'JSON test'},
          ],
        })
      )

      // Spy on console.log
      const originalLog = console.log
      let captured = ''
      console.log = (msg: string) => {
        captured = msg
      }

      try {
        const instance = new Changes(['changes', agentName, '--json'], {} as any)
        instance.config = {runHook: async () => ({successes: [], failures: []})}
        instance.parse = async () => ({
          args: {agent: agentName},
          flags: {json: true},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        })

        instance.log = () => {}
        instance.error = (msg: string) => {
          throw new Error(msg)
        }

        await instance.run()
        const parsed = JSON.parse(captured)
        expect(parsed.current).to.equal(1)
        expect(parsed.versions).to.have.length(1)
        expect(parsed.versions[0].message).to.equal('JSON test')
      } finally {
        console.log = originalLog
      }
    })
  })
})
