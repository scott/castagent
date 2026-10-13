import {expect} from 'chai'
import * as path from 'path'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

function makeInstance(Registry: any, argv: string[], parsed: {args?: Record<string, any>; flags?: Record<string, any>}) {
  const instance = new Registry(argv, {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({
    args: parsed.args || {},
    flags: parsed.flags || {},
    argv: [],
    raw: [],
    metadata: {},
    nonExistentFlags: [],
  })
  const logs: string[] = []
  instance.log = (msg?: string) => {
    logs.push(msg ?? '')
  }
  instance.error = (msg: string) => {
    throw new Error(msg)
  }
  return {instance, logs}
}

describe('registry command', () => {
  let Registry: any

  before(async () => {
    Registry = await loadTestCommand('registry')
  })

  describe('command structure', () => {
    it('should describe a live deployment fleet', () => {
      expect(Registry.description).to.include('deployment')
      expect(Registry.description.toLowerCase()).to.not.include('release')
    })

    it('should have optional agent argument', () => {
      expect(Registry.args.agent).to.exist
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
    it('should show an empty message when no deployments exist', async () => {
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
      const {instance, logs} = makeInstance(Registry, ['registry'], {})
      const original = db.listActiveDeployments
      db.listActiveDeployments = () => []

      try {
        await instance.run()
      } finally {
        db.listActiveDeployments = original
      }

      expect(logs.join('\n')).to.include('No deployments found')
    })

    describe('live fleet from sqlite', () => {
      const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const alpha = `registry-agent-test-a-${suffix}`
      const beta = `registry-agent-test-b-${suffix}`
      const shaNew = `anew${suffix}`
      const shaOld = `aold${suffix}`
      const shaDeleted = `adel${suffix}`
      const shaEmpty = `bemp${suffix}`
      const unmatchedVersion = `106.4.${suffix.slice(-4)}`
      const releaseOnlyVersion = `106.0.${suffix.slice(-4)}`

      function setDeployedAt(id: string, deployedAt: string): void {
        const raw = (db as unknown as {db: {prepare: (sql: string) => {run: (...args: unknown[]) => void}}}).db
        raw.prepare('UPDATE deployments SET deployed_at = ? WHERE id = ?').run(deployedAt, id)
      }

      before(() => {
        db.createAgent(alpha, '/path/to/alpha.yaml')
        db.createAgent(beta, '/path/to/beta.yaml')
        db.createRelease(alpha, releaseOnlyVersion, 1, 'not deployed', '', '/tmp/unmatched.tar.gz')
        db.createDeployment(shaNew, alpha, 'microvm', 'https://alpha-new.example', 'hash', null, null, unmatchedVersion)
        db.createDeployment(shaOld, alpha, 'microvm', 'https://alpha-old.example', 'hash', null, null, unmatchedVersion)
        db.createDeployment(shaDeleted, alpha, 'railway', 'https://alpha-deleted.example', 'hash', null, null, '9.9.9')
        db.createDeployment(shaEmpty, beta, 'digitalocean', 'https://beta.example', 'hash', null, null, null)
        setDeployedAt(shaNew, '2026-08-02 12:00:00')
        setDeployedAt(shaOld, '2026-01-01 12:00:00')
        setDeployedAt(shaDeleted, '2026-12-01 12:00:00')
        setDeployedAt(shaEmpty, '2026-03-01 12:00:00')
        db.removeDeploymentBySha(shaDeleted)
      })

      after(() => {
        try { db.deleteAgent(alpha) } catch {}
        try { db.deleteAgent(beta) } catch {}
      })

      it('lists non-deleted deployments, including unmatched and empty versions, ordered by agent then newest deployed_at', async () => {
        const {instance, logs} = makeInstance(Registry, ['registry'], {})
        await instance.run()
        const combined = logs.join('\n')

        expect(combined).to.include('AGENT')
        expect(combined).to.include('SHA')
        expect(combined).to.include('PROVIDER')
        expect(combined).to.include('VERSION')
        expect(combined).to.include('DEPLOYED')
        expect(combined).to.include('URL')
        expect(combined).to.not.include(shaDeleted)
        expect(combined).to.not.include(releaseOnlyVersion)

        const fleetLines = logs.filter(line => line.includes(alpha) || line.includes(beta))
        expect(fleetLines.map(line => {
          if (line.includes(shaNew)) return shaNew
          if (line.includes(shaOld)) return shaOld
          if (line.includes(shaEmpty)) return shaEmpty
          return line
        })).to.deep.equal([shaNew, shaOld, shaEmpty])

        const newLine = fleetLines.find(line => line.includes(shaNew)) || ''
        const emptyLine = fleetLines.find(line => line.includes(shaEmpty)) || ''
        expect(newLine).to.include(alpha)
        expect(newLine).to.include('microvm')
        expect(newLine).to.include(unmatchedVersion)
        expect(newLine).to.include('https://alpha-new.example')
        expect(emptyLine).to.include(beta)
        expect(emptyLine).to.include('digitalocean')
        expect(emptyLine).to.include('—')
        expect(emptyLine).to.include('https://beta.example')
        expect(combined).to.match(/Total: \d+ deployment\(s\)/)
      })

      it('returns deployment objects as JSON', async () => {
        const {instance} = makeInstance(Registry, ['registry', '--json'], {flags: {json: true}})
        const originalLog = console.log
        let captured = ''
        console.log = (msg: string) => {
          captured = msg
        }

        try {
          await instance.run()
        } finally {
          console.log = originalLog
        }

        const parsed = JSON.parse(captured)
        const ours = parsed.filter((row: any) => row.agent_name === alpha || row.agent_name === beta)
        expect(ours.map((row: any) => row.id)).to.deep.equal([shaNew, shaOld, shaEmpty])
        expect(ours.find((row: any) => row.id === shaNew).deployed_version).to.equal(unmatchedVersion)
        expect(ours.find((row: any) => row.id === shaNew).provider).to.equal('microvm')
        expect(ours.find((row: any) => row.id === shaNew).deployment_url).to.equal('https://alpha-new.example')
        expect(ours.find((row: any) => row.id === shaNew).deployed_at).to.equal('2026-08-02 12:00:00')
        expect(ours.find((row: any) => row.id === shaEmpty).deployed_version).to.equal(null)
        expect(ours.some((row: any) => row.id === shaDeleted)).to.equal(false)
        expect(parsed.some((row: any) => row.deleted_at != null && (row.agent_name === alpha || row.agent_name === beta))).to.equal(false)
      })

      it('filters to one agent and does not require a matching release', async () => {
        const {instance, logs} = makeInstance(Registry, ['registry', alpha], {args: {agent: alpha}})
        await instance.run()
        const combined = logs.join('\n')

        expect(combined).to.include(`Local Agent Registry: ${alpha}`)
        expect(combined).to.include(shaNew)
        expect(combined).to.include(shaOld)
        expect(combined).to.include(unmatchedVersion)
        expect(combined).to.not.include(shaEmpty)
        expect(combined).to.not.include(shaDeleted)
        expect(combined).to.not.include(releaseOnlyVersion)
        expect(combined).to.include('Total: 2 deployment(s)')

        const dataLines = logs.filter(line => line.includes(shaNew) || line.includes(shaOld))
        expect(dataLines[0]).to.include(shaNew)
        expect(dataLines[1]).to.include(shaOld)
        expect(dataLines[0].includes(alpha)).to.equal(false)
      })

      it('shows an agent with an empty deployed_version and no release row', async () => {
        const {instance, logs} = makeInstance(Registry, ['registry', beta], {args: {agent: beta}})
        await instance.run()
        const combined = logs.join('\n')
        expect(combined).to.include(`Local Agent Registry: ${beta}`)
        expect(combined).to.include(shaEmpty)
        expect(combined).to.include('digitalocean')
        expect(combined).to.include('—')
        expect(combined).to.include('https://beta.example')
        expect(combined).to.not.include(shaNew)
        expect(db.listReleases(beta)).to.have.length(0)
      })

      it('returns that agent\'s deployment objects as JSON', async () => {
        const {instance} = makeInstance(Registry, ['registry', beta, '--json'], {
          args: {agent: beta},
          flags: {json: true},
        })
        const originalLog = console.log
        let captured = ''
        console.log = (msg: string) => {
          captured = msg
        }

        try {
          await instance.run()
        } finally {
          console.log = originalLog
        }

        const parsed = JSON.parse(captured)
        expect(parsed).to.have.length(1)
        expect(parsed[0].deployment_sha).to.equal(shaEmpty)
        expect(parsed[0].provider).to.equal('digitalocean')
        expect(parsed[0].deployed_version).to.equal(null)
        expect(parsed[0].deployment_url).to.equal('https://beta.example')
        expect(parsed[0].deployed_at).to.equal('2026-03-01 12:00:00')
      })

      it('shows an empty message when the agent has no deployments', async () => {
        const emptyAgent = `registry-agent-test-empty-${suffix}`
        db.createAgent(emptyAgent, '/path/to/empty.yaml')
        try {
          const {instance, logs} = makeInstance(Registry, ['registry', emptyAgent], {args: {agent: emptyAgent}})
          await instance.run()
          expect(logs.join('\n')).to.include(`No deployments found for agent '${emptyAgent}'`)
        } finally {
          db.deleteAgent(emptyAgent)
        }
      })
    })
  })
})
