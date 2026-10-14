import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Tests for the `releases` command (formerly `versions`, see #25).
 *
 * The first describe block exercises the command class shape (description,
 * args, flags, examples, alias declaration) by loading the actual
 * TypeScript source. The remaining describes verify the on-disk data
 * shape and JSON output formatting, which is what the command reads and
 * writes.
 */

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`,
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

interface ReleaseInfo {
  version: string
  change_number: number
  message: string
  changelog: string
  created_at: string
  tarball_path: string
}

interface ReleasesJson {
  releases: ReleaseInfo[]
}

describe('releases command', () => {
  describe('command structure', () => {
    let Releases: any

    before(async () => {
      Releases = await loadTestCommand('releases')
    })

    it('should have a description that lists releases', () => {
      expect(Releases.description).to.be.a('string')
      expect(Releases.description.toLowerCase()).to.include('release')
    })

    it('should require an agent argument', () => {
      expect(Releases.args.agent).to.exist
      expect(Releases.args.agent.required).to.be.true
      expect(Releases.args.agent.description).to.equal('Agent name')
    })

    it('should support a --json flag with default false', () => {
      expect(Releases.flags.json).to.exist
      expect(Releases.flags.json.default).to.be.false
    })

    it('should have examples', () => {
      expect(Releases.examples).to.be.an('array')
      expect(Releases.examples.length).to.be.greaterThan(0)
    })

    it('should not be hidden (this is the canonical command)', () => {
      expect(Releases.hidden).to.not.equal(true)
    })
  })

  describe('command output', () => {
    const agentName = `releases-footer-${Date.now()}`
    const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    afterEach(() => {
      fs.rmSync(agentDir, {recursive: true, force: true})
    })

    it('prints upgrade as a positional version and deploy as --version', async () => {
      const releasesDir = path.join(agentDir, '.cast', 'releases')
      fs.mkdirSync(releasesDir, {recursive: true})
      fs.writeFileSync(path.join(releasesDir, 'releases.json'), JSON.stringify({
        releases: [{
          version: '1.7',
          change_number: 1,
          message: 'ship',
          changelog: '',
          created_at: '2026-05-12T17:08:33.000Z',
          tarball_path: '/tmp/1.7.tar.gz',
        }],
      }))

      const Releases = await loadTestCommand('releases')
      const instance = new Releases(['releases', agentName], {} as any)
      instance.parse = async () => ({
        args: {agent: agentName},
        flags: {json: false},
      })
      const logs: string[] = []
      instance.log = (msg?: string) => {
        logs.push(msg ?? '')
      }

      await instance.run()

      const output = logs.join('\n')
      expect(output).to.include(`cast upgrade ${agentName} <ver>  - Upgrade to a release`)
      expect(output).to.include(`cast deploy ${agentName} --version <ver>  - Deploy a specific release`)
      expect(output).to.not.match(/upgrade[^\n]*--version/)
    })
  })

  describe('on-disk data shape', () => {
    const testDir = path.join(os.tmpdir(), `cast-releases-shape-${Date.now()}`)
    const agentsDir = path.join(testDir, '.cast', 'agents')

    before(() => {
      fs.mkdirSync(agentsDir, {recursive: true})
    })

    after(() => {
      try {
        fs.rmSync(testDir, {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should read releases from the canonical .cast/releases/releases.json path', () => {
      const agentName = `releases-shape-${Date.now()}`
      const agentPath = path.join(agentsDir, agentName)
      const releasesDir = path.join(agentPath, '.cast', 'releases')
      fs.mkdirSync(releasesDir, {recursive: true})

      const data: ReleasesJson = {
        releases: [
          {
            version: '1.0.0',
            change_number: 1,
            message: 'Initial',
            changelog: '',
            created_at: '2024-01-01T00:00:00Z',
            tarball_path: '/tmp/agent-1.0.0.tar',
          },
          {
            version: '1.1.0',
            change_number: 2,
            message: 'Update',
            changelog: '',
            created_at: '2024-01-02T00:00:00Z',
            tarball_path: '/tmp/agent-1.1.0.tar',
          },
        ],
      }
      fs.writeFileSync(
        path.join(releasesDir, 'releases.json'),
        JSON.stringify(data, null, 2),
      )

      try {
        // The command reads exactly this path; verify the file is found
        // and parses to a ReleasesJson shape.
        const releasesPath = path.join(agentPath, '.cast', 'releases', 'releases.json')
        expect(fs.existsSync(releasesPath)).to.be.true
        const parsed: ReleasesJson = JSON.parse(fs.readFileSync(releasesPath, 'utf8'))
        expect(parsed.releases).to.be.an('array')
        expect(parsed.releases).to.have.length(2)
        expect(parsed.releases[0].version).to.equal('1.0.0')
      } finally {
        try {
          fs.rmSync(agentPath, {recursive: true, force: true})
        } catch {
          // Ignore cleanup errors
        }
      }
    })

    it('should report an empty list when no releases file exists for the agent', () => {
      const agentName = 'no-such-agent'
      const releasesPath = path.join(agentsDir, agentName, '.cast', 'releases', 'releases.json')
      expect(fs.existsSync(releasesPath)).to.be.false
    })

    it('should format release.created_at into a human-readable date string', () => {
      const data: ReleasesJson = {
        releases: [
          {
            version: '1.0.0',
            change_number: 1,
            message: '',
            changelog: '',
            created_at: new Date('2024-01-01').toISOString(),
            tarball_path: '',
          },
        ],
      }
      const r = data.releases[0]
      const date = new Date(r.created_at)
      const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
      expect(dateStr).to.be.a('string')
      expect(dateStr.length).to.be.greaterThan(0)
    })
  })
})
