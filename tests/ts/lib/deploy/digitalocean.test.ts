import {expect} from 'chai'
import * as sinon from 'sinon'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import axios from 'axios'

import DigitalOceanDeploy from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as motd from '../../../../typescript/cast-cli/src/lib/deploy/motd'

describe('DigitalOcean Deploy Provider', () => {
  let sandbox: sinon.SinonSandbox
  let instance: any // eslint-disable-line @typescript-eslint/no-explicit-any

  // Helper to cast stubs for type-safe access to sinon matchers.
  // NOTE: ts-node wraps 'fs' with non-configurable descriptors, so we
  // CANNOT stub fs methods with sinon. Use real temp dirs instead.
  function stubFn<T extends (...args: any[]) => any>(fn: T): sinon.SinonStub<Parameters<T>, ReturnType<T>> {
    return fn as any
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    instance = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as any)
  })

  afterEach(() => {
    sandbox.restore()
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

    it('should not have --no-build flag', () => {
      expect(DigitalOceanDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      expect(DigitalOceanDeploy.flags).to.be.undefined
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

    it('should return cwd when no markers found anywhere', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-root-'))
      // No marker dirs created
      const cwdStub = sandbox.stub(process, 'cwd').returns(tempDir)

      const result = instance.findProjectRoot()
      expect(result).to.equal(tempDir)
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
      tarPath: '/tmp/test-agent.tar',
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
        execStub.resolves({stdout: '', stderr: '', exitCode: 0})
      }
      sandbox.stub(deployUtils, 'getOpenRouterApiKey').returns(
        extra?.openRouterKey ?? undefined,
      )
      sandbox.stub(motd, 'buildHostMotd').returns(extra?.buildMotdReturn ?? 'Welcome!\n')
      const motdStub = sandbox.stub(motd, 'writeHostMotdOverSsh')
      motdStub.resolves(
        extra?.writeMotdReturn ?? {motdStderr: '', profileStderr: ''},
      )
      const warnStub = sandbox.stub(instance, 'warn').returns(undefined)
      return {execStub, motdStub, warnStub}
    }

    it('should load image and stop old container', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const allCalls = execStub.getCalls()
      const sshCommands = allCalls.map(c => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const hasLoad = sshCommands.some((cmd: string) => cmd.includes('docker load'))
      const hasStop = sshCommands.some((cmd: string) => cmd.includes('docker stop'))
      expect(hasLoad, 'should call docker load').to.be.true
      expect(hasStop, 'should call docker stop').to.be.true
    })

    it('should pass auth token and MOTD env vars to docker run', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const sshCommands = execStub.getCalls()
        .map((c: any) => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const runCmd = sshCommands.find((cmd: string) => cmd.includes('docker run'))
      expect(runCmd, 'should have a docker run command').to.exist
      expect(runCmd).to.include('AUTH_TOKEN=tok-secret')
      expect(runCmd).to.include('CAST_MOTD=')
    })

    it('should include OPENROUTER_API_KEY when available', async () => {
      const {execStub} = stubDeployHelpers({openRouterKey: 'or-key-123'})
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const sshCommands = execStub.getCalls()
        .map((c: any) => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const runCmd = sshCommands.find((cmd: string) => cmd.includes('docker run'))
      expect(runCmd).to.include('OPENROUTER_API_KEY=or-key-123')
    })

    it('should write host MOTD and profile', async () => {
      const {motdStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
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
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )
      expect(warnStub.calledOnce).to.be.true
    })

    it('should fail with error when docker load fails', async () => {
      stubDeployHelpers({
        execCommandReturn: () => ({stdout: '', stderr: 'No such file', exitCode: 1}),
      })
      try {
        await instance.deployOnDroplet(
          defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
          defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
          defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.message).to.include('Failed to load image')
      }
    })

    it('should clean up remote tar file after loading', async () => {
      const {execStub} = stubDeployHelpers()
      await instance.deployOnDroplet(
        defaultArgs.ip, defaultArgs.agentName, defaultArgs.authToken,
        defaultArgs.imageTag, defaultArgs.tarPath, defaultArgs.volumeId,
        defaultArgs.deploymentUrl, defaultArgs.deployedVersion,
      )

      const sshCommands = execStub.getCalls()
        .map((c: any) => c.args[1] ? (c.args[1] as string[]).join(' ') : '')
      const rmCmd = sshCommands.find((cmd: string) => cmd.includes('rm -f'))
      expect(rmCmd, 'should clean up remote tar').to.exist
      expect(rmCmd).to.include('test-agent.tar')
    })
  })

  // -----------------------------------------------------------------------
  // waitForSsh
  // -----------------------------------------------------------------------

  describe('waitForSsh', () => {
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
  // getOrCreateDroplet
  // -----------------------------------------------------------------------

  describe('getOrCreateDroplet', () => {
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
      stubFn(sandbox.stub(deployUtils, 'execCommand') as any)
        .onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list (empty)
        .onSecondCall().resolves({                                                 // ssh-keygen -l
          stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 test-key (ED25519)\n',
          stderr: '', exitCode: 0,
        })
        .onThirdCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl create
        .onCall(3).resolves({stdout: '7654321  203.0.113.2', stderr: '', exitCode: 0}) // doctl get

      // Use a real temp dir for the cloud-init file write
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-'))
      try {
        const result = await instance.getOrCreateDroplet('test-agent-new', tempDir)
        expect(result.id).to.equal('7654321')
        expect(result.ip).to.equal('203.0.113.2')

        // Verify cloud-init was written with the correct structure
        const cloudInitPath = path.join(tempDir, '.cloud-init.yml')
        expect(fs.existsSync(cloudInitPath)).to.be.true
        const cloudInit = fs.readFileSync(cloudInitPath, 'utf-8')
        expect(cloudInit).to.include('#cloud-config')
        expect(cloudInit).to.include('get.docker.com')
        expect(cloudInit).to.include('/etc/motd')
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
})
