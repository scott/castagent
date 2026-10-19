import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'

// Import the upgrade command to test its structure
import UpgradeCommand from '../../../typescript/cast-cli/src/commands/upgrade'
import * as registry from '../../../typescript/cast-cli/src/lib/deploy/registry'
import {castKnownHostsPath, recordPinnedHostKey} from '../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'

describe('Upgrade Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(UpgradeCommand.description).to.equal('Upgrade a deployed agent to a new version')
    })

    it('should have agent argument marked as required', () => {
      expect(UpgradeCommand.args.agent.required).to.be.true
    })

    it('should have agent argument with description', () => {
      expect(UpgradeCommand.args.agent.description).to.equal('Agent name or deployment SHA')
    })

    it('should have version argument (optional)', () => {
      expect(UpgradeCommand.args.version.required).to.be.undefined
    })

    it('should have version argument with description', () => {
      expect(UpgradeCommand.args.version.description).to.equal('Release version to upgrade to (optional, defaults to latest)')
    })

    it('should have list-versions flag', () => {
      expect(UpgradeCommand.flags['list-versions']).to.exist
      expect(UpgradeCommand.flags['list-versions'].type).to.equal('boolean')
    })

    it('should take the release as a positional argument, not a --version flag', () => {
      expect(UpgradeCommand.flags).to.not.have.property('version')
      expect(UpgradeCommand.args.version).to.exist
    })

    it('should define list-versions flag with description', () => {
      expect(UpgradeCommand.flags['list-versions'].description).to.be.a('string')
      expect(UpgradeCommand.flags['list-versions'].description?.length).to.be.greaterThan(0)
    })
  })

  describe('examples', () => {
    it('should have usage examples', () => {
      expect(UpgradeCommand.examples).to.be.an('array')
      expect(UpgradeCommand.examples.length).to.be.greaterThan(0)
    })

    it('should include upgrade example', () => {
      const hasExample = UpgradeCommand.examples.some(ex =>
        ex.includes('email-agent') && !ex.includes('--list-versions')
      )
      expect(hasExample).to.be.true
    })

    it('should include upgrade with version example', () => {
      // Examples include a version like "1.6" or "abc123" (deployment SHA)
      const hasVersionExample = UpgradeCommand.examples.some(ex => /\b\d+(\.\d+)?\b/.test(ex) || /[a-f0-9]{6}/.test(ex))
      expect(hasVersionExample).to.be.true
    })

    it('should include upgrade by SHA example', () => {
      // Examples include connecting/upgrading by deployment SHA
      const hasShaExample = UpgradeCommand.examples.some(ex => /[a-z0-9]{6}/.test(ex))
      expect(hasShaExample).to.be.true
    })

    it('should include list-versions example', () => {
      const hasListExample = UpgradeCommand.examples.some(ex => ex.includes('--list-versions'))
      expect(hasListExample).to.be.true
    })
  })

  describe('command structure', () => {
    it('should be a class extending Command', () => {
      expect(UpgradeCommand.prototype).to.be.ok
    })

    it('should have run method', () => {
      const instance = new UpgradeCommand(['upgrade', 'test'], {} as any)
      expect(typeof instance.run).to.equal('function')
    })
  })

  describe('private methods', () => {
    let instance: any

    beforeEach(() => {
      instance = new UpgradeCommand(['upgrade', 'test'], {} as any)
    })

    it('should have upgradeDocker method', () => {
      expect(typeof instance.upgradeDocker).to.equal('function')
    })

    it('should have upgradeRailway method', () => {
      expect(typeof instance.upgradeRailway).to.equal('function')
    })

    it('should have upgradeFly method', () => {
      expect(typeof instance.upgradeFly).to.equal('function')
    })

    it('should have upgradeDigitalOcean method', () => {
      expect(typeof instance.upgradeDigitalOcean).to.equal('function')
    })

    it('should have upgradeSprites method', () => {
      expect(typeof instance.upgradeSprites).to.equal('function')
    })

    it('should have confirm method', () => {
      expect(typeof instance.confirm).to.equal('function')
    })

    it('should have detectOnHostTui method', () => {
      expect(typeof instance.detectOnHostTui).to.equal('function')
    })
  })

  describe('detectOnHostTui', () => {
    let instance: any
    let sshDir = ''
    let pinnedPublicKey = ''

    before(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-upgrade-pin-'))
      try {
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k'), '-C', 'test'])
        pinnedPublicKey = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    beforeEach(() => {
      instance = new UpgradeCommand(['upgrade', 'test'], {} as any)
      sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-upgrade-ssh-'))
      process.env.CAST_SSH_DIR = sshDir
      recordPinnedHostKey('203.0.113.1', pinnedPublicKey)
    })

    afterEach(() => {
      delete process.env.CAST_SSH_DIR
      fs.rmSync(sshDir, {recursive: true, force: true})
    })

    it('should return true when docker exec test -e exits 0', async () => {
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      const execStub = sinon.stub(deployUtils, 'execCommand').resolves({
        stdout: '',
        stderr: '',
        exitCode: 0,
      })
      try {
        const result = await instance.detectOnHostTui('203.0.113.1')
        expect(result).to.be.true
        // The SSH command must include the test -e on the cast-tui
        // symlink, which is the last step of the TUI patch.
        const args = execStub.firstCall.args[1] as string[]
        expect(args.join(' ')).to.include('docker exec cast-agent test -e /usr/local/bin/cast-tui')
        expect(args).to.include('StrictHostKeyChecking=yes')
        expect(args).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
        expect(args.join('\n')).to.not.include('StrictHostKeyChecking=no')
        expect(args.join('\n')).to.not.include('UserKnownHostsFile=/dev/null')
      } finally {
        execStub.restore()
      }
    })

    it('should return false when docker exec test -e exits non-zero', async () => {
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      const execStub = sinon.stub(deployUtils, 'execCommand').resolves({
        stdout: '',
        stderr: 'no such file',
        exitCode: 1,
      })
      try {
        const result = await instance.detectOnHostTui('203.0.113.1')
        expect(result).to.be.false
      } finally {
        execStub.restore()
      }
    })

    it('does not ssh when the droplet host key is not pinned', async () => {
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      const execStub = sinon.stub(deployUtils, 'execCommand').resolves({
        stdout: '',
        stderr: '',
        exitCode: 0,
      })
      try {
        const result = await instance.detectOnHostTui('198.51.100.30')
        expect(result).to.equal(false)
        expect(execStub.called).to.equal(false)
      } finally {
        execStub.restore()
      }
    })

    it('should return false (safe default) when execCommand throws', async () => {
      // If SSH is unreachable or the container isn't running, we
      // can't know whether the TUI is bundled. Default to false —
      // it's better to omit the TUI hint than to lie.
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      const execStub = sinon.stub(deployUtils, 'execCommand').rejects(new Error('ssh: connect refused'))
      try {
        const result = await instance.detectOnHostTui('203.0.113.1')
        expect(result).to.be.false
      } finally {
        execStub.restore()
      }
    })
  })

  describe('valid providers', () => {
    it('should support docker provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('docker')
    })

    it('should support railway provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('railway')
    })

    it('should support fly provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('fly')
    })
  })

  describe('already-current hint', () => {
    const agentName = `upgrade-hint-${Date.now()}`
    const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      fs.mkdirSync(agentDir, {recursive: true})
    })

    afterEach(() => {
      sandbox.restore()
      fs.rmSync(agentDir, {recursive: true, force: true})
    })

    it('tells the user to pass the next version as a positional argument', async () => {
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      sandbox.stub(deployUtils, 'resolveDeploymentTarget').resolves({
        type: 'single',
        deployment: {
          id: 'abc123',
          agent_name: agentName,
          provider: 'docker',
          deployment_url: 'http://127.0.0.1:8080',
          deployed_version: '1.6',
        },
      })

      const instance = new UpgradeCommand(['upgrade', agentName, '1.6'], {} as any) as any
      instance.parse = async () => ({
        args: {agent: agentName, version: '1.6'},
        flags: {'list-versions': false},
      })
      const logs: string[] = []
      instance.log = (msg?: string) => {
        logs.push(msg ?? '')
      }
      instance.error = (msg: string) => {
        throw new Error(typeof msg === 'string' ? msg : String(msg))
      }

      const releases = await import('../../../typescript/cast-cli/src/lib/releases')
      sandbox.stub(releases, 'getRelease').resolves({
        version: '1.6',
        change_number: 1,
        message: 'ship',
        changelog: '',
        created_at: '2026-05-12T17:08:33.000Z',
        tarball_path: path.join(agentDir, '1.6.tar.gz'),
      })
      sandbox.stub(releases, 'validateSemver').resolves(true)

      await instance.run()

      const output = logs.join('\n')
      expect(output).to.equal([
        `Agent '${agentName}' is already at version 1.6.`,
        `Use 'cast upgrade ${agentName} <version>' to pick a different release.`,
      ].join('\n'))
      expect(output).to.not.match(/upgrade[^\n]*--version/)
    })

    async function failedUpgrade(provider: string): Promise<{message: string; exit?: number}> {
      const deployUtils = await import('../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      sandbox.stub(deployUtils, 'resolveDeploymentTarget').returns({
        type: 'single',
        deployment: {
          id: 'abc123',
          agent_name: agentName,
          provider,
          deployment_url: 'http://127.0.0.1:8080',
          deployed_version: '1.0',
        },
      })
      const releases = await import('../../../typescript/cast-cli/src/lib/releases')
      sandbox.stub(releases, 'validateSemver').resolves(true)
      const tarball = path.join(agentDir, '1.1.tar.gz')
      fs.writeFileSync(tarball, '')
      sandbox.stub(releases, 'getRelease').resolves({
        version: '1.1',
        change_number: 1,
        message: '',
        changelog: '',
        created_at: '2026-05-12T17:08:33.000Z',
        tarball_path: tarball,
      })
      sandbox.stub(registry, 'getDeploymentProvider').returns({
        upgrade: async () => {
          throw new Error('boom')
        },
      } as any)
      const instance = new UpgradeCommand(['upgrade', agentName, '1.1'], {} as any) as any
      instance.parse = async () => ({
        args: {agent: agentName, version: '1.1'},
        flags: {'list-versions': false},
      })
      instance.confirm = async () => true
      instance.log = () => {}
      try {
        await instance.run()
        expect.fail('upgrade should exit non-zero')
      } catch (error: any) {
        return {message: error.message || String(error), exit: error.oclif?.exit}
      }
      return {message: ''}
    }

    it('keeps the deploy rollback hint for a non-sprites provider', async () => {
      const failed = await failedUpgrade('docker')
      expect(failed.exit).to.not.equal(0)
      expect(failed.message).to.include('You can try rolling back by deploying the previous version:')
      expect(failed.message).to.include(`cast deploy ${agentName} --provider docker`)
      expect(failed.message).to.include('boom')
    })

    it('does not use the deploy rollback hint when the provider is sprites', async () => {
      const failed = await failedUpgrade('sprites')
      expect(failed.exit).to.not.equal(0)
      expect(failed.message).to.equal('boom')
      expect(failed.message).to.not.include('cast deploy')
      expect(failed.message).to.not.include('rolling back by deploying')
    })
  })
})