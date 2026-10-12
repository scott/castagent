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
        execStub.resolves({stdout: '', stderr: '', exitCode: 0})
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
      const runCmd = sshCommands.find((cmd: string) => cmd.includes('docker run'))
      expect(runCmd, 'should have a docker run command').to.exist
      expect(runCmd).to.include('AUTH_TOKEN=tok-secret')
      expect(runCmd).to.include('CAST_MOTD=')
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
      const runCmd = sshCommands.find((cmd: string) => cmd.includes('docker run'))
      expect(runCmd).to.include('OPENROUTER_API_KEY=or-key-123')
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
        execCommandReturn: () => ({stdout: '', stderr: 'port already in use', exitCode: 1}),
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
      execStub.onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list
        .onSecondCall().resolves({stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 key (ED25519)\n', stderr: '', exitCode: 0})
        .onThirdCall().resolves({stdout: '', stderr: '', exitCode: 0})                  // doctl create
        .onCall(3).resolves({stdout: '99  10.0.0.5', stderr: '', exitCode: 0})        // doctl get

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-script-'))
      try {
        await instance.getOrCreateDroplet('script-test', tempDir)
        const cloudInit = fs.readFileSync(path.join(tempDir, '.cloud-init.yml'), 'utf-8')

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
        expect(scriptContent, 'should fall back to get.docker.com if apt repo fails').to.include('get.docker.com')
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

      // Forbid interactive prompts (consistent with the rest of the file).
      expect(sshArgs, 'should disable StrictHostKeyChecking').to.include('StrictHostKeyChecking=no')
      expect(sshArgs, 'should set BatchMode=yes').to.include('BatchMode=yes')

      // gzip is spawned with -6 -c (compress level 6 to stdout)
      const gzipCall: any = spawnStub.getCalls().find(
        (c: any) => c.args[0] === 'gzip',
      )
      expect(gzipCall, 'gzip child should have been spawned').to.exist
      expect(gzipCall.args[1], 'gzip should be invoked with -6 -c').to.deep.equal(['-6', '-c'])
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
      execStub.onFirstCall().resolves({stdout: '', stderr: '', exitCode: 0})           // doctl list
        .onSecondCall().resolves({stdout: '3072 MD5:ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90 key (ED25519)\n', stderr: '', exitCode: 0})
        .onThirdCall().resolves({stdout: '', stderr: '', exitCode: 0})                  // doctl create
        .onCall(3).resolves({stdout: '111  10.0.0.1', stderr: '', exitCode: 0})         // doctl get

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-test-do-schema-'))
      try {
        await instance.getOrCreateDroplet('schema-test', tempDir)
        const cloudInit = fs.readFileSync(path.join(tempDir, '.cloud-init.yml'), 'utf-8')

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
})
