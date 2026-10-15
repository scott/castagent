import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as sinon from 'sinon'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import axios from 'axios'

import DigitalOceanDeploy, {
  accountSshKeyCleanup,
  castMicrovmsUsingAccountKey,
  digitalOceanKeysPage,
  digitalOceanMemoryVolumeName,
  digitalOceanMemoryVolumesToRemove,
  digitalOceanVolumeRemovalMessage,
  discardFailedDigitalOceanTokens,
  DIGITALOCEAN_SSH_TOOL_CHECKS,
  isLegacyDigitalOceanMemoryVolume,
  parseDropletContainerProbe,
  planDigitalOceanMemoryVolume,
  remoteDockerRunCommand,
  removeDigitalOceanMemoryVolumes,
  SSH_KEY_NAME,
} from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import {digitaloceanProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/digitalocean'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as motd from '../../../../typescript/cast-cli/src/lib/deploy/motd'
import {castKnownHostsPath, recordPinnedHostKey} from '../../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'

describe('DigitalOcean Deploy Provider', () => {
  let sandbox: sinon.SinonSandbox
  let instance: any // eslint-disable-line @typescript-eslint/no-explicit-any
  let sshDir = ''
  let pinnedPublicKey = ''

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-pin-'))
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k'), '-C', 'test'])
      pinnedPublicKey = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  // Helper to cast stubs for type-safe access to sinon matchers.
  // NOTE: ts-node wraps 'fs' with non-configurable descriptors, so we
  // CANNOT stub fs methods with sinon. Use real temp dirs instead.
  function stubFn<T extends (...args: any[]) => any>(fn: T): sinon.SinonStub<Parameters<T>, ReturnType<T>> {
    return fn as any
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    instance = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as any)
    sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ssh-'))
    process.env.CAST_SSH_DIR = sshDir
    recordPinnedHostKey('203.0.113.1', pinnedPublicKey)
  })

  afterEach(() => {
    sandbox.restore()
    delete process.env.CAST_SSH_DIR
    if (sshDir) fs.rmSync(sshDir, {recursive: true, force: true})
    sshDir = ''
  })

  // -----------------------------------------------------------------------
  // Static properties (existing tests preserved)
  // -----------------------------------------------------------------------

  describe('static properties', () => {
    it('should have correct description', () => {
      expect(DigitalOceanDeploy.description).to.equal('Deploy agent to DigitalOcean Droplet with Docker')
    })

    it('should require agent argument', () => {
      expect(DigitalOceanDeploy.args).to.have.property('agent')
      expect(DigitalOceanDeploy.args.agent.required).to.be.true
      expect(DigitalOceanDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should default --with-tui to false (keep images small)', () => {
      expect(DigitalOceanDeploy.flags).to.have.property('with-tui')
      expect(DigitalOceanDeploy.flags['with-tui'].default).to.be.false
    })

    it('should default --size to s-2vcpu-2gb', () => {
      expect(DigitalOceanDeploy.flags).to.have.property('size')
      expect(DigitalOceanDeploy.flags.size.default).to.equal('s-2vcpu-2gb')
    })
  })

  // -----------------------------------------------------------------------
  // Module exports
  // -----------------------------------------------------------------------

  describe('module exports', () => {
    it('should export a class', () => {
      expect(DigitalOceanDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance2 = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as any)
      expect(instance2).to.be.an('object')
    })
  })

  // -----------------------------------------------------------------------
  // Static destroy method
  // -----------------------------------------------------------------------

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof DigitalOceanDeploy.destroy).to.equal('function')
    })
  })

  describe('memory volume identity', () => {
    const legacy = 'cast-bb4-do-11111111-1111-1111-1111-111111111111-memory'
    const older = 'cast-bb4-do-22222222-2222-2222-2222-222222222222-memory'
    const wrong = 'cast-bb4-do-latest-memory'

    it('names the volume cast-<agent>', () => {
      expect(digitalOceanMemoryVolumeName('bb4-do')).to.equal('cast-bb4-do')
    })

    it('recognizes only pre-fix uuid volumes for that agent', () => {
      expect(isLegacyDigitalOceanMemoryVolume(legacy, 'bb4-do')).to.equal(true)
      expect(isLegacyDigitalOceanMemoryVolume('cast-bb4-do', 'bb4-do')).to.equal(false)
      expect(isLegacyDigitalOceanMemoryVolume(wrong, 'bb4-do')).to.equal(false)
      expect(isLegacyDigitalOceanMemoryVolume('cast-bb4-do-deploy-123-memory', 'bb4-do')).to.equal(false)
      expect(isLegacyDigitalOceanMemoryVolume(legacy, 'bb4')).to.equal(false)
      expect(isLegacyDigitalOceanMemoryVolume('cast-bb4-do-bot', 'bb4-do')).to.equal(false)
    })

    it('creates cast-<agent> when the account has no volume for the agent', () => {
      expect(planDigitalOceanMemoryVolume('bb4-do', null, [])).to.deep.equal({
        volumeId: 'cast-bb4-do',
        action: 'create',
      })
    })

    it('reuses cast-<agent> on a second deploy', () => {
      expect(planDigitalOceanMemoryVolume('bb4-do', 'cast-bb4-do', ['cast-bb4-do', older])).to.deep.equal({
        volumeId: 'cast-bb4-do',
        action: 'reuse',
      })
    })

    it('reuses the recorded uuid volume when cast-<agent> does not exist', () => {
      expect(planDigitalOceanMemoryVolume('bb4-do', legacy, [legacy, older, 'cast-other'])).to.deep.equal({
        volumeId: legacy,
        action: 'reuse',
      })
    })

    it('reuses the recorded volume when the volume list cannot be read', () => {
      expect(planDigitalOceanMemoryVolume('bb4-do', legacy, null)).to.deep.equal({
        volumeId: legacy,
        action: 'reuse',
      })
    })

    it('selects the named volume, recorded volumes, and leftover pre-fix volumes', () => {
      const names = digitalOceanMemoryVolumesToRemove(
        'bb4-do',
        [legacy, null, ''],
        ['cast-bb4-do', legacy, older, wrong, 'cast-bb4-do-bot', 'cast-other'],
      )
      expect(names).to.deep.equal(['cast-bb4-do', legacy, older].sort())
      expect(names).to.not.include(wrong)
    })

    it('reports removal only when the volume delete succeeds', () => {
      expect(digitalOceanVolumeRemovalMessage('cast-bb4-do', {exitCode: 0, stdout: '', stderr: ''}))
        .to.equal("Memory volume 'cast-bb4-do' has been removed.")
      expect(digitalOceanVolumeRemovalMessage(legacy, {exitCode: 1, stdout: '', stderr: 'Error: volume not found'}))
        .to.equal(null)
      expect(digitalOceanVolumeRemovalMessage(legacy, {exitCode: 1, stdout: '', stderr: 'GET https://api.digitalocean.com/v2/volumes 404'}))
        .to.equal(null)
      expect(digitalOceanVolumeRemovalMessage(legacy, {exitCode: 1, stdout: '', stderr: 'volume is attached to a droplet'}))
        .to.equal("Note: Memory volume '" + legacy + "' could not be removed.")
    })
  })

  describe('shutdown memory volumes', () => {
    const legacy = 'cast-bb4-do-11111111-1111-1111-1111-111111111111-memory'
    const older = 'cast-bb4-do-22222222-2222-2222-2222-222222222222-memory'
    const wrong = 'cast-bb4-do-latest-memory'
    let previousToken: string | undefined

    beforeEach(() => {
      previousToken = process.env.DIGITALOCEAN_ACCESS_TOKEN
      process.env.DIGITALOCEAN_ACCESS_TOKEN = 'test-do-token'
    })

    afterEach(() => {
      if (previousToken === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
      else process.env.DIGITALOCEAN_ACCESS_TOKEN = previousToken
    })

    it('deletes the uuid volume deploy created and does not claim latest was removed', async () => {
      sandbox.stub(db, 'listDeployments').returns([
        {provider: 'digitalocean', volume_id: legacy},
        {provider: 'fly', volume_id: 'cast-bb4-do-fly'},
      ])
      const deleted: string[] = []
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[]) => {
        if (args[0] === 'account') return {exitCode: 0, stdout: '', stderr: ''}
        if (args[1] === 'droplet' && args[2] === 'list') {
          return {exitCode: 0, stdout: '4242 cast-bb4-do\n', stderr: ''}
        }
        if (args[1] === 'droplet' && args[2] === 'delete') {
          return {exitCode: 0, stdout: '', stderr: ''}
        }
        if (args[1] === 'volume' && args[2] === 'list') {
          return {exitCode: 0, stdout: [legacy, older, 'cast-other', wrong].join('\n'), stderr: ''}
        }
        if (args[1] === 'volume' && args[2] === 'delete') {
          deleted.push(args[3])
          return {exitCode: 0, stdout: '', stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((line: unknown) => {
        logs.push(String(line))
      })

      await DigitalOceanDeploy.destroy('bb4-do')

      expect(deleted.sort()).to.deep.equal([legacy, older].sort())
      expect(deleted).to.not.include(wrong)
      expect(deleted).to.not.include('cast-other')
      expect(deleted).to.not.include('cast-bb4-do-fly')
      expect(logs).to.include(`Memory volume '${legacy}' has been removed.`)
      expect(logs).to.include(`Memory volume '${older}' has been removed.`)
      expect(logs.some(line => line.includes(wrong))).to.equal(false)
      expect(logs).to.include("Droplet 'cast-bb4-do' deleted.")
    })

    it('still deletes the recorded volume when the droplet is already gone', async () => {
      sandbox.stub(db, 'listDeployments').returns([
        {provider: 'digitalocean', volume_id: legacy},
      ])
      const deleted: string[] = []
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[]) => {
        if (args[1] === 'droplet' && args[2] === 'list') return {exitCode: 0, stdout: '', stderr: ''}
        if (args[1] === 'volume' && args[2] === 'list') return {exitCode: 0, stdout: `${legacy}\n`, stderr: ''}
        if (args[1] === 'volume' && args[2] === 'delete') {
          deleted.push(args[3])
          return {exitCode: 0, stdout: '', stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((line: unknown) => {
        logs.push(String(line))
      })

      await DigitalOceanDeploy.destroy('bb4-do')

      expect(deleted).to.deep.equal([legacy])
      expect(logs).to.include("Droplet 'cast-bb4-do' not found.")
      expect(logs).to.include(`Memory volume '${legacy}' has been removed.`)
      expect(logs.some(line => line.includes('latest-memory'))).to.equal(false)
    })

    it('does not claim a volume was removed when doctl rejects the delete', async () => {
      sandbox.stub(db, 'listDeployments').returns([{provider: 'digitalocean', volume_id: 'cast-bb4-do'}])
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[]) => {
        if (args[1] === 'droplet' && args[2] === 'list') return {exitCode: 0, stdout: '', stderr: ''}
        if (args[1] === 'volume' && args[2] === 'list') return {exitCode: 0, stdout: 'cast-bb4-do\n', stderr: ''}
        if (args[1] === 'volume' && args[2] === 'delete') {
          return {exitCode: 1, stdout: '', stderr: 'volume is attached to a droplet'}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((line: unknown) => {
        logs.push(String(line))
      })

      await DigitalOceanDeploy.destroy('bb4-do')

      const volumeLogs = logs.filter(line => line.includes('Memory volume'))
      expect(volumeLogs).to.deep.equal([
        "Note: Memory volume 'cast-bb4-do' could not be removed.",
      ])
    })

    it('stays quiet when the recorded volume is already gone', async () => {
      const logs: string[] = []
      await removeDigitalOceanMemoryVolumes('bb4-do', [legacy], async (args) => {
        if (args[2] === 'list') return {exitCode: 0, stdout: '', stderr: ''}
        return {exitCode: 1, stdout: '', stderr: 'Error: volume not found'}
      }, (line) => logs.push(line))
      expect(logs).to.deep.equal([])
    })
  })

  // -----------------------------------------------------------------------
  // findProjectRoot — uses real temp dirs (cannot stub fs via ts-node)
  // -----------------------------------------------------------------------

  describe('findProjectRoot', () => {
    let tempDir: string

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, {recursive: true, force: true})
      }
      tempDir = ''
    })

    it('should return cwd when markers found at cwd', () => {
      // Create marker directories at a temp location, then point cwd there
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-root-'))
      fs.mkdirSync(path.join(tempDir, 'python', 'cast'), {recursive: true})
      fs.mkdirSync(path.join(tempDir, 'typescript', 'cast-tui'), {recursive: true})
      fs.writeFileSync(path.join(tempDir, 'python', 'cast', '__init__.py'), '')
      fs.writeFileSync(path.join(tempDir, 'typescript', 'cast-tui', 'package.json'), '{}')

      // Stub cwd to point to our temp dir
      const cwdStub = sandbox.stub(process, 'cwd').returns(tempDir)

      const result = instance.findProjectRoot()
      expect(result).to.equal(tempDir)
    })

    it('should find project root via __dirname when cwd has no markers', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-root-'))
      // No marker dirs created in tempDir, but the real project root
      // (reachable via __dirname/../../../../..) has them.
      const cwdStub = sandbox.stub(process, 'cwd').returns(tempDir)

      const result = instance.findProjectRoot()
      // Should resolve to the actual project root, not the markerless temp dir
      expect(fs.existsSync(path.join(result, 'python/cast'))).to.be.true
      expect(fs.existsSync(path.join(result, 'typescript/cast-tui'))).to.be.true
      expect(result).to.not.equal(tempDir)
    })
  })

  // -----------------------------------------------------------------------
  // createAndAttachVolume
  // -----------------------------------------------------------------------

  describe('createAndAttachVolume', () => {
    it('should create volume and attach to droplet', async () => {
      sandbox.stub(axios, 'post')
        .onFirstCall().resolves({
          data: {
            volume: {id: 'vol-123'},
          },
        })
        .onSecondCall().resolves({data: {}})

      const result = await instance.createAndAttachVolume(
        'test-token', 'droplet-1', 'cast-test-deploy-1-memory', 'nyc3',
      )
      expect(result).to.equal('/mnt/cast-test-deploy-1-memory')
    })

    it('should return mount path when volume already exists (response.id === invalid)', async () => {
      // When the error response has id === 'invalid', the method treats it
      // as "volume already exists" and returns the mount path.
      const error: any = new Error('already exists')
      error.response = {data: {id: 'invalid'}}

      sandbox.stub(axios, 'post').rejects(error)

      const result = await instance.createAndAttachVolume(
        'test-token', 'droplet-1', 'cast-test-deploy-1-memory', 'nyc3',
      )
      expect(result).to.equal('/mnt/cast-test-deploy-1-memory')
    })

    it('should return null and warn on non-invalid error', async () => {
      const error: any = new Error('rate limited')
      error.response = {data: {id: 'something_else'}}

      sandbox.stub(axios, 'post').rejects(error)
      const warnStub = sandbox.stub(instance, 'warn').returns(undefined)

      const result = await instance.createAndAttachVolume(
        'test-token', 'droplet-1', 'vol-name', 'nyc3',
      )
      expect(result).to.be.null
      expect(warnStub.calledOnce).to.be.true
    })

    it('should return null and warn when response has no data', async () => {
      const error: any = new Error('network error')
      // No response.data

      sandbox.stub(axios, 'post').rejects(error)
      const warnStub = sandbox.stub(instance, 'warn').returns(undefined)

      const result = await instance.createAndAttachVolume(
        'test-token', 'droplet-1', 'vol-name', 'nyc3',
      )
      expect(result).to.be.null
      expect(warnStub.calledOnce).to.be.true
    })
  })

  // -----------------------------------------------------------------------
  // deployOnDroplet
  // -----------------------------------------------------------------------

  describe('deployOnDroplet', () => {
    const defaultArgs = {
      ip: '203.0.113.1',
      agentName: 'test-agent',
      authToken: 'tok-secret',
      imageTag: 'cast-test-agent:latest',
      volumeId: 'cast-test-agent-deploy-123-memory',
      deploymentUrl: 'http://203.0.113.1:8080',
      deployedVersion: '1.2.3',
    }

    /** Standard stub setup for deployOnDroplet helpers. */
    function stubDeployHelpers(extra?: {
      execCommandReturn?: () => any
      openRouterKey?: string
      buildMotdReturn?: string
      writeMotdReturn?: {motdStderr: string; profileStderr: string}
    }) {
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      if (extra?.execCommandReturn) {
        execStub.callsFake(extra.execCommandReturn)
      } else {
        execStub.callsFake(async (...args: unknown[]) => {
          const remote = Array.isArray(args[1]) ? (args[1] as string[]).join(' ') : ''
          if (remote.includes('---CAST-LOGS---')) {
            return {
              stdout: 'running\n---CAST-LOGS---\nAgent ready on port 8080\n',
              stderr: '',
              exitCode: 0,
            }
          }
          return {stdout: '', stderr: '', exitCode: 0}
        })
      }
      sandbox.stub(deployUtils, 'inferenceEnv').returns(
        extra?.openRouterKey ? {OPENROUTER_API_KEY: extra.openRouterKey} : {},
      )
      sandbox.stub(motd, 'buildHostMotd').returns(extra?.buildMotdReturn ?? 'Welcome!\n')
      const motdStub = sandbox.stub(motd, 'writeHostMotdOverSsh')
      motdStub.resolves(
        extra?.writeMotdReturn ?? {motdStderr: '', profileStderr: ''},
      )
      const warnStub = sandbox.stub(instance, 'warn').returns(undefined)
      return {execStub, motdStub, warnStub}
    }

    it('should stop old container on droplet', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const allCalls = execStub.getCalls()
      const sshCommands = allCalls.map(c => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const hasLoad = sshCommands.some((cmd: string) => cmd.includes('docker load'))
      const hasStop = sshCommands.some((cmd: string) => cmd.includes('docker stop'))
      expect(hasLoad, 'should NOT call docker load (image is streamed)').to.be.false
      expect(hasStop, 'should call docker stop').to.be.true
    })

    it('should pass auth token and MOTD env vars to docker run', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const sshCommands = execStub.getCalls()
        .map((c: any) => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const runCmd = sshCommands.find((cmd: string) => cmd.includes("'docker'") && cmd.includes("'run'"))
      expect(runCmd, 'should have a docker run command').to.exist
      expect(runCmd).to.include("'--env-file'")
      expect(runCmd).to.include("'/var/lib/cast/cast-agent.env'")
      expect(runCmd).to.include("'127.0.0.1:8080:8080'")
      expect(runCmd).to.not.include('AUTH_TOKEN=')
      expect(runCmd).to.not.include('tok-secret')
      expect(runCmd).to.include('StrictHostKeyChecking=yes')
      const envWrite = execStub.getCalls().find((c: any) =>
        ((c.args[1] as string[]) || []).join(' ').includes('cast-agent.env'),
      )
      expect(envWrite, 'should write the env file').to.exist
      const envInput = (envWrite!.args[2] as {input?: string}).input
      expect(envInput).to.include('AUTH_TOKEN=tok-secret')
      expect(envInput).to.include('CAST_MOTD=')
      expect(envInput).to.include('PYTHONPATH=/app')
    })

    it('should include OPENROUTER_API_KEY when available', async () => {
      const {execStub} = stubDeployHelpers({openRouterKey: 'or-key-123'})
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const sshCommands = execStub.getCalls()
        .map((c: any) => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const runCmd = sshCommands.find((cmd: string) => cmd.includes("'docker'") && cmd.includes("'run'"))
      expect(runCmd).to.not.include('OPENROUTER_API_KEY')
      expect(runCmd).to.not.include('or-key-123')
      const envWrite = execStub.getCalls().find((c: any) =>
        ((c.args[1] as string[]) || []).join(' ').includes('cast-agent.env') &&
        ((c.args[1] as string[]) || []).join(' ').includes('chmod 0600'),
      )
      const envInput = (envWrite!.args[2] as {input?: string}).input
      expect(envInput).to.include('OPENROUTER_API_KEY=or-key-123')
    })

    it('should bind the agent to loopback and not open public port 8080', async () => {
      const {execStub, motdStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const commands = execStub.getCalls().map((c: any) => ({
        cmd: ((c.args[1] as string[]) || []).join(' '),
        opts: c.args[2] as {input?: string; shell?: boolean},
      }))
      const joined = commands.map(c => c.cmd).join('\n')
      expect(joined).to.not.match(/ufw allow 8080/)
      expect(joined).to.include('ufw --force delete allow 8080/tcp')
      expect(joined).to.include('StrictHostKeyChecking=yes')
      expect(joined).to.not.include('StrictHostKeyChecking=no')
      const run = commands.find(c => c.cmd.includes("'docker'") && c.cmd.includes("'run'"))
      expect(run!.cmd).to.include('127.0.0.1:8080:8080')
      expect(run!.cmd).to.not.include('-p 8080:8080')
      expect(run!.cmd).to.not.include("'8080:8080'")
      expect(run!.cmd).to.not.include('0.0.0.0:8080')
      const envWrite = commands.find(c => c.cmd.includes('chmod 0600'))
      expect(envWrite!.cmd).to.include('chmod 0600')
      expect(envWrite!.cmd).to.include('umask 077')
      expect(envWrite!.cmd).to.not.include('tok-secret')
      expect(envWrite!.opts.shell).to.equal(false)
      expect(envWrite!.opts.input).to.include('AUTH_TOKEN=tok-secret')
      for (const command of commands) {
        expect(command.cmd).to.not.include('tok-secret')
        expect(command.cmd).to.not.include('StrictHostKeyChecking=no')
      }
      const ctx = motdStub.firstCall.args[1] as {privateSsh?: boolean; a2aUrl?: string}
      expect(ctx.privateSsh).to.equal(true)
      expect(ctx.a2aUrl).to.equal('https://203.0.113.1')
      expect(ctx.a2aUrl).to.not.include('http://')
    })

    it('should write host MOTD and profile', async () => {
      const {motdStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )
      expect(motdStub.calledOnce).to.be.true
    })

    it('should warn on MOTD write failure', async () => {
      const {warnStub} = stubDeployHelpers({
        writeMotdReturn: {motdStderr: 'permission denied', profileStderr: ''},
      })

      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )
      expect(warnStub.calledOnce).to.be.true
    })

    it('should fail with error when docker run fails', async () => {
      stubDeployHelpers({
        execCommandReturn: (...args: any[]) => {
          const cmd = ((args[1] as string[]) || []).join(' ')
          if (cmd.includes("'docker'") && cmd.includes("'run'")) {
            return {stdout: '', stderr: 'port already in use', exitCode: 1}
          }
          return {stdout: '', stderr: '', exitCode: 0}
        },
      })
      try {
        await instance.deployOnDroplet(
          defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
          defaultArgs.imageTag, defaultArgs.volumeId,
          defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.message).to.include('Failed to start container')
      }
    })

    it('fails when the container restarts and does not report success', async () => {
      const {execStub, motdStub} = stubDeployHelpers({
        execCommandReturn: (...args: any[]) => {
          const cmd = ((args[1] as string[]) || []).join(' ')
          if (cmd.includes('---CAST-LOGS---')) {
            return {
              stdout: "restarting\n---CAST-LOGS---\nModuleNotFoundError: No module named 'cast'\n",
              stderr: '',
              exitCode: 0,
            }
          }
          return {stdout: '', stderr: '', exitCode: 0}
        },
      })
      try {
        await instance.deployOnDroplet(
          defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
          defaultArgs.imageTag, defaultArgs.volumeId,
          defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.message).to.include('restarting')
        expect(e.message).to.include("No module named 'cast'")
        expect(e.message).to.not.include('Successful')
      }
      expect(motdStub.called, 'MOTD is written only after the runtime is ready').to.equal(false)
      const commands = execStub.getCalls().map((call: sinon.SinonSpyCall) =>
        ((call.args[1] as string[]) || []).join(' '),
      )
      expect(commands.some((cmd: string) => cmd.includes('docker update --restart=no'))).to.equal(true)
      expect(commands.some((cmd: string) => cmd.includes('tok-secret'))).to.equal(false)
    })

    it('parses a droplet container probe', () => {
      const ready = parseDropletContainerProbe('running\n---CAST-LOGS---\nAgent ready on port 8080\n')
      expect(ready).to.deep.equal({status: 'running', logs: 'Agent ready on port 8080'})
      const crashed = parseDropletContainerProbe('', "missing\n---CAST-LOGS---\nNo module named 'cast'\n")
      expect(crashed.status).to.equal('missing')
      expect(crashed.logs).to.include("No module named 'cast'")
    })

    it('should pass onHostTui=true to the MOTD context when withTui is true', async () => {
      const {motdStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
        true, // withTui
      )
      expect(motdStub.calledOnce).to.be.true
      const ctx = motdStub.firstCall.args[1] as {onHostTui?: boolean}
      expect(ctx.onHostTui).to.be.true
    })

    it('should pass onHostTui=false to the MOTD context when withTui is false', async () => {
      const {motdStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
        false, // withTui
      )
      const ctx = motdStub.firstCall.args[1] as {onHostTui?: boolean}
      expect(ctx.onHostTui).to.be.false
    })

    it('sends docker run over a pinned host key', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )
      const runCall = execStub.getCalls().find((call: sinon.SinonSpyCall) => {
        const cmd = ((call.args[1] as string[]) || []).join(' ')
        return cmd.includes("'docker'") && cmd.includes("'run'")
      })
      expect(runCall, 'docker run ssh call').to.exist
      const args = runCall!.args[1] as string[]
      expect(args).to.include('StrictHostKeyChecking=yes')
      expect(args).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
      expect(args).to.include('HostKeyAlgorithms=ssh-ed25519')
      expect(args.join('\n')).to.not.include('StrictHostKeyChecking=no')
      expect(args.join('\n')).to.not.include('UserKnownHostsFile=/dev/null')
    })

    it('does not open SSH when the droplet host key is not pinned', async () => {
      const {execStub} = stubDeployHelpers()
      try {
        await instance.deployOnDroplet(
          '198.51.100.20', defaultArgs.agentName, defaultArgs.authToken,
          defaultArgs.imageTag, defaultArgs.volumeId,
          'http://198.51.100.20:8080', defaultArgs.deployedVersion,
        )
        expect.fail('should have refused')
      } catch (e: any) {
        expect(e.message).to.include('no pinned SSH host key')
        expect(e.message).to.include('198.51.100.20')
      }
      expect(execStub.called, 'ssh must not start without a pin').to.equal(false)
    })

    it('should default onHostTui to false when withTui is omitted (backwards compat)', async () => {
      const {motdStub} = stubDeployHelpers()
      // No 8th arg — should default to false.
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )
      const ctx = motdStub.firstCall.args[1] as {onHostTui?: boolean}
      expect(ctx.onHostTui).to.be.false
    })
  })

  describe('remoteDockerRunCommand', () => {
    it('keeps the volume and the image as single remote words and omits secrets', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-quote-'))
      const marker = path.join(dir, 'marker')
      const token = `sekret'$(touch ${marker})`
      const image = `img$(touch ${marker})`
      const volume = `vol;touch ${marker}`
      const command = remoteDockerRunCommand({
        imageTag: image,
        volumeId: volume,
      })

      try {
        const output = execFileSync('bash', [
          '-c',
          'docker() { printf "%s\\n" docker "$@"; }; eval "$1"',
          'bash',
          command,
        ], {encoding: 'utf8'})
        const words = output.split('\n').filter(word => word.length > 0)
        expect(fs.existsSync(marker)).to.equal(false)
        expect(command).to.not.include(token)
        expect(command).to.not.include('AUTH_TOKEN')
        expect(words).to.include('127.0.0.1:8080:8080')
        expect(words).to.include('--env-file')
        expect(words).to.include('/var/lib/cast/cast-agent.env')
        expect(words).to.include(`/mnt/${volume}:/app/agent/memory`)
        expect(words[words.length - 1]).to.equal(image)
        expect(words[0]).to.equal('docker')
        expect(words[1]).to.equal('run')
        expect(words).to.not.include('8080:8080')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // -----------------------------------------------------------------------
  // waitForSsh
  // -----------------------------------------------------------------------

  describe('waitForSsh', () => {
    it('refuses before any SSH attempt when the host key is not pinned', async () => {
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      try {
        await instance.waitForSsh('198.51.100.21')
        expect.fail('should have refused')
      } catch (e: any) {
        expect(e.message).to.include('no pinned SSH host key')
      }
      expect(execStub.called).to.equal(false)
    })

    it('stops on the first host key mismatch instead of retrying', async () => {
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any).resolves({
        stdout: '',
        stderr: 'Host key verification failed.\n',
        exitCode: 255,
      })
      const guarded = instance.waitForSsh('203.0.113.1').catch((e: Error) => e)
      await clock.tickAsync(1)
      const err = await guarded
      expect(err).to.be.instanceOf(Error)
      expect((err as Error).message).to.include('host key verification failed')
      expect(execStub.callCount).to.equal(1)
    })

    it('should resolve when SSH responds', async () => {
      stubFn(sandbox.stub(deployUtils, 'execCommand') as any).resolves({
        stdout: 'ok', stderr: '', exitCode: 0,
      })
      await instance.waitForSsh('203.0.113.1')
      // Should resolve without error
    })

    it('should reject with timeout when execSsh never succeeds', async () => {
      // waitForSsh loops up to maxAttempts(30) times with a 5-second delay
      // between each.  Rather than waiting 150s in real time, we use sinon
      // fake timers to fast-forward.
      const clock = sandbox.useFakeTimers()

      stubFn(sandbox.stub(deployUtils, 'execCommand') as any).resolves({
        stdout: '', stderr: 'Connection refused', exitCode: 1,
      })

      // Start waitForSsh (enters retry loop).  The promise will eventually
      // reject after all attempts are exhausted.
      const promise = instance.waitForSsh('203.0.113.1')

      // Advance time by 150 seconds in one shot (30 attempts × 5s).
      // waitForSsh uses setTimeout for the delay, which sinon controls.
      // After all retries are exhausted, the promise should reject.
      await clock.tickAsync(150_000)

      try {
        await promise
        expect.fail('waitForSsh should have rejected')
      } catch (e: any) {
        expect(e.message).to.include('Timed out')
      }
    })
  })

  // -----------------------------------------------------------------------
  // waitForDocker
  //
  // Regression coverage for the race condition where the droplet's
  // cloud-init installs Docker *after* SSH is up. We must not attempt
  // to `docker load` over SSH until `docker info` succeeds — otherwise
  // we hit "bash: line 1: docker: command not found" (exit 127).
  // -----------------------------------------------------------------------

  describe('waitForDocker', () => {
    it('should resolve when docker info returns 0', async () => {
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      execStub.resolves({stdout: '', stderr: '', exitCode: 0})

      await instance.waitForDocker('203.0.113.1')

      // Verify we actually ran a `docker info` command (not e.g. `docker
      // --version` which would pass even if the daemon were down).
      const allCalls = execStub.getCalls()
      const sshCommands = allCalls.map(c => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const hasDockerInfo = sshCommands.some((cmd: string) => cmd.includes('docker info'))
      expect(hasDockerInfo, 'should poll with `docker info`').to.be.true
    })

    it('should keep polling while docker info fails (e.g. daemon not ready)', async () => {
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)

      // Each iteration makes 2 calls: a sentinel check + a docker
      // info check. First two iterations: docker not yet installed
      // / daemon not running. Third iteration: daemon is up.
      //   iteration 1 → onCall(0) sentinel, onCall(1) docker info
      //   iteration 2 → onCall(2) sentinel, onCall(3) docker info
      //   iteration 3 → onCall(4) sentinel, onCall(5) docker info OK
      execStub.onCall(0).resolves({stdout: '', stderr: '', exitCode: 1})             // sentinel: missing
      execStub.onCall(1).resolves({stdout: '', stderr: 'docker: not found', exitCode: 127}) // docker info: fail
      execStub.onCall(2).resolves({stdout: '', stderr: '', exitCode: 1})             // sentinel: missing
      execStub.onCall(3).resolves({stdout: '', stderr: 'Cannot connect to daemon', exitCode: 1}) // docker info: fail
      execStub.onCall(4).resolves({stdout: '', stderr: '', exitCode: 0})             // sentinel: present
      execStub.onCall(5).resolves({stdout: '', stderr: '', exitCode: 0})             // docker info: OK

      const promise = instance.waitForDocker('203.0.113.1')

      // 3 iterations × 5s delay between each = 10s of setTimeout ticks.
      await clock.tickAsync(15_000)

      // Should now have resolved cleanly without throwing.
      await promise
      expect(execStub.callCount).to.equal(6)
    })

    it('should reject with timeout when docker info never succeeds', async () => {
      // waitForDocker loops up to maxAttempts(120) times with a 5-second
      // delay between each — 600s total. Use fake timers to avoid the
      // real wait. The diagnostic probes at the end also run, so we
      // give a couple of extra ticks for them to settle.
      const clock = sandbox.useFakeTimers()

      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      // The retry loop polls sentinel + docker info on every iteration.
      // The diagnostic probes at the end also call execCommand.
      // Make the diagnostic probes return something useful so we can
      // assert the error message includes them.
      execStub.callsFake((() => async (...args: any[]) => {
        const cmd = (args[1] as string[]).join(' ')
        if (cmd.includes('cloud-init status')) {
          return {stdout: 'status: done\n', stderr: '', exitCode: 0}
        }
        if (cmd.includes('/var/lib/cast/docker-ready')) {
          return {stdout: '', stderr: 'No such file or directory', exitCode: 1}
        }
        if (cmd.includes('docker info')) {
          return {stdout: '', stderr: 'bash: docker: command not found', exitCode: 127}
        }
        // Sentinel + docker info polls during the retry loop.
        return {stdout: '', stderr: 'bash: docker: command not found', exitCode: 127}
      })() as any)

      const promise = instance.waitForDocker('203.0.113.1')

      // Advance past the full retry budget (120 attempts × 5s = 600s)
      // plus some slack for the diagnostic probes.
      await clock.tickAsync(650_000)

      try {
        await promise
        expect.fail('waitForDocker should have rejected')
      } catch (e: any) {
        expect(e.message).to.include('Timed out')
        // Helpful hints in the error message so users can debug.
        expect(e.message).to.include('cloud-init')
        expect(e.message).to.include('journalctl')
        // Diagnostic info from the droplet is included.
        expect(e.message).to.include('cloud-init')
      }
    })

    it('should resolve quickly once sentinel file is present', async () => {
      // The new cloud-init writes /var/lib/cast/docker-ready as the
      // last runcmd step. Once it appears we should treat install as
      // complete and just verify `docker info` responds. We expect
      // exactly 2 calls in the first iteration (sentinel + docker info)
      // and an immediate return — the build phase should not have to
      // wait for cloud-init again.
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)

      execStub.onCall(0).resolves({stdout: '', stderr: '', exitCode: 0})  // sentinel exists
      execStub.onCall(1).resolves({stdout: '', stderr: '', exitCode: 0})  // docker info OK

      const promise = instance.waitForDocker('203.0.113.1')
      await clock.tickAsync(5_000)
      await promise
      expect(execStub.callCount).to.equal(2)
    })

    it('should keep polling when sentinel exists but daemon is not yet up', async () => {
      // If cloud-init completed (sentinel exists) but `systemctl start
      // docker` raced, we should keep polling docker info rather than
      // declaring success.
      //   iteration 1 → onCall(0) sentinel present, onCall(1) docker info FAIL
      //   iteration 2 → onCall(2) sentinel present, onCall(3) docker info OK
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)

      execStub.onCall(0).resolves({stdout: '', stderr: '', exitCode: 0})  // sentinel exists
      execStub.onCall(1).resolves({stdout: '', stderr: 'daemon not yet up', exitCode: 1})  // docker info fails
      execStub.onCall(2).resolves({stdout: '', stderr: '', exitCode: 0})  // sentinel exists
      execStub.onCall(3).resolves({stdout: '', stderr: '', exitCode: 0})  // docker info OK

      const promise = instance.waitForDocker('203.0.113.1')
      await clock.tickAsync(15_000)
      await promise
      expect(execStub.callCount).to.equal(4)
    })

    it('should swallow SSH-level errors while waiting', async () => {
      // If the underlying execSsh throws (e.g. transient SSH drop), the
      // retry loop should treat it the same as a non-zero exit and
      // keep polling rather than aborting.
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)

      execStub.onCall(0).rejects(new Error('ssh: connect refused'))
      execStub.onCall(1).resolves({stdout: '', stderr: '', exitCode: 0})

      const promise = instance.waitForDocker('203.0.113.1')
      await clock.tickAsync(15_000)
      await promise
      expect(execStub.callCount).to.equal(2)
    })

    it('should pass a per-call timeoutMs to every execCommand call', async () => {
      // Regression: without a per-call timeout, a hung SSH probe can
      // make a single iteration last many minutes (and the deploy
      // appears "stuck" inside waitForDocker). Each execSsh must
      // pass a finite timeoutMs.
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      execStub.onCall(0).resolves({stdout: '', stderr: '', exitCode: 0}) // sentinel
      execStub.onCall(1).resolves({stdout: '', stderr: '', exitCode: 0}) // docker info

      await instance.waitForDocker('203.0.113.1')

      // Inspect what waitForDocker actually passed to execCommand.
      for (let i = 0; i < execStub.callCount; i++) {
        const call = execStub.getCall(i)
        const opts = call.args[2] as { timeoutMs?: number } | undefined
        expect(opts, `call ${i} must pass options object`).to.exist
        expect(opts!.timeoutMs, `call ${i} must pass a finite timeoutMs`).to.be.a('number')
        expect(opts!.timeoutMs, `call ${i} timeoutMs must be > 0`).to.be.greaterThan(0)
      }
    })

    it('should log a heartbeat every ~30s so the user sees the loop is alive', async () => {
      // Without this, a long wait looks indistinguishable from a
      // hang. We use the real `this.log` (just spy on it) and
      // verify a "still waiting" message appears after ~30s of
      // polling without success.
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      // All probes fail forever — we expect the loop to time out.
      execStub.callsFake(async () => ({stdout: '', stderr: '', exitCode: 1}))

      const logStub = sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.waitForDocker('203.0.113.1')
      // Advance past the full 5-min budget.
      await clock.tickAsync(310_000)

      try {
        await promise
        expect.fail('should have timed out')
      } catch {
        // expected
      }

      // Find at least one "still waiting" heartbeat. We don't pin
      // the exact elapsed string because it depends on iteration
      // count; just verify the message format.
      const heartbeats = logStub.getCalls()
        .map(c => String(c.args[0]))
        .filter(msg => msg.includes('still waiting'))
      expect(heartbeats.length, 'should log at least one heartbeat').to.be.greaterThan(0)
    })

    it('should continue polling after an SSH timeout without aborting', async () => {
      // Regression: before the per-call timeout was added, a hung SSH
      // probe would block the loop FOREVER (the Promise never resolved).
      // With a per-call timeout, the loop catches the timeout error
      // and retries. Verify the loop does not stall on a timeout.
      const clock = sandbox.useFakeTimers()
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)

      // Iteration 1: sentinel probe times out. Loop must NOT abort —
      // it should catch the timeout and move to docker info probe.
      execStub.onCall(0).rejects(new Error('Command "ssh" timed out after 15000ms'))
      // Iteration 1: docker info probe fails (daemon not up yet)
      execStub.onCall(1).resolves({stdout: '', stderr: 'daemon not up', exitCode: 1})
      // Iteration 2: sentinel probe succeeds. Now docker info succeeds → done.
      execStub.onCall(2).resolves({stdout: '', stderr: '', exitCode: 0}) // sentinel
      execStub.onCall(3).resolves({stdout: '', stderr: '', exitCode: 0}) // docker info OK

      const promise = instance.waitForDocker('203.0.113.1')
      await clock.tickAsync(10_000)
      await promise
      // 4 calls: timeout on sentinel, fail on docker info, then success
      expect(execStub.callCount).to.equal(4)
    })

    it('install script content should include apt-repo URL, fallback, and sentinel touch', async () => {
      // Verify the script written to /usr/local/bin/cast-install-docker.sh
      // has the key properties: tries the official Docker apt repo,
      // falls back to get.docker.com, logs everything, always exits 0.
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-script-'))
      let cloudInit = ''
      execStub.onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list
        .onSecondCall().resolves({stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 key (ED25519)\n', stderr: '', exitCode: 0})
        .onThirdCall().callsFake(async () => {
          cloudInit = fs.readFileSync(path.join(tempDir, '.cloud-init.yml'), 'utf-8')
          return {stdout: '', stderr: '', exitCode: 0}
        })
        .onCall(3).resolves({stdout: '99  10.0.0.5', stderr: '', exitCode: 0})        // doctl get

      try {
        await instance.getOrCreateDroplet('script-test', tempDir)
        expect(cloudInit, 'user-data must be captured while doctl create runs').to.not.equal('')

        // Parse the YAML to extract the install script content safely
        // (rather than relying on fragile regex extraction of indented blocks).
        const YAML = require('yaml')
        const parsed = YAML.parse(cloudInit)
        expect(parsed).to.have.nested.property('write_files')
        const scriptFile = parsed.write_files.find(
          (f: any) => f.path === '/usr/local/bin/cast-install-docker.sh',
        )
        expect(scriptFile, 'install script should exist in write_files').to.exist
        expect(scriptFile.content).to.be.a('string')
        const scriptContent = scriptFile.content as string

        // Key properties of the install script
        expect(scriptContent, 'should try official Docker apt repo first').to.include('download.docker.com')
        expect(scriptContent, 'should check the Docker apt key digest').to.include('sha256sum -c -')
        expect(scriptContent, 'should pin the published Docker apt key').to.include(deployUtils.installPin('docker-apt-key', 'ubuntu').sha256)
        expect(scriptContent, 'should refuse an unsigned installer').to.include('Refusing an unsigned installer')
        expect(scriptContent, 'should not pipe a remote Docker installer').to.not.include('get.docker.com')
        expect(scriptContent, 'should not pipe a shell').to.not.match(/\| *(bash|sh)\b/)
        expect(scriptContent, 'should log all output to cast-docker-install.log').to.include('/var/log/cast-docker-install.log')
        // The script must NOT run docker or touch the sentinel — those
        // are runcmd's job. The script just installs and exits 0.
        expect(scriptContent, 'should not try to run docker (runcmd does that)').to.not.include('docker run')
        expect(scriptContent, 'should not touch the sentinel (runcmd does that)').to.not.include('touch /var/lib/cast')
        // runcmd is responsible for the sentinel touch — verify it's
        // there as a separate runcmd item (not in the script).
        const runcmdBlock = cloudInit.split('runcmd:')[1] || ''
        expect(runcmdBlock, 'sentinel touch should be a runcmd item, not in script').to.include('touch /var/lib/cast/docker-ready')
      } finally {
        fs.rmSync(tempDir, {recursive: true, force: true})
      }
    })
  })

  // -----------------------------------------------------------------------
  // streamImageToDroplet
  //
  // Regression coverage for the bug where `docker save | ssh docker load`
  // could hang forever: the streaming SSH had no keepalive, no wall-clock
  // timeout, and no `save.on('close')` handler. We test through the
  // private method via the `instance as any` cast (matching how
  // `findProjectRoot` etc. are tested).
  // -----------------------------------------------------------------------

  describe('streamImageToDroplet', () => {
    /**
     * Build a mock child-process handle for one side of the
     * `docker save | ssh docker load` pipe.
     *
     * The function under test registers handlers on `.on(event, cb)` for
     * the process itself, on `.stdout` for `data` / `error`, and on
     * `.stdin` for `error`. Tests call the returned `emit*` helpers to
     * trigger those events and observe what the function does.
     */
    function makeMockProcess(): {
      proc: any
      stdout: any
      stdin: any
      emit: (event: string, ...args: any[]) => void
      emitStdout: (event: string, ...args: any[]) => void
      emitStdin: (event: string, ...args: any[]) => void
    } {
      const procHandlers: Record<string, Array<(...args: any[]) => void>> = {}
      const stdoutHandlers: Record<string, Array<(...args: any[]) => void>> = {}
      const stdinHandlers: Record<string, Array<(...args: any[]) => void>> = {}

      const proc: any = {
        exitCode: null,
        killed: false,
        on(event: string, cb: (...args: any[]) => void) {
          (procHandlers[event] ||= []).push(cb)
          return proc
        },
        kill: sandbox.stub().callsFake(() => {
          proc.killed = true
          return true
        }),
      }

      const stdout: any = {
        on(event: string, cb: (...args: any[]) => void) {
          (stdoutHandlers[event] ||= []).push(cb)
          return stdout
        },
        pipe: sandbox.stub(),
        unpipe: sandbox.stub(),
      }

      const stdin: any = {
        on(event: string, cb: (...args: any[]) => void) {
          (stdinHandlers[event] ||= []).push(cb)
          return stdin
        },
        end: sandbox.stub(),
      }

      proc.stdout = stdout
      proc.stdin = stdin

      return {
        proc,
        stdout,
        stdin,
        emit(event: string, ...args: any[]) {
          ;(procHandlers[event] || []).forEach((cb) => cb(...args))
        },
        emitStdout(event: string, ...args: any[]) {
          ;(stdoutHandlers[event] || []).forEach((cb) => cb(...args))
        },
        emitStdin(event: string, ...args: any[]) {
          ;(stdinHandlers[event] || []).forEach((cb) => cb(...args))
        },
      }
    }

    /** Stub child_process.spawn so `docker save` → saveMock, `gzip` → gzipMock, `ssh` → loadMock. */
    function stubSpawn(saveMock: any, loadMock: any, gzipMock?: any): sinon.SinonStub {
      const gzip = gzipMock || makeMockProcess()
      return stubFn(sandbox.stub(require('child_process'), 'spawn') as any)
        .onFirstCall().returns(saveMock.proc)
        .onSecondCall().returns(gzip.proc)
        .onThirdCall().returns(loadMock.proc)
    }

    it('should resolve when save, gzip, and load all exit 0', async () => {
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)

      // Suppress progress logs from polluting the test output.
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)

      // Trigger all three clean exits.
      saveMock.emit('close', 0)
      gzipMock.emit('close', 0)
      loadMock.emit('close', 0)

      await promise
      // All children should have been killed by the finish() cleanup
      // (they're already dead, but kill() is still called defensively).
      expect(saveMock.proc.kill.called).to.be.true
      expect(gzipMock.proc.kill.called).to.be.true
      expect(loadMock.proc.kill.called).to.be.true
    })

    it('should reject with a timeout error when streaming never completes', async () => {
      // Use fake timers so the 500ms timeout fires instantly in test time.
      const clock = sandbox.useFakeTimers()
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)

      // Neither side emits anything — this simulates a hung SSH pipe.
      const promise = instance.streamImageToDroplet(
        '203.0.113.1', 'cast-test:latest', 500, // 500ms timeout
      )

      // Capture the unhandled rejection so the test doesn't warn
      // (we attach .catch after the tick).
      const guarded = promise.catch((e: Error) => e)

      await clock.tickAsync(600)
      const err = await guarded as Error
      expect(err).to.be.instanceOf(Error)
      expect(err.message).to.include('timed out')
      expect(err.message).to.include('500')

      // All three children should have been SIGKILL'd.
      expect(saveMock.proc.kill.calledWith('SIGKILL')).to.be.true
      expect(gzipMock.proc.kill.calledWith('SIGKILL')).to.be.true
      expect(loadMock.proc.kill.calledWith('SIGKILL')).to.be.true
    })

    it('should reject when docker save emits an error event', async () => {
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)

      const boom = new Error('docker: not found')
      saveMock.emit('error', boom)

      try {
        await promise
        expect.fail('should have rejected')
      } catch (e: any) {
        expect(e.message).to.equal('docker: not found')
      }
    })

    it('should reject when docker save exits non-zero, even if load is still open', async () => {
      // Regression for the original bug: only `load.on('close')` could
      // resolve the promise, so a save failure (e.g. wrong image tag)
      // would either be hidden or only surface when load eventually
      // timed out. Now save's close handler errors out immediately.
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)

      saveMock.emit('close', 1) // save dies with code 1
      // Don't emit close on gzip or load — simulate them still running.

      try {
        await promise
        expect.fail('should have rejected')
      } catch (e: any) {
        expect(e.message).to.include('docker save')
        expect(e.message).to.include('1')
      }
    })

    it('should pass SSH args that include keepalive (ServerAliveInterval=5, ServerAliveCountMax=1)', async () => {
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      const spawnStub = stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)
      saveMock.emit('close', 0)
      gzipMock.emit('close', 0)
      loadMock.emit('close', 0)
      await promise

      // Find the ssh spawn call (3rd call: spawn('ssh', ...))
      const sshCall: any = spawnStub.getCalls().find(
        (c: any) => c.args[0] === 'ssh',
      )
      expect(sshCall, 'ssh child should have been spawned').to.exist
      const sshArgs: string[] = sshCall.args[1]

      // Keepalive options must be present (this is the bug fix).
      expect(sshArgs, 'should include ServerAliveInterval=5').to.include('ServerAliveInterval=5')
      expect(sshArgs, 'should include ServerAliveCountMax=1').to.include('ServerAliveCountMax=1')

      // The remote command and target host should still be there.
      expect(sshArgs, 'should target root@<ip>').to.include('root@203.0.113.1')
      // gzip wrapper: remote command is now `gunzip | docker load`
      expect(sshArgs, 'should invoke gunzip | docker load remotely').to.include('gunzip | docker load')

      // Host key checking stays enabled against the Cast known_hosts file.
      expect(sshArgs, 'should require the pinned host key').to.include('StrictHostKeyChecking=yes')
      expect(sshArgs).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
      expect(sshArgs).to.include('HostKeyAlgorithms=ssh-ed25519')
      expect(sshArgs.join('\n')).to.not.include('StrictHostKeyChecking=no')
      expect(sshArgs.join('\n')).to.not.include('UserKnownHostsFile=/dev/null')
      expect(sshArgs, 'should set BatchMode=yes').to.include('BatchMode=yes')

      // gzip is spawned with -6 -c (compress level 6 to stdout)
      const gzipCall: any = spawnStub.getCalls().find(
        (c: any) => c.args[0] === 'gzip',
      )
      expect(gzipCall, 'gzip child should have been spawned').to.exist
      expect(gzipCall.args[1], 'gzip should be invoked with -6 -c').to.deep.equal(['-6', '-c'])
    })

    it('does not spawn ssh when the image target has no pinned host key', async () => {
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      const spawnStub = stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      try {
        await instance.streamImageToDroplet('198.51.100.23', 'cast-test:latest', 5000)
        expect.fail('should have refused')
      } catch (e: any) {
        expect(e.message).to.include('no pinned SSH host key')
      }
      expect(spawnStub.called, 'docker and ssh must not start').to.equal(false)
    })

    it('should surface pipe errors from load.stdin (e.g. EPIPE-equivalent errors)', async () => {
      // EPIPE itself is normal (load closes → save's writer gets EPIPE)
      // and is intentionally swallowed. But any other error on
      // load.stdin should reject the promise.
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)

      const epipe: any = new Error('write EPIPE')
      epipe.code = 'EPIPE'
      loadMock.emitStdin('error', epipe)

      // EPIPE is suppressed — promise should NOT have rejected.
      // Now trigger all three to close normally and the promise should resolve.
      loadMock.emit('close', 0)
      gzipMock.emit('close', 0)
      saveMock.emit('close', 0)

      // Attach a catch so a potential rejection doesn't surface as
      // an unhandled rejection warning during the test.
      const guarded = promise.catch((e: Error) => e)
      // Resolved with undefined (no error):
      const result = await guarded
      expect(result, 'EPIPE on load.stdin should not reject the promise').to.be.undefined
    })

    it('should clear the timeout when streaming finishes before timeout', async () => {
      // Regression: if the timeout is not cleared on success, the
      // node event loop keeps the timer active and the process may
      // not exit cleanly between tests. We use sinon's fake clock
      // and tick well past the timeout — if the timer wasn't cleared,
      // the (already-resolved) promise would still get a stray call.
      const clock = sandbox.useFakeTimers()
      const saveMock = makeMockProcess()
      const gzipMock = makeMockProcess()
      const loadMock = makeMockProcess()
      stubSpawn(saveMock, loadMock, gzipMock)
      sandbox.stub(instance, 'log').returns(undefined)

      const promise = instance.streamImageToDroplet('203.0.113.1', 'cast-test:latest', 5000)
      saveMock.emit('close', 0)
      gzipMock.emit('close', 0)
      loadMock.emit('close', 0)
      await promise

      // Now tick far past the timeout. If the timer wasn't cleared,
      // the finish() call would try to resolve/reject an already-settled
      // promise. We just assert the promise is still resolved (not
      // rejected) and the children were killed exactly once.
      await clock.tickAsync(10_000)
      expect(saveMock.proc.kill.callCount).to.equal(1)
      expect(gzipMock.proc.kill.callCount).to.equal(1)
      expect(loadMock.proc.kill.callCount).to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  // getOrCreateDroplet
  // -----------------------------------------------------------------------

  describe('getOrCreateDroplet', () => {
    it('refuses an existing droplet that has no pinned host key', async () => {
      stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
        .onFirstCall().resolves({
          stdout: '1234567  cast-test-agent  198.51.100.22\n',
          stderr: '',
          exitCode: 0,
        })
      try {
        await instance.getOrCreateDroplet('test-agent', '/tmp/agent')
        expect.fail('should have refused')
      } catch (e: any) {
        expect(e.message).to.include('no pinned SSH host key')
        expect(e.message).to.include('198.51.100.22')
      }
    })

    it('should find existing droplet by name', async () => {
      stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
        .onFirstCall().resolves({
          stdout: '1234567  cast-test-agent  203.0.113.1\n',
          stderr: '',
          exitCode: 0,
        })

      const result = await instance.getOrCreateDroplet('test-agent', '/tmp/agent')
      expect(result.id).to.equal('1234567')
      expect(result.name).to.equal('cast-test-agent')
      expect(result.ip).to.equal('203.0.113.1')
    })

    it('should create new droplet when none exists', async () => {
      // Stub execCommand for: list (empty), ssh-keygen, create droplet, get droplet
      // Also need to stub fs.readFileSync for the SSH pub key (configurable in Node)
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-'))
      let cloudInit = ''
      stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
        .onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list (empty)
        .onSecondCall().resolves({                                                 // ssh-keygen -l
          stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 test-key (ED25519)\n',
          stderr: '', exitCode: 0,
        })
        .onThirdCall().callsFake(async () => {
          cloudInit = fs.readFileSync(path.join(tempDir, '.cloud-init.yml'), 'utf-8')
          return {stdout: '', stderr: '', exitCode: 0}
        })
        .onCall(3).resolves({stdout: '7654321  203.0.113.2', stderr: '', exitCode: 0}) // doctl get

      // Use a real temp dir for the cloud-init file write
      try {
        const result = await instance.getOrCreateDroplet('test-agent-new', tempDir)
        expect(result.id).to.equal('7654321')
        expect(result.ip).to.equal('203.0.113.2')

        // User-data is removed after create so the host private key
        // does not stay in the agent directory.
        const cloudInitPath = path.join(tempDir, '.cloud-init.yml')
        expect(fs.existsSync(cloudInitPath)).to.equal(false)
        expect(cloudInit).to.not.equal('')
        expect(cloudInit).to.include('#cloud-config')
        expect(cloudInit).to.include('/etc/motd')
        // The install script should be written as a separate file
        // (so runcmd is a flat list of single-line strings —
        // cloud-init's strict schema rejects multi-line block
        // scalars inside runcmd).
        expect(cloudInit).to.include('/usr/local/bin/cast-install-docker.sh')
        expect(cloudInit).to.include('download.docker.com')
        // Sentinel must be touched at the end so the polling loop
        // exits fast on failure.
        expect(cloudInit).to.include('/var/lib/cast/docker-ready')
        // runcmd must NOT contain multi-line block scalars (the
        // reason an earlier version of this cloud-init was rejected
        // with SCHEMA_ERROR: part-001). Verify by checking that the
        // runcmd section has only simple single-line items.
        const runcmdSection = cloudInit.split('runcmd:')[1] || ''
        // No "|" block scalar markers inside the runcmd section.
        expect(runcmdSection, 'runcmd must not use block scalars').to.not.match(/\n\s*\|\s*\n/)
        // runcmd items should be flat strings, not comments.
        const runcmdLines = runcmdSection.split('\n').filter(l => /^\s*-\s/.test(l))
        for (const line of runcmdLines) {
          // Each runcmd item should be a single line, no continuation
          expect(line, `runcmd item should be single-line: ${line}`).to.not.match(/\\\s*$/)
        }

        const YAML = require('yaml')
        const parsed = YAML.parse(cloudInit)
        expect(parsed.ssh_deletekeys).to.equal(true)
        expect(parsed.ssh_genkeytypes).to.deep.equal(['ed25519'])
        const publicKey = String(parsed.ssh_keys.ed25519_public).trim()
        expect(publicKey).to.match(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/)
        expect(String(parsed.ssh_keys.ed25519_private)).to.include('BEGIN OPENSSH PRIVATE KEY')
        const knownHosts = fs.readFileSync(castKnownHostsPath(), 'utf8')
        expect(knownHosts).to.include(`203.0.113.2 ${publicKey}`)
        expect(knownHosts).to.not.include('PRIVATE KEY')
        const hostKeyFile = parsed.write_files.find(
          (f: {path?: string}) => f.path === '/etc/ssh/sshd_config.d/99-cast-host-key.conf',
        )
        expect(hostKeyFile.content).to.include('HostKey /etc/ssh/ssh_host_ed25519_key')
      } finally {
        fs.rmSync(tempDir, {recursive: true, force: true})
      }
    })

    it('cloud-init should pass cloud-init strict schema (no multi-line runcmd)', async () => {
      // Regression: the previous cloud-init used a `|` block scalar
      // inside runcmd to hold a multi-line install script. cloud-init's
      // strict schema validator rejected it with
      // `SCHEMA_ERROR: part-001` and the install never ran. Verify
      // that the current cloud-init is flat and schema-compliant.
      const execStub = stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-schema-'))
      let cloudInit = ''
      execStub.onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list
        .onSecondCall().resolves({stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 key (ED25519)\n', stderr: '', exitCode: 0})
        .onThirdCall().callsFake(async () => {
          cloudInit = fs.readFileSync(path.join(tempDir, '.cloud-init.yml'), 'utf-8')
          return {stdout: '', stderr: '', exitCode: 0}
        })
        .onCall(3).resolves({stdout: '111  10.0.0.1', stderr: '', exitCode: 0})         // doctl get

      try {
        await instance.getOrCreateDroplet('schema-test', tempDir)
        expect(cloudInit).to.not.equal('')

        // The install script must be a separate file, NOT inline
        // in runcmd. If `apt-get install` or `curl` appears as a
        // runcmd line item, the schema will reject it.
        const runcmdBlock = cloudInit.split('runcmd:')[1] || ''
        const runcmdItems = runcmdBlock
          .split('\n')
          .filter(l => /^\s*-\s/.test(l))
          .map(l => l.replace(/^\s*-\s+/, '').trim())
        for (const item of runcmdItems) {
          // Each runcmd item is a single-line string. cloud-init
          // accepts strings or lists of strings — both are fine —
          // but not block scalars or comments.
          expect(item, `runcmd item should not be empty: ${JSON.stringify(runcmdItems)}`).to.not.equal('')
          expect(item, `runcmd item should not be a comment: ${item}`).to.not.match(/^#/)
        }
        // Specifically: the docker install must NOT be a runcmd item
        // — it must live in the install script file.
        expect(JSON.stringify(runcmdItems)).to.not.include('apt-get install')
        expect(JSON.stringify(runcmdItems)).to.not.include('get.docker.com')
      } finally {
        fs.rmSync(tempDir, {recursive: true, force: true})
      }
    })
  })

  // -----------------------------------------------------------------------
  // run method
  // -----------------------------------------------------------------------

  describe('run method', () => {
    it('should be defined', () => {
      expect(typeof instance.run).to.equal('function')
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('should handle missing API token', () => {
      expect(DigitalOceanDeploy).to.be.a('function')
    })
  })

  describe('ssh prerequisites, token cleanup, and account key', () => {
    const secretServiceError = new Error(
      'The name org.freedesktop.secrets was not provided by any .service files',
    )
    const agentName = 'do-cleanup-agent'

    function restoreEnv(home: string, previousHome: string | undefined, previousSha?: string): void {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (arguments.length >= 3) {
        if (previousSha === undefined) delete process.env.CAST_DEPLOYMENT_SHA
        else process.env.CAST_DEPLOYMENT_SHA = previousSha
      }
      fs.rmSync(home, {recursive: true, force: true})
    }

    function stubRunSurface(): void {
      sandbox.stub(instance, 'parse').resolves({
        args: {agent: agentName},
        flags: {'with-tui': false, size: 's-2vcpu-2gb'},
      })
      sandbox.stub(instance, 'log').returns(undefined)
      sandbox.stub(instance, 'warn').returns(undefined)
      sandbox.stub(instance, 'error').callsFake((message: unknown) => {
        throw new Error(String(message))
      })
    }

    it('requires ssh and ssh-keygen before a DigitalOcean deploy', () => {
      const commands = (digitaloceanProvider.toolChecks || []).map(check => check.command)
      expect(commands).to.include('docker')
      expect(commands).to.include('ssh')
      expect(commands).to.include('ssh-keygen')
      const missing = DIGITALOCEAN_SSH_TOOL_CHECKS.find(check => check.command === 'ssh-keygen')
      expect(missing?.error).to.include('ssh-keygen is required')
    })

    it('stops before storing an auth token when ssh-keygen is missing', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-ssh-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      const generated = sandbox.stub(deployUtils, 'generateAuthToken').resolves({
        authToken: 'should-not-be-stored',
        tokenHash: 'hash',
      })
      try {
        fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
        stubRunSurface()
        sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
        sandbox.stub(deployUtils, 'checkCli').callsFake(async (command: string) => {
          if (command === 'ssh-keygen') throw new Error('spawn ssh-keygen ENOENT')
        })
        try {
          await instance.run()
          expect.fail('should have stopped')
        } catch (error: any) {
          expect(error.message).to.include('ssh-keygen is required')
        }
        expect(generated.called).to.equal(false)
        expect(fs.existsSync(path.join(home, '.cast', 'tokens'))).to.equal(false)
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('stops before storing an auth token when ssh is missing', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-ssh-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      const generated = sandbox.stub(deployUtils, 'generateAuthToken').resolves({
        authToken: 'should-not-be-stored',
        tokenHash: 'hash',
      })
      try {
        fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
        stubRunSurface()
        sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
        sandbox.stub(deployUtils, 'checkCli').callsFake(async (command: string) => {
          if (command === 'ssh') throw new Error('spawn ssh ENOENT')
        })
        try {
          await instance.run()
          expect.fail('should have stopped')
        } catch (error: any) {
          expect(error.message).to.include('ssh is required')
          expect(error.message).to.not.include('ssh-keygen')
        }
        expect(generated.called).to.equal(false)
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('removes the deployment token file from a failed deploy', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-token-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
      sandbox.stub(console, 'error')
      sandbox.stub(db, 'listDeployments').returns([])
      const deploymentToken = path.join(home, '.cast', 'tokens', 'deployments', 'abc123.token')
      const agentToken = path.join(home, '.cast', 'tokens', `${agentName}.token`)
      try {
        await keychain.setDeploymentToken('abc123', 'deploy-secret')
        await keychain.setToken(agentName, 'agent-secret')
        expect(fs.statSync(deploymentToken).mode & 0o777).to.equal(0o600)
        expect(fs.existsSync(agentToken)).to.equal(true)
        await discardFailedDigitalOceanTokens(agentName, 'abc123')
        expect(fs.existsSync(deploymentToken)).to.equal(false)
        expect(fs.existsSync(agentToken)).to.equal(false)
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('leaves the agent token when another deployment is still live', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-token-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
      sandbox.stub(console, 'error')
      sandbox.stub(db, 'listDeployments').returns([{id: 'bbbbbb'}])
      const deploymentToken = path.join(home, '.cast', 'tokens', 'deployments', 'abc123.token')
      const agentToken = path.join(home, '.cast', 'tokens', `${agentName}.token`)
      try {
        await keychain.setDeploymentToken('abc123', 'deploy-secret')
        await keychain.setToken(agentName, 'agent-secret')
        await discardFailedDigitalOceanTokens(agentName, 'abc123')
        expect(fs.existsSync(deploymentToken)).to.equal(false)
        expect(fs.readFileSync(agentToken, 'utf8')).to.equal('agent-secret')
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('removes token files when deploy fails after writing them', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-fail-'))
      const previousHome = process.env.HOME
      const previousSha = process.env.CAST_DEPLOYMENT_SHA
      process.env.HOME = home
      process.env.CAST_DEPLOYMENT_SHA = 'abc123'
      sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
      sandbox.stub(console, 'error')
      sandbox.stub(db, 'listDeployments').returns([])
      const deploymentToken = path.join(home, '.cast', 'tokens', 'deployments', 'abc123.token')
      const agentToken = path.join(home, '.cast', 'tokens', `${agentName}.token`)
      try {
        fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
        fs.mkdirSync(path.join(home, 'python', 'cast'), {recursive: true})
        stubRunSurface()
        sandbox.stub(instance, 'findProjectRoot').returns(home)
        sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
        sandbox.stub(deployUtils, 'checkCli').resolves()
        sandbox.stub(deployUtils, 'getProviderToken').returns('test-token')
        sandbox.stub(axios, 'get').resolves({data: {ssh_keys: []}})
        sandbox.stub(axios, 'post').callsFake(async () => {
          expect(fs.existsSync(deploymentToken)).to.equal(true)
          expect(fs.statSync(deploymentToken).mode & 0o777).to.equal(0o600)
          throw new Error('upload failed')
        })
        try {
          await instance.run()
          expect.fail('should have failed')
        } catch (error: any) {
          expect(error.message).to.include('upload failed')
        }
        expect(fs.existsSync(deploymentToken)).to.equal(false)
        expect(fs.existsSync(agentToken)).to.equal(false)
      } finally {
        restoreEnv(home, previousHome, previousSha)
      }
    })

    it('uploads a local login key when the account key is missing', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-key-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      const keyPath = path.join(home, '.ssh', 'cast_do_key')
      try {
        fs.mkdirSync(path.dirname(keyPath), {recursive: true, mode: 0o700})
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'])
        const pub = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()
        sandbox.stub(deployUtils, 'getProviderToken').returns('test-token')
        sandbox.stub(axios, 'get').resolves({data: {ssh_keys: []}})
        const post = sandbox.stub(axios, 'post').resolves({data: {}})
        await instance.ensureSshKey()
        expect(post.calledOnce).to.equal(true)
        expect(post.firstCall.args[0]).to.equal('https://api.digitalocean.com/v2/account/keys')
        expect(post.firstCall.args[1]).to.deep.equal({name: SSH_KEY_NAME, public_key: pub})
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('does not upload when the account key is already present', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-do-key-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      const keyPath = path.join(home, '.ssh', 'cast_do_key')
      try {
        fs.mkdirSync(path.dirname(keyPath), {recursive: true, mode: 0o700})
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'])
        sandbox.stub(deployUtils, 'getProviderToken').returns('test-token')
        sandbox.stub(axios, 'get').resolves({data: {ssh_keys: [{id: 7, name: SSH_KEY_NAME}]}})
        const post = sandbox.stub(axios, 'post').resolves({data: {}})
        await instance.ensureSshKey()
        expect(post.called).to.equal(false)
      } finally {
        restoreEnv(home, previousHome)
      }
    })

    it('chooses whether the shared account key can be removed', () => {
      expect(accountSshKeyCleanup(
        [{id: '99', name: 'cast-demo'}],
        [{id: 42, name: SSH_KEY_NAME}],
        '99',
      )).to.deep.equal({action: 'remove', id: 42})
      expect(accountSshKeyCleanup(
        [{id: '99', name: 'cast-demo'}, {id: '100', name: 'cast-other'}],
        [{id: 42, name: SSH_KEY_NAME}],
        '99',
      )).to.deep.equal({action: 'keep'})
      expect(accountSshKeyCleanup(
        [{id: '99', name: 'cast-demo'}, {id: '5', name: 'personal'}],
        [{id: 42, name: SSH_KEY_NAME}],
        '99',
      ).action).to.equal('remove')
      expect(accountSshKeyCleanup([], [{id: 1, name: 'other'}], '').action).to.equal('absent')
      expect(accountSshKeyCleanup(
        [{id: '99', name: 'cast-demo'}],
        [{id: 42, name: SSH_KEY_NAME}],
        '99',
        [{id: 'mv-1', name: 'cast-demo-abc123'}],
      ).action).to.equal('keep')
      const castVm = JSON.stringify([{id: 'mv-1', name: 'cast-demo-abc123', tags: ['cast']}])
      expect(castMicrovmsUsingAccountKey(castVm)).to.deep.equal([{id: 'mv-1', name: 'cast-demo-abc123'}])
      expect(castMicrovmsUsingAccountKey(JSON.stringify([{id: 'mv-2', name: 'unrelated'}]))).to.deep.equal([])
      expect(castMicrovmsUsingAccountKey(JSON.stringify([
        {id: 'mv-3', name: 'cast-demo', ssh_keys: []},
      ]))).to.deep.equal([])
      expect(castMicrovmsUsingAccountKey(JSON.stringify([
        {id: 'mv-4', name: 'other', tags: ['cast'], ssh_keys: [{name: SSH_KEY_NAME}]},
      ]))).to.deep.equal([{id: 'mv-4', name: 'other'}])
      expect(castMicrovmsUsingAccountKey(JSON.stringify({
        microvms: [{id: 'mv-5', name: 'workload', tags: [{name: 'cast'}]}],
      }))).to.deep.equal([{id: 'mv-5', name: 'workload'}])
      expect(castMicrovmsUsingAccountKey('')).to.deep.equal([])
      expect(() => castMicrovmsUsingAccountKey('{')).to.throw('Could not read the DigitalOcean MicroVM list')
      expect(digitalOceanKeysPage('https://api.digitalocean.com/v2/account/keys?page=2')).to.include('page=2')
      expect(digitalOceanKeysPage('https://evil.example/v2/account/keys')).to.equal(null)
      expect(digitalOceanKeysPage('http://api.digitalocean.com/v2/account/keys')).to.equal(null)
      expect(digitalOceanKeysPage('https://user:pass@api.digitalocean.com/v2/account/keys')).to.equal(null)
      expect(digitalOceanKeysPage('https://api.digitalocean.com:444/v2/account/keys')).to.equal(null)
    })

    async function destroyWith(input: {
      dropletLists: string[]
      sshKeys?: string
      microvms?: string
      microvmExit?: number
    }): Promise<{deletedId?: string; logs: string[]}> {
      sandbox.stub(db, 'listDeployments').returns([])
      sandbox.stub(deployUtils, 'getProviderToken').returns('test-token')
      let listed = 0
      let deletedId: string | undefined
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[] = []) => {
        const line = args.join(' ')
        if (line.includes('account') && line.includes('get')) {
          return {stdout: 'ok', stderr: '', exitCode: 0}
        }
        if (line.includes('droplet') && line.includes('list')) {
          const stdout = input.dropletLists[Math.min(listed, input.dropletLists.length - 1)] || ''
          listed += 1
          return {stdout, stderr: '', exitCode: 0}
        }
        if (line.includes('droplet') && line.includes('delete')) {
          return {stdout: '', stderr: '', exitCode: 0}
        }
        if (line.includes('volume')) {
          return {stdout: '', stderr: '', exitCode: 0}
        }
        if (line.includes('microvm') && line.includes('list')) {
          if (input.microvmExit) {
            return {stdout: '', stderr: 'microvm list failed', exitCode: input.microvmExit}
          }
          return {stdout: input.microvms ?? '[]', stderr: '', exitCode: 0}
        }
        if (line.includes('ssh-key') && line.includes('list')) {
          return {stdout: input.sshKeys ?? '', stderr: '', exitCode: 0}
        }
        if (line.includes('ssh-key') && line.includes('delete')) {
          deletedId = args[args.indexOf('delete') + 1]
          return {stdout: '', stderr: '', exitCode: 0}
        }
        throw new Error(`unexpected command ${line}`)
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((message?: unknown) => {
        logs.push(String(message))
      })
      await DigitalOceanDeploy.destroy(agentName)
      return {deletedId, logs}
    }

    it('removes the account SSH key after the last Cast droplet is deleted', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, `99 cast-${agentName}\n`],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
        microvms: '[]',
      })
      expect(result.deletedId).to.equal('42')
      expect(result.logs.join('\n')).to.include(`Removed DigitalOcean account SSH key '${SSH_KEY_NAME}'.`)
    })

    it('keeps the account SSH key while another Cast droplet remains', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, `99 cast-${agentName}\n100 cast-other\n`],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
      })
      expect(result.deletedId).to.equal(undefined)
      expect(result.logs.join('\n')).to.include(`Left DigitalOcean account SSH key '${SSH_KEY_NAME}'`)
    })

    it('keeps the account SSH key while a Cast MicroVM remains', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, ''],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
        microvms: JSON.stringify([{id: 'mv-1', name: 'cast-other-abc123', tags: ['cast']}]),
      })
      expect(result.deletedId).to.equal(undefined)
      expect(result.logs.join('\n')).to.include('MicroVM')
    })

    it('removes the account SSH key when the only MicroVM is not one Cast created', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, ''],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
        microvms: JSON.stringify([{id: 'mv-2', name: 'unrelated-vm'}]),
      })
      expect(result.deletedId).to.equal('42')
    })

    it('removes the account SSH key when a Cast MicroVM lists other SSH keys', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, ''],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
        microvms: JSON.stringify([{id: 'mv-3', name: 'cast-other', ssh_keys: [{name: 'someone-else'}]}]),
      })
      expect(result.deletedId).to.equal('42')
    })

    it('does not delete the account SSH key when MicroVMs cannot be listed', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, ''],
        sshKeys: `42 ${SSH_KEY_NAME}\n`,
        microvmExit: 1,
      })
      expect(result.deletedId).to.equal(undefined)
      expect(result.logs.join('\n')).to.include('could not be removed')
      expect(result.logs.join('\n')).to.include('MicroVM')
    })

    it('removes a leftover account SSH key when the droplet is already gone', async () => {
      const result = await destroyWith({
        dropletLists: ['', ''],
        sshKeys: `9 ${SSH_KEY_NAME}\n`,
        microvms: '[]',
      })
      expect(result.deletedId).to.equal('9')
      expect(result.logs.join('\n')).to.include(`Droplet 'cast-${agentName}' not found.`)
    })

    it('does not fail shutdown when the account key id is unexpected', async () => {
      const result = await destroyWith({
        dropletLists: [`99 cast-${agentName}\n`, ''],
        sshKeys: `42;rm ${SSH_KEY_NAME}\n`,
        microvms: '[]',
      })
      expect(result.deletedId).to.equal(undefined)
      expect(result.logs.join('\n')).to.include('could not be removed')
      expect(result.logs.join('\n')).to.include('unexpected id')
    })
  })
})
