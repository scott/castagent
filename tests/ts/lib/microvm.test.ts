import {expect} from 'chai'
import axios from 'axios'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import MicrovmDeploy, {
  assertUpgradeable,
  buildCreateArgs,
  decodeMemoryExport,
  deploymentEnv,
  discardFailedMicrovmTokens,
  doctlVersionAtLeast,
  extractExecStdout,
  memoryChunks,
  MEMORY_EXPORT_LIMIT,
  microvmReady,
  mkc1Available,
  parseIdleTimeout,
  parseMicrovmPayload,
  parsePushedRegistryTag,
  dockerHostFromInspect,
  parseRegistryDockerConfig,
  parseRegistryName,
  parseSize,
  parseVolumeConfig,
  probeAuthResult,
  registryDeleteTagArgs,
  removeFailedMicrovmArtifacts,
  resolveFailedMicrovm,
  sanitizeMicrovmName,
  sanitizeRepoName,
  copyCastRuntime,
  settleFailedMicrovm,
  shutdownRegistryDeleteArgs,
} from '../../../typescript/cast-cli/src/lib/deploy/microvm'
import * as deployUtils from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {readDoctlAccessToken} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {keychain} from '../../../typescript/cast-cli/src/lib/keychain'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('DigitalOcean MicroVM helpers', () => {
  it('sanitizes names and caps them at 63 characters', () => {
    expect(sanitizeMicrovmName('Email_Agent', 'abc123')).to.equal('cast-email-agent-abc123')
    expect(sanitizeRepoName('Email_Agent')).to.equal('cast-email-agent')
    const longName = sanitizeMicrovmName('a'.repeat(80), 'sha')
    expect(longName.length).to.be.at.most(63)
    expect(longName.endsWith('-')).to.equal(false)
  })

  it('rejects an agent name that sanitizes to empty', () => {
    expect(() => sanitizeMicrovmName('---', '')).to.throw(/Cannot build a MicroVM name/)
  })

  it('replaces a stale packaged runtime with the current checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-runtime-src-'))
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-agent-'))
    try {
      const source = path.join(root, 'python', 'cast')
      fs.mkdirSync(source, {recursive: true})
      fs.writeFileSync(path.join(source, 'runtime.py'), 'STREAM_KEEPALIVE = 5\n')
      const stale = path.join(agent, '.cast-runtime', 'cast')
      fs.mkdirSync(stale, {recursive: true})
      fs.writeFileSync(path.join(stale, 'runtime.py'), 'old runtime\n')
      fs.writeFileSync(path.join(stale, 'leftover.py'), 'from the previous image\n')

      expect(copyCastRuntime(agent, root)).to.equal(true)
      expect(fs.readFileSync(path.join(stale, 'runtime.py'), 'utf8')).to.include('STREAM_KEEPALIVE')
      expect(fs.existsSync(path.join(stale, 'leftover.py'))).to.equal(false)
      expect(copyCastRuntime(agent, path.join(root, 'missing'))).to.equal(false)
      expect(fs.readFileSync(path.join(stale, 'runtime.py'), 'utf8')).to.include('STREAM_KEEPALIVE')
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('parses sizes and idle timeouts', () => {
    expect(parseSize(undefined)).to.deep.equal({cpu: 1, memory: 2048})
    expect(parseSize('2:4096')).to.deep.equal({cpu: 2, memory: 4096})
    expect(() => parseSize('2:2048')).to.throw(/Unknown MicroVM size/)
    expect(parseIdleTimeout(undefined)).to.equal('15m')
    expect(parseIdleTimeout('4h')).to.equal('4h')
    expect(() => parseIdleTimeout('5h')).to.throw(/Maximum is 4h/)
    expect(() => parseIdleTimeout('15')).to.throw(/Invalid idle timeout/)
  })

  it('builds create args with env and omits AUTH_TOKEN for edge-only', () => {
    const env = deploymentEnv({
      agentName: 'demo',
      authToken: 'secret',
      inference: {OPENROUTER_API_KEY: 'sk'},
      edgeAuthOnly: false,
    })
    expect(env.AUTH_TOKEN).to.equal('secret')
    const edgeEnv = deploymentEnv({agentName: 'demo', authToken: 'secret', edgeAuthOnly: true})
    expect(edgeEnv.AUTH_TOKEN).to.equal(undefined)
    const args = buildCreateArgs({
      name: 'cast-demo-abc',
      ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
      env: edgeEnv,
      agentName: 'demo',
    })
    expect(args).to.include('--region')
    expect(args).to.include('mkc1')
    expect(args).to.include('--http-port')
    expect(args).to.include('8080')
    expect(args.join(' ')).to.not.include('AUTH_TOKEN')
  })

  it('parses a wrapped MicroVM payload and decides readiness', () => {
    const raw = JSON.stringify({
      microvm: {
        id: 'vm-1',
        state: 'provisioning',
        region: {slug: 'mkc1'},
        urls: [{default: true, endpoint: 'vm-1.mkc1.microvm.ondigitalocean.com', status: 'PENDING'}],
      },
    })
    const pending = parseMicrovmPayload(raw)
    expect(pending.endpoint).to.equal('https://vm-1.mkc1.microvm.ondigitalocean.com')
    expect(pending.region).to.equal('mkc1')
    expect(microvmReady(pending)).to.equal('pending')
    expect(microvmReady({...pending, endpointStatus: 'ACTIVE', state: 'running'})).to.equal('ready')
    expect(microvmReady({id: 'vm-1', state: 'failed', failureReason: 'boom'})).to.equal('failed')
    const listed = parseMicrovmPayload(JSON.stringify([{
      id: '01a12c49-fa25-71f0-8d33-4140ee900ff7',
      region: 'mkc1',
      state: 'creating',
      urls: [{port: 8080, default: true, status: 'PENDING'}],
    }]))
    expect(listed.id).to.equal('01a12c49-fa25-71f0-8d33-4140ee900ff7')
    expect(listed.endpoint).to.equal('https://01a12c49-fa25-71f0-8d33-4140ee900ff7.mkc1.microvm.ondigitalocean.com')
    expect(listed.endpointStatus).to.equal('PENDING')
    expect(microvmReady(listed)).to.equal('pending')
    expect(microvmReady({...listed, endpointStatus: 'ACTIVE', state: 'running'})).to.equal('ready')
    expect(probeAuthResult(200)).to.equal('ok')
    expect(probeAuthResult(401)).to.equal('unauthorized')
    expect(probeAuthResult(503)).to.equal('retry')
  })

  it('reads registry names and region availability', () => {
    expect(parseRegistryName('{"registry":{"name":"cast"}}')).to.equal('cast')
    expect(parseRegistryName('[{"name":"scottmillerio","region":"sfo3"}]')).to.equal('scottmillerio')
    expect(parseRegistryName('{"name":"cast"}')).to.equal('cast')
    expect(parseRegistryDockerConfig('{"auths":{"registry.digitalocean.com":{"auth":"abc"}},"credsStore":"desktop"}'))
      .to.equal('{"auths":{"registry.digitalocean.com":{"auth":"abc"}}}')
    expect(() => parseRegistryDockerConfig('{"auths":{}}')).to.throw(/registry credentials/)
    expect(dockerHostFromInspect('unix:///Users/scott/.colima/default/docker.sock\n'))
      .to.equal('unix:///Users/scott/.colima/default/docker.sock')
    expect(dockerHostFromInspect('<no value>')).to.equal(undefined)
    expect(mkc1Available('{"regions":["mkc1"]}')).to.equal(true)
    expect(mkc1Available('{"regions":["nyc1"]}')).to.equal(false)
    expect(mkc1Available('not-json')).to.equal(null)
  })

  it('compares doctl versions', () => {
    expect(doctlVersionAtLeast('doctl version 1.180.0-release')).to.equal(true)
    expect(doctlVersionAtLeast('doctl version 1.172.9')).to.equal(false)
    expect(doctlVersionAtLeast('doctl version 1.173.0')).to.equal(true)
  })

  it('caps memory exports and chunks base64', () => {
    expect(extractExecStdout('{"stdout":"YQ=="}')).to.equal('YQ==')
    expect(decodeMemoryExport('YQ==').toString()).to.equal('a')
    const huge = Buffer.alloc(MEMORY_EXPORT_LIMIT + 1, 1).toString('base64')
    expect(() => decodeMemoryExport(huge)).to.throw(/8 MiB/)
    expect(memoryChunks('abcd', 2)).to.deep.equal(['ab', 'cd'])
    expect(() => assertUpgradeable('paused')).to.not.throw()
    expect(() => assertUpgradeable('failed')).to.throw(/running or paused/)
  })

  it('deletes a MicroVM whose workload container exited', async () => {
    const removed: string[] = []
    const error = await settleFailedMicrovm({
      id: 'vm-1',
      state: 'failed',
      failureReason: 'workload container exited (code 1)',
      endpoint: 'https://vm-1.mkc1.microvm.ondigitalocean.com',
      region: 'mkc1',
    }, 'workload container exited (code 1)', async (id) => {
      removed.push(id)
      return {exitCode: 0, stdout: '', stderr: ''}
    })
    expect(removed).to.deep.equal(['vm-1'])
    expect(error.microvmId).to.equal(undefined)
    expect(error.message).to.include('workload container exited (code 1)')
    expect(error.message).to.include('The MicroVM was deleted.')

    const settled = await resolveFailedMicrovm({
      error,
      remove: async () => {
        throw new Error('delete should not run after the VM is gone')
      },
    })
    expect(settled.id).to.equal(undefined)
    expect(settled.message).to.include('The MicroVM was deleted.')
  })

  it('keeps the id when delete fails so shutdown can find the MicroVM', async () => {
    const error = await settleFailedMicrovm({
      id: 'vm-9',
      state: 'failed',
      failureReason: 'workload container exited (code 1)',
      region: 'mkc1',
    }, 'workload container exited (code 1)', async () => ({exitCode: 1, stdout: '', stderr: 'denied'}))
    expect(error.microvmId).to.equal('vm-9')
    const settled = await resolveFailedMicrovm({
      error,
      remove: async () => ({exitCode: 1, stdout: '', stderr: 'denied'}),
    })
    expect(settled.id).to.equal('vm-9')
    expect(settled.region).to.equal('mkc1')
    expect(settled.message).to.include('still on the account')
    expect(settled.message).to.include('workload container exited (code 1)')
  })

  it('treats a missing MicroVM as cleaned up after a probe failure', async () => {
    const settled = await resolveFailedMicrovm({
      error: new Error('MicroVM endpoint probe failed (502): workload container exited (code 1)'),
      created: {id: 'vm-2', endpoint: 'https://vm-2.example', region: 'mkc1'},
      remove: async () => ({exitCode: 1, stdout: '', stderr: 'not found'}),
    })
    expect(settled.id).to.equal(undefined)
    expect(settled.message).to.include('The MicroVM was deleted.')
    expect(settled.message).to.include('workload container exited (code 1)')
  })

  it('parses volume config and doctl tokens', () => {
    const config = parseVolumeConfig(JSON.stringify({
      microvmId: 'vm-1',
      region: 'mkc1',
      ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
      authMode: 'dual',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
    }))
    expect(config.microvmId).to.equal('vm-1')
    expect(() => parseVolumeConfig('{}')).to.throw(/microvmId/)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctl-'))
    const configPath = path.join(dir, 'config.yaml')
    fs.writeFileSync(configPath, 'access-token: dop_test\n')
    expect(readDoctlAccessToken(configPath)).to.equal('dop_test')
    fs.writeFileSync(configPath, 'context: work\nauth-contexts:\n  work: dop_work\n')
    expect(readDoctlAccessToken(configPath)).to.equal('dop_work')
  })

  it('builds a forced delete-tag command for the pushed image', () => {
    const ociRef = 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:abc123'
    expect(parsePushedRegistryTag(ociRef)).to.deep.equal({
      registry: 'cast',
      repository: 'cast-mv-cleanup-agent',
      tag: 'abc123',
    })
    expect(parsePushedRegistryTag('registry.digitalocean.com/scott/cast-demo:abc123-k3')).to.deep.equal({
      registry: 'scott',
      repository: 'cast-demo',
      tag: 'abc123-k3',
    })
    expect(parsePushedRegistryTag('docker.io/library/cast:latest')).to.equal(undefined)
    expect(registryDeleteTagArgs(ociRef)).to.deep.equal([
      'registry', 'repository', 'delete-tag',
      'cast-mv-cleanup-agent',
      'abc123',
      '--registry', 'cast',
      '--force',
    ])
    expect(() => registryDeleteTagArgs('not-a-ref')).to.throw(/Unrecognized image reference/)
  })

  it('builds the shutdown delete-tag command from the stored image ref', () => {
    expect(shutdownRegistryDeleteArgs('registry.digitalocean.com/cast/cast-mv-shutdown-agent:abc123')).to.deep.equal([
      'registry', 'repository', 'delete-tag',
      'cast-mv-shutdown-agent',
      'abc123',
      '--registry', 'cast',
      '--force',
    ])
    expect(shutdownRegistryDeleteArgs('docker.io/library/cast:latest')).to.equal(undefined)
  })
})

describe('failed MicroVM deploy cleanup', () => {
  const agentName = 'mv-cleanup-agent'
  const secretServiceError = new Error(
    'The name org.freedesktop.secrets was not provided by any .service files',
  )
  let sandbox: sinon.SinonSandbox
  let home = ''
  let previousHome: string | undefined
  let previousSha: string | undefined
  let previousToken: string | undefined

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-mv-fail-'))
    previousHome = process.env.HOME
    previousSha = process.env.CAST_DEPLOYMENT_SHA
    previousToken = process.env.DIGITALOCEAN_ACCESS_TOKEN
    process.env.HOME = home
    process.env.CAST_DEPLOYMENT_SHA = 'abc123'
    process.env.DIGITALOCEAN_ACCESS_TOKEN = 'dop_test'
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
    sandbox.stub(console, 'error')
    sandbox.stub(console, 'log')
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousSha === undefined) delete process.env.CAST_DEPLOYMENT_SHA
    else process.env.CAST_DEPLOYMENT_SHA = previousSha
    if (previousToken === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
    else process.env.DIGITALOCEAN_ACCESS_TOKEN = previousToken
    if (home) fs.rmSync(home, {recursive: true, force: true})
  })

  function deploymentTokenPath(): string {
    return path.join(home, '.cast', 'tokens', 'deployments', 'abc123.token')
  }

  function agentTokenPath(): string {
    return path.join(home, '.cast', 'tokens', `${agentName}.token`)
  }

  function readyVm(): string {
    return JSON.stringify([{
      id: 'vm-new',
      state: 'running',
      region: 'mkc1',
      urls: [{default: true, endpoint: 'vm-new.mkc1.microvm.ondigitalocean.com', status: 'ACTIVE'}],
    }])
  }

  function failedVm(): string {
    return JSON.stringify([{
      id: 'vm-new',
      state: 'failed',
      failure_reason: 'workload container exited (code 1)',
      region: 'mkc1',
    }])
  }

  it('removes the deployment token file and the agent token when nothing else is live', async () => {
    sandbox.stub(db, 'listDeployments').returns([])
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await keychain.setToken(agentName, 'agent-secret')
    expect(fs.statSync(deploymentTokenPath()).mode & 0o777).to.equal(0o600)
    await discardFailedMicrovmTokens(agentName, 'abc123')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('leaves the agent token when another deployment is still live', async () => {
    sandbox.stub(db, 'listDeployments').returns([{id: 'bbbbbb'}])
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await keychain.setToken(agentName, 'agent-secret')
    await discardFailedMicrovmTokens(agentName, 'abc123')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.readFileSync(agentTokenPath(), 'utf8')).to.equal('agent-secret')
  })

  it('deletes the pushed tag and still removes token files when the tag is already gone', async () => {
    sandbox.stub(db, 'listDeployments').returns([])
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await keychain.setToken(agentName, 'agent-secret')
    const warnings: string[] = []
    const exec = sandbox.stub(deployUtils, 'execCommand').resolves({exitCode: 1, stdout: '', stderr: 'tag not found'})
    await removeFailedMicrovmArtifacts({
      token: 'dop_test',
      ociRef: 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:abc123',
      agentName,
      deploymentSha: 'abc123',
      removeTokens: true,
      warn: message => warnings.push(message),
    })
    const args = exec.firstCall.args[1] as string[]
    expect(args).to.include.members([
      'delete-tag', 'cast-mv-cleanup-agent', 'abc123', '--registry', 'cast', '--force',
    ])
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
    expect(warnings).to.deep.equal([])
  })

  it('warns when tag deletion is denied and still removes the token files', async () => {
    sandbox.stub(db, 'listDeployments').returns([])
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await keychain.setToken(agentName, 'agent-secret')
    const warnings: string[] = []
    sandbox.stub(deployUtils, 'execCommand').resolves({exitCode: 1, stdout: '', stderr: 'permission denied'})
    await removeFailedMicrovmArtifacts({
      token: 'dop_test',
      ociRef: 'not-a-ref',
      agentName,
      deploymentSha: 'abc123',
      removeTokens: true,
      warn: message => warnings.push(message),
    })
    expect(warnings[0]).to.include('Unrecognized image reference')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)

    warnings.length = 0
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await removeFailedMicrovmArtifacts({
      token: 'dop_test',
      ociRef: 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:abc123',
      agentName,
      deploymentSha: 'abc123',
      removeTokens: true,
      warn: message => warnings.push(message),
    })
    expect(warnings[0]).to.include('Failed to delete registry tag')
    expect(warnings[0]).to.include('permission denied')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
  })

  type DeployMode = 'probe-401' | 'workload-failed' | 'build-failed' | 'delete-denied' | 'tag-denied' | 'success'

  async function runDeploy(opts: {
    mode: DeployMode
    edgeAuthOnly?: boolean
    deployments?: Array<{id: string}>
  }): Promise<{error?: Error; warnings: string[]; calls: string[][]; saved: unknown[][]}> {
    fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
    const calls: string[][] = []
    const warnings: string[] = []
    const saved: unknown[][] = []
    sandbox.stub(db, 'listDeployments').returns(opts.deployments ?? [])
    sandbox.stub(db, 'createDeployment').callsFake((...args: unknown[]) => {
      saved.push(args)
    })
    sandbox.stub(deployUtils, 'inferenceEnv').returns({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = []) => {
      calls.push([command, ...args])
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'buildx' && opts.mode === 'build-failed') {
          return {exitCode: 1, stdout: '', stderr: 'build exploded'}
        }
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      if (command !== 'doctl') return {exitCode: 1, stdout: '', stderr: `unexpected ${command}`}
      const rest = args[0] === '--access-token' ? args.slice(2) : args
      if (rest[0] === 'version') return ok('doctl version 1.180.0-release\n')
      if (rest[0] === 'registry' && rest[1] === 'get') return ok('[{"name":"cast"}]')
      if (rest[0] === 'registry' && rest[1] === 'docker-config') {
        return ok(JSON.stringify({auths: {'registry.digitalocean.com': {auth: 'dGVzdDp0ZXN0'}}}))
      }
      if (rest[0] === 'registry' && rest[2] === 'delete-tag') {
        if (opts.mode === 'tag-denied') return {exitCode: 1, stdout: '', stderr: 'permission denied'}
        return ok('')
      }
      if (rest[0] === 'compute' && rest[2] === 'options') return ok('{"regions":["mkc1"]}')
      if (rest[0] === 'compute' && rest[2] === 'create') {
        return ok(opts.mode === 'workload-failed' ? failedVm() : readyVm())
      }
      if (rest[0] === 'compute' && rest[2] === 'get') return ok(readyVm())
      if (rest[0] === 'compute' && rest[2] === 'exec') return ok('')
      if (rest[0] === 'compute' && rest[2] === 'delete') {
        if (opts.mode === 'delete-denied') return {exitCode: 1, stdout: '', stderr: 'denied'}
        return ok('')
      }
      return {exitCode: 1, stdout: '', stderr: `unexpected doctl ${rest.join(' ')}`}
    })
    sandbox.stub(axios, 'post').callsFake(async () => {
      if (opts.mode === 'probe-401' && !opts.edgeAuthOnly && !(opts.deployments && opts.deployments.length > 0)) {
        expect(fs.existsSync(deploymentTokenPath())).to.equal(true)
        expect(fs.statSync(deploymentTokenPath()).mode & 0o777).to.equal(0o600)
        expect(fs.existsSync(agentTokenPath())).to.equal(true)
      }
      if (opts.mode === 'success') return {status: 200, data: {result: {name: agentName}}}
      return {status: 401, data: {error: 'unauthorized'}}
    })
    const instance: any = new MicrovmDeploy(['microvm', agentName], {} as any)
    sandbox.stub(instance, 'parse').resolves({
      args: {agent: agentName},
      flags: {size: '1:2048', 'idle-timeout': '15m', 'edge-auth-only': Boolean(opts.edgeAuthOnly)},
    })
    sandbox.stub(instance, 'log').returns(undefined)
    sandbox.stub(instance, 'warn').callsFake((message: unknown) => {
      warnings.push(String(message))
    })
    sandbox.stub(instance, 'error').callsFake((message: unknown) => {
      throw new Error(String(message))
    })
    try {
      await instance.run()
      return {warnings, calls, saved}
    } catch (error: any) {
      return {error, warnings, calls, saved}
    }
  }

  function tagDeletes(calls: string[][]): string[][] {
    return calls.filter(call => call[0] === 'doctl' && call.includes('delete-tag'))
  }

  function vmDeletes(calls: string[][]): string[][] {
    return calls.filter(call => call[0] === 'doctl' && call.includes('microvm') && call.includes('delete') && !call.includes('delete-tag'))
  }

  it('deletes the registry tag and token files when the readiness probe fails', async () => {
    const result = await runDeploy({mode: 'probe-401'})
    expect(result.error?.message).to.include('MicroVM endpoint returned 401')
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(tagDeletes(result.calls)).to.have.length(1)
    expect(tagDeletes(result.calls)[0]).to.include.members([
      'cast-mv-cleanup-agent', 'abc123', '--registry', 'cast', '--force',
    ])
    expect(vmDeletes(result.calls)).to.have.length(1)
    expect(vmDeletes(result.calls)[0]).to.include('vm-new')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
    expect(result.saved).to.have.length(0)
    expect(result.warnings).to.deep.equal([])
  })

  it('deletes the tag and token files when the workload fails before the probe', async () => {
    const result = await runDeploy({mode: 'workload-failed'})
    expect(result.error?.message).to.include('workload container exited (code 1)')
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(tagDeletes(result.calls)).to.have.length(1)
    expect(vmDeletes(result.calls)).to.have.length(1)
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
    expect(result.saved).to.have.length(0)
  })

  it('removes the token files when the image build fails before a tag is pushed', async () => {
    const result = await runDeploy({mode: 'build-failed'})
    expect(result.error?.message).to.include('build exploded')
    expect(tagDeletes(result.calls)).to.have.length(0)
    expect(vmDeletes(result.calls)).to.have.length(0)
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('keeps the tag and token files when the MicroVM cannot be deleted', async () => {
    const result = await runDeploy({mode: 'delete-denied'})
    expect(result.error?.message).to.include('still on the account')
    expect(result.error?.message).to.include('cast shutdown mv-cleanup-agent')
    expect(tagDeletes(result.calls)).to.have.length(0)
    expect(fs.existsSync(deploymentTokenPath())).to.equal(true)
    expect(fs.existsSync(agentTokenPath())).to.equal(true)
    expect(result.saved).to.have.length(1)
    expect(String(result.saved[0][6])).to.include('registry.digitalocean.com/cast/cast-mv-cleanup-agent:abc123')
  })

  it('reports tag deletion failure and still removes the token files', async () => {
    const result = await runDeploy({mode: 'tag-denied'})
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(result.error?.message).to.not.include('permission denied')
    expect(result.warnings.join('\n')).to.include('permission denied')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('leaves the agent token when another deployment is live and the probe fails', async () => {
    await keychain.setToken(agentName, 'agent-secret')
    const result = await runDeploy({mode: 'probe-401', deployments: [{id: 'bbbbbb'}]})
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(tagDeletes(result.calls)).to.have.length(1)
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.readFileSync(agentTokenPath(), 'utf8')).to.equal('agent-secret')
  })

  it('does not delete a pre-existing token file for an edge-auth-only failure', async () => {
    await keychain.setToken(agentName, 'agent-secret')
    const result = await runDeploy({mode: 'probe-401', edgeAuthOnly: true})
    expect(result.error?.message).to.include('microvm:access')
    expect(tagDeletes(result.calls)).to.have.length(1)
    expect(fs.readFileSync(agentTokenPath(), 'utf8')).to.equal('agent-secret')
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
  })

  it('leaves the tag and token files after a successful deploy', async () => {
    const result = await runDeploy({mode: 'success'})
    expect(result.error).to.equal(undefined)
    expect(tagDeletes(result.calls)).to.have.length(0)
    expect(vmDeletes(result.calls)).to.have.length(0)
    expect(fs.existsSync(deploymentTokenPath())).to.equal(true)
    expect(fs.existsSync(agentTokenPath())).to.equal(true)
    expect(result.saved).to.have.length(1)
  })

  it('deletes the replacement tag after a failed upgrade and leaves the token files', async () => {
    await keychain.setDeploymentToken('abc123', 'deploy-secret')
    await keychain.setToken(agentName, 'agent-secret')
    fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'inferenceEnv').returns({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = []) => {
      calls.push([command, ...args])
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      const rest = args[0] === '--access-token' ? args.slice(2) : args
      if (rest[0] === 'registry' && rest[1] === 'get') return ok('[{"name":"cast"}]')
      if (rest[0] === 'registry' && rest[1] === 'docker-config') {
        return ok(JSON.stringify({auths: {'registry.digitalocean.com': {auth: 'dGVzdDp0ZXN0'}}}))
      }
      if (rest[0] === 'compute' && rest[2] === 'get') return ok(readyVm())
      if (rest[0] === 'compute' && rest[2] === 'exec') return ok('')
      if (rest[0] === 'compute' && rest[2] === 'create') return ok(readyVm())
      if (rest[0] === 'compute' && rest[2] === 'delete') return ok('')
      if (rest[0] === 'registry' && rest[2] === 'delete-tag') return ok('')
      return {exitCode: 1, stdout: '', stderr: `unexpected ${command} ${rest.join(' ')}`}
    })
    sandbox.stub(axios, 'post').resolves({status: 401, data: {}})
    const logs: string[] = []
    try {
      await MicrovmDeploy.upgrade(agentName, {
        id: 'abc123',
        agent_name: agentName,
        volume_config: JSON.stringify({
          microvmId: 'vm-old',
          region: 'mkc1',
          ociRef: 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:old',
          authMode: 'edge-only',
          cpu: 1,
          memory: 2048,
          idleTimeout: '15m',
        }),
      }, message => logs.push(message))
      expect.fail('upgrade should have failed')
    } catch (error: any) {
      expect(error.message).to.include('The MicroVM was deleted.')
      expect(error.message).to.not.include('vm-old')
    }
    const deleted = tagDeletes(calls)
    expect(deleted).to.have.length(1)
    expect(deleted[0].join(' ')).to.not.include(':old')
    expect(deleted[0].some(arg => arg.startsWith('abc123-'))).to.equal(true)
    expect(vmDeletes(calls).some(call => call.includes('vm-old'))).to.equal(false)
    expect(vmDeletes(calls).some(call => call.includes('vm-new'))).to.equal(true)
    expect(fs.readFileSync(deploymentTokenPath(), 'utf8')).to.equal('deploy-secret')
    expect(fs.readFileSync(agentTokenPath(), 'utf8')).to.equal('agent-secret')
    expect(logs.join('\n')).to.not.include('Failed to delete registry tag')
  })

  it('keeps the replacement tag when the new MicroVM cannot be deleted', async () => {
    fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'inferenceEnv').returns({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = []) => {
      calls.push([command, ...args])
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      const rest = args[0] === '--access-token' ? args.slice(2) : args
      if (rest[0] === 'registry' && rest[1] === 'get') return ok('[{"name":"cast"}]')
      if (rest[0] === 'registry' && rest[1] === 'docker-config') {
        return ok(JSON.stringify({auths: {'registry.digitalocean.com': {auth: 'dGVzdDp0ZXN0'}}}))
      }
      if (rest[0] === 'compute' && rest[2] === 'get') return ok(readyVm())
      if (rest[0] === 'compute' && rest[2] === 'exec') return ok('')
      if (rest[0] === 'compute' && rest[2] === 'create') return ok(readyVm())
      if (rest[0] === 'compute' && rest[2] === 'delete') return {exitCode: 1, stdout: '', stderr: 'denied'}
      if (rest[0] === 'registry' && rest[2] === 'delete-tag') return ok('')
      return {exitCode: 1, stdout: '', stderr: `unexpected ${command} ${rest.join(' ')}`}
    })
    sandbox.stub(axios, 'post').resolves({status: 401, data: {}})
    try {
      await MicrovmDeploy.upgrade(agentName, {
        id: 'abc123',
        agent_name: agentName,
        volume_config: JSON.stringify({
          microvmId: 'vm-old',
          region: 'mkc1',
          ociRef: 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:old',
          authMode: 'edge-only',
          cpu: 1,
          memory: 2048,
          idleTimeout: '15m',
        }),
      }, () => undefined)
      expect.fail('upgrade should have failed')
    } catch (error: any) {
      expect(error.message).to.include('still on the account')
      expect(error.message).to.include('vm-new')
    }
    expect(tagDeletes(calls)).to.have.length(0)
  })
})

describe('MicroVM shutdown registry tag', () => {
  const agentName = 'mv-shutdown-agent'
  let sandbox: sinon.SinonSandbox
  let previousToken: string | undefined
  let logs: string[]

  function volumeConfig(tag: string, microvmId = 'vm-1'): string {
    return JSON.stringify({
      microvmId,
      region: 'mkc1',
      ociRef: `registry.digitalocean.com/cast/cast-mv-shutdown-agent:${tag}`,
      authMode: 'dual',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
    })
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    previousToken = process.env.DIGITALOCEAN_ACCESS_TOKEN
    process.env.DIGITALOCEAN_ACCESS_TOKEN = 'dop_test'
    logs = []
    sandbox.stub(console, 'log').callsFake((line: unknown) => {
      logs.push(String(line))
    })
  })

  afterEach(() => {
    sandbox.restore()
    if (previousToken === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
    else process.env.DIGITALOCEAN_ACCESS_TOKEN = previousToken
  })

  function stubDoctl(opts: {vmExit?: number; vmStderr?: string; tagExit?: number; tagStderr?: string} = {}): string[][] {
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = []) => {
      calls.push([command, ...args])
      const rest = args[0] === '--access-token' ? args.slice(2) : args
      if (rest[1] === 'microvm' && rest[2] === 'delete') {
        return {exitCode: opts.vmExit ?? 0, stdout: '', stderr: opts.vmStderr ?? ''}
      }
      if (rest[2] === 'delete-tag') {
        return {exitCode: opts.tagExit ?? 0, stdout: '', stderr: opts.tagStderr ?? ''}
      }
      return {exitCode: 1, stdout: '', stderr: `unexpected ${rest.join(' ')}`}
    })
    return calls
  }

  function tagDeletes(calls: string[][]): string[][] {
    return calls.filter(call => call.includes('delete-tag'))
  }

  it('deletes that deployment tag after the MicroVM is destroyed', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123', 'vm-1')},
      {id: 'bbbbbb', provider: 'microvm', volume_id: 'vm-2', volume_config: volumeConfig('bbbbbb', 'vm-2')},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    const tags = tagDeletes(calls)
    expect(tags).to.have.length(1)
    expect(tags[0]).to.include.members([
      'cast-mv-shutdown-agent', 'abc123', '--registry', 'cast', '--force',
    ])
    expect(tags[0]).to.not.include('bbbbbb')
    expect(calls.some(call => call.includes('vm-2'))).to.equal(false)
    expect(logs).to.include("Deleted registry tag 'cast-mv-shutdown-agent:abc123'.")
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
  })

  it('deletes the tag when the MicroVM is already gone', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    const calls = stubDoctl({vmExit: 1, vmStderr: 'not found'})
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(tagDeletes(calls)).to.have.length(1)
    expect(logs).to.include("MicroVM 'vm-1' does not exist (already deleted).")
    expect(logs).to.include("Deleted registry tag 'cast-mv-shutdown-agent:abc123'.")
  })

  it('leaves the tag when destroying the MicroVM fails', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    const calls = stubDoctl({vmExit: 1, vmStderr: 'denied'})
    try {
      await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
      expect.fail('destroy should have failed')
    } catch (error: any) {
      expect(error.message).to.include("Failed to destroy MicroVM 'vm-1'")
      expect(error.message).to.include('denied')
    }
    expect(tagDeletes(calls)).to.have.length(0)
  })

  it('treats a missing registry tag as a successful shutdown', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl({tagExit: 1, tagStderr: 'tag not found'})
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(logs).to.not.include("Deleted registry tag 'cast-mv-shutdown-agent:abc123'.")
  })

  it('reports a denied registry tag delete after the MicroVM is gone', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl({tagExit: 1, tagStderr: 'permission denied'})
    try {
      await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
      expect.fail('tag delete should have failed')
    } catch (error: any) {
      expect(error.message).to.include("Failed to delete registry tag 'cast-mv-shutdown-agent:abc123'")
      expect(error.message).to.include('permission denied')
    }
  })

  it('skips the tag when the row has no volume config', async () => {
    sandbox.stub(db, 'listDeployments').returns([])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName, {volume_id: 'vm-1'})
    expect(tagDeletes(calls)).to.have.length(0)
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
  })

  it('uses the caller volume config when the database row is missing', async () => {
    sandbox.stub(db, 'listDeployments').returns([])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName, {volume_id: 'vm-1', volume_config: volumeConfig('abc123')})
    expect(tagDeletes(calls)).to.have.length(1)
    expect(tagDeletes(calls)[0]).to.include('abc123')
  })
})
