import {expect} from 'chai'
import axios from 'axios'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import MicrovmDeploy, {
  assertUpgradeable,
  microvmCreatePayload,
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
  parseRegistryRepositoryLimit,
  parseRegistryRepositoryList,
  registryFullMessage,
  registryLimitFromPushError,
  registryRepositoryDeleteUrl,
  isCastAgentRepository,
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

const DOCTL_TOKEN = 'dop_test'

/** doctl argv must not carry the API token. Authenticated calls receive it in the child env. */
function assertDoctlKeepsTokenOffArgv(
  command: string,
  args: string[],
  options?: {env?: NodeJS.ProcessEnv},
): void {
  if (command !== 'doctl') return
  expect(args).to.not.include('--access-token')
  expect(args.join('\0')).to.not.include(DOCTL_TOKEN)
  if (args[0] === 'version') return
  expect(options?.env?.DIGITALOCEAN_ACCESS_TOKEN).to.equal(DOCTL_TOKEN)
}

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

  it('builds a create payload with env and omits AUTH_TOKEN for edge-only', () => {
    const env = deploymentEnv({
      agentName: 'demo',
      authToken: 'secret-token-value',
      inference: {OPENROUTER_API_KEY: 'sk-or-v1-example'},
      edgeAuthOnly: false,
    })
    expect(env.AUTH_TOKEN).to.equal('secret-token-value')
    const edgeEnv = deploymentEnv({agentName: 'demo', authToken: 'secret-token-value', edgeAuthOnly: true})
    expect(edgeEnv.AUTH_TOKEN).to.equal(undefined)
    const payload = microvmCreatePayload({
      name: 'cast-demo-abc',
      ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
      env: edgeEnv,
      agentName: 'demo',
    })
    expect(payload.region).to.equal('mkc1')
    expect(payload.http_port).to.equal(8080)
    expect(payload.http_protocol).to.equal('http')
    expect(JSON.stringify(payload)).to.not.include('AUTH_TOKEN')
    expect(JSON.stringify(payload)).to.not.include('secret-token-value')
    const withSecret = microvmCreatePayload({
      name: 'cast-demo-abc',
      ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
      env,
      agentName: 'demo',
    })
    const environment = withSecret.environment as Record<string, string>
    expect(environment.AUTH_TOKEN).to.equal('secret-token-value')
    expect(environment.OPENROUTER_API_KEY).to.equal('sk-or-v1-example')
    expect(JSON.stringify(withSecret)).to.not.include('--env')
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

  it('builds a repository delete URL only for the repository Cast created for this agent', () => {
    const own = 'registry.digitalocean.com/cast/cast-mv-shutdown-agent:abc123'
    expect(isCastAgentRepository('mv-shutdown-agent', 'cast-mv-shutdown-agent')).to.equal(true)
    expect(isCastAgentRepository('demo-agent', 'cast-demo-agent')).to.equal(true)
    expect(isCastAgentRepository('gandermd', 'gandermd')).to.equal(false)
    expect(isCastAgentRepository('mv-shutdown-agent', 'gandermd')).to.equal(false)
    expect(isCastAgentRepository('mv-shutdown-agent', 'cast-demo-agent')).to.equal(false)
    expect(isCastAgentRepository('mv-shutdown-agent', 'cast-mv-shutdown-agent-extra')).to.equal(false)
    expect(registryRepositoryDeleteUrl('mv-shutdown-agent', own)).to.equal(
      'https://api.digitalocean.com/v2/registries/cast/repositories/cast-mv-shutdown-agent',
    )
    expect(registryRepositoryDeleteUrl('demo-agent', 'registry.digitalocean.com/cast/cast-demo-agent:abc123')).to.equal(
      'https://api.digitalocean.com/v2/registries/cast/repositories/cast-demo-agent',
    )
    expect(registryRepositoryDeleteUrl('mv-shutdown-agent', 'registry.digitalocean.com/cast/gandermd:abc123')).to.equal(undefined)
    expect(registryRepositoryDeleteUrl('mv-shutdown-agent', 'registry.digitalocean.com/cast/cast-demo-agent:abc123')).to.equal(undefined)
    expect(registryRepositoryDeleteUrl('mv-shutdown-agent', 'registry.digitalocean.com/cast/cast-mv-shutdown-agent-extra:abc123')).to.equal(undefined)
  })

  it('reads the repository limit and names only empty cast repositories', () => {
    expect(parseRegistryRepositoryLimit(JSON.stringify({
      subscription: {
        created_at: '2020-01-23T21:19:12Z',
        updated_at: '2020-11-05T15:53:24Z',
        tier: {
          name: 'Basic',
          slug: 'basic',
          included_repositories: 5,
          included_storage_bytes: 5368709120,
          allow_storage_overage: true,
          monthly_price_in_cents: 500,
        },
      },
    }))).to.equal(5)
    expect(parseRegistryRepositoryLimit(JSON.stringify({
      subscription: {tier: {name: 'Starter', slug: 'starter', included_repositories: 1}},
    }))).to.equal(1)
    expect(parseRegistryRepositoryLimit(JSON.stringify({
      subscription: {tier: {name: 'Professional', slug: 'professional', included_repositories: 0}},
    }))).to.equal(undefined)
    expect(parseRegistryRepositoryLimit(JSON.stringify([{
      name: 'cast',
      region: 'nyc3',
      created_at: '2020-01-23T21:19:12Z',
      storage_usage_bytes: 0,
      storage_usage_bytes_updated_at: '2020-01-23T21:19:12Z',
      uuid: '8f3c1c2e-0000-4000-8000-000000000001',
    }]))).to.equal(undefined)
    expect(parseRegistryRepositoryLimit('not-json')).to.equal(undefined)
    const listed = parseRegistryRepositoryList(JSON.stringify({
      meta: {total: 5},
      repositories: [
        {name: 'gandermd', tag_count: 4},
        {name: 'cast-demo-agent', tag_count: 2},
        {name: 'cast-bb4-t', manifest_count: 1},
        {name: 'cast-bb4-do', tag_count: 0, manifest_count: 3},
      ],
    }))
    expect(listed?.total).to.equal(5)
    expect(listed?.repositories.find(repo => repo.name === 'cast-bb4-t')?.tagCount).to.equal(0)
    const message = registryFullMessage({
      registry: 'cast',
      limit: 5,
      count: 5,
      repositories: listed?.repositories,
      agentRepository: 'cast-new-agent',
    })
    expect(message).to.include('already holds 5 repositories')
    expect(message).to.include('limit is 5')
    expect(message).to.include('Empty cast-* repositories: cast-bb4-do, cast-bb4-t.')
    expect(message).to.not.include('gandermd')
    expect(message).to.not.include('cast-demo-agent')
    expect(registryLimitFromPushError('denied: registry contains 5 repositories, limit is 5')).to.deep.equal({count: 5, limit: 5})
    expect(registryLimitFromPushError('docker push failed: denied')).to.equal(undefined)
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
    assertDoctlKeepsTokenOffArgv('doctl', args, exec.firstCall.args[2] as {env?: NodeJS.ProcessEnv})
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
    deployments?: Array<{id: string; provider?: string}>
    registryGet?: string
    repositoryList?: string
    subscription?: unknown
    liveMicrovms?: unknown
    pushStderr?: string
    repositoryDeleteStatus?: number
    repositoryDeleteMessage?: string
    repositoryDeleteError?: string
  }): Promise<{error?: Error; warnings: string[]; calls: string[][]; saved: unknown[][]}> {
    fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
    const calls: string[][] = []
    const warnings: string[] = []
    const saved: unknown[][] = []
    sandbox.stub(db, 'listDeployments').returns(opts.deployments ?? [])
    sandbox.stub(db, 'createDeployment').callsFake((...args: unknown[]) => {
      saved.push(args)
    })
    sandbox.stub(deployUtils, 'inferenceEnv').resolves({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
      calls.push([command, ...args])
      assertDoctlKeepsTokenOffArgv(command, args, options)
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'buildx' && opts.mode === 'build-failed') {
          return {exitCode: 1, stdout: '', stderr: 'build exploded'}
        }
        if (args[0] === 'push' && opts.pushStderr !== undefined) {
          return {exitCode: 1, stdout: '', stderr: opts.pushStderr}
        }
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      if (command !== 'doctl') return {exitCode: 1, stdout: '', stderr: `unexpected ${command}`}
      const rest = args
      if (rest[0] === 'version') return ok('doctl version 1.180.0-release\n')
      if (rest[0] === 'registry' && rest[1] === 'get') return ok(opts.registryGet ?? '[{"name":"cast"}]')
      if (rest[0] === 'registry' && rest[1] === 'repository' && rest[2] === 'list-v2') {
        return ok(opts.repositoryList ?? '[]')
      }
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
    sandbox.stub(axios, 'get').callsFake(async (url: unknown, config?: any) => {
      const target = String(url)
      expect(target).to.not.include('dop_test')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      calls.push(['axios', 'GET', target])
      if (target === 'https://api.digitalocean.com/v2/registry/subscription') {
        return {
          status: 200,
          data: opts.subscription ?? {
            subscription: {tier: {name: 'Professional', slug: 'professional', included_repositories: 0}},
          },
        }
      }
      if (target.startsWith('https://api.digitalocean.com/v2/microvms')) {
        return {status: 200, data: opts.liveMicrovms ?? {microvms: []}}
      }
      throw new Error(`unexpected GET ${target}`)
    })
    sandbox.stub(axios, 'delete').callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.not.include('dop_test')
      expect(String(url)).to.not.include('gandermd')
      expect(String(url)).to.not.include('cast-demo-agent')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      calls.push(['axios', 'DELETE', String(url)])
      if (opts.repositoryDeleteError) throw new Error(opts.repositoryDeleteError)
      if (opts.repositoryDeleteStatus && opts.repositoryDeleteStatus !== 204) {
        return {status: opts.repositoryDeleteStatus, data: {message: opts.repositoryDeleteMessage ?? 'permission denied'}}
      }
      return {status: 204, data: ''}
    })
    sandbox.stub(axios, 'post').callsFake(async (url: unknown) => {
      if (String(url).includes('/v2/microvms')) {
        const raw = opts.mode === 'workload-failed' ? failedVm() : readyVm()
        return {status: 201, data: JSON.parse(raw)}
      }
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

  function repositoryDeleteUrls(calls: string[][]): string[] {
    return calls.filter(call => call[0] === 'axios' && call[1] === 'DELETE').map(call => call[2])
  }

  const agentRepositoryUrl = 'https://api.digitalocean.com/v2/registries/cast/repositories/cast-mv-cleanup-agent'

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
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([agentRepositoryUrl])
    expect(result.calls.some(call => call.join(' ').includes('gandermd'))).to.equal(false)
    expect(result.calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
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

  it('does not delete the repository while another MicroVM for the agent is live', async () => {
    const result = await runDeploy({mode: 'probe-401', deployments: [{id: 'bbbbbb', provider: 'microvm'}]})
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(tagDeletes(result.calls)).to.have.length(1)
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([])
  })

  it('does not delete the repository when another live MicroVM uses that image', async () => {
    const result = await runDeploy({
      mode: 'probe-401',
      liveMicrovms: {
        microvms: [{
          id: 'vm-elsewhere',
          source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-cleanup-agent:from-another-machine'},
        }],
      },
    })
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([])
    expect(result.warnings).to.deep.equal([
      "Left registry repository 'cast-mv-cleanup-agent' in place. Another MicroVM still uses an image from that repository.",
    ])
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('warns with the leftover repository when cleanup fails and still removes the token files', async () => {
    const result = await runDeploy({mode: 'probe-401', repositoryDeleteStatus: 403, repositoryDeleteMessage: 'permission denied'})
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(result.error?.message).to.not.include('permission denied')
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([agentRepositoryUrl])
    expect(result.warnings).to.deep.equal([
      "Failed to delete registry repository 'cast-mv-cleanup-agent'. The repository is still in the registry: permission denied",
    ])
    expect(fs.existsSync(deploymentTokenPath())).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('warns with the leftover repository when the registry request throws and still finishes', async () => {
    const result = await runDeploy({mode: 'probe-401', repositoryDeleteError: 'socket hang up'})
    expect(result.error?.message).to.include('The MicroVM was deleted.')
    expect(result.warnings).to.deep.equal([
      "Failed to delete registry repository 'cast-mv-cleanup-agent'. The repository is still in the registry: socket hang up",
    ])
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('stops before the image build when the registry repository limit is already reached', async () => {
    const result = await runDeploy({
      mode: 'success',
      registryGet: JSON.stringify([{
        name: 'cast',
        region: 'nyc3',
        created_at: '2020-01-23T21:19:12Z',
        storage_usage_bytes: 0,
        storage_usage_bytes_updated_at: '2020-01-23T21:19:12Z',
        uuid: '8f3c1c2e-0000-4000-8000-000000000001',
      }]),
      subscription: {
        subscription: {
          created_at: '2020-01-23T21:19:12Z',
          updated_at: '2020-11-05T15:53:24Z',
          tier: {
            name: 'Basic',
            slug: 'basic',
            included_repositories: 5,
            included_storage_bytes: 5368709120,
            allow_storage_overage: true,
            monthly_price_in_cents: 500,
          },
        },
      },
      repositoryList: JSON.stringify([
        {name: 'gandermd', tag_count: 4, manifest_count: 4},
        {name: 'cast-demo-agent', tag_count: 2, manifest_count: 2},
        {name: 'cast-bb5-fail', tag_count: 0, manifest_count: 1},
        {name: 'cast-bb4-t', manifest_count: 1},
        {name: 'cast-bb4-do', tag_count: 0, manifest_count: 3},
      ]),
    })
    expect(result.error?.message).to.include('already holds 5 repositories')
    expect(result.error?.message).to.include('limit is 5')
    expect(result.error?.message).to.include('Empty cast-* repositories: cast-bb4-do, cast-bb4-t, cast-bb5-fail.')
    expect(result.error?.message).to.include('cast-mv-cleanup-agent')
    expect(result.error?.message).to.not.include('gandermd')
    expect(result.error?.message).to.not.include('cast-demo-agent')
    expect(result.calls.some(call => call[0] === 'docker' && call[1] === 'buildx')).to.equal(false)
    expect(result.calls).to.deep.include(['axios', 'GET', 'https://api.digitalocean.com/v2/registry/subscription'])
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([])
    expect(result.calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(fs.existsSync(agentTokenPath())).to.equal(false)
  })

  it('keeps deploying when this agent already has a repository at the limit', async () => {
    const result = await runDeploy({
      mode: 'success',
      registryGet: JSON.stringify([{
        name: 'cast',
        region: 'nyc3',
        created_at: '2020-01-23T21:19:12Z',
        storage_usage_bytes: 0,
        storage_usage_bytes_updated_at: '2020-01-23T21:19:12Z',
        uuid: '8f3c1c2e-0000-4000-8000-000000000001',
      }]),
      subscription: {
        subscription: {tier: {name: 'Basic', slug: 'basic', included_repositories: 5}},
      },
      repositoryList: JSON.stringify([
        {name: 'gandermd', tag_count: 1},
        {name: 'cast-demo-agent', tag_count: 1},
        {name: 'cast-bb4-do', tag_count: 0},
        {name: 'cast-bb4-t', tag_count: 0},
        {name: 'cast-mv-cleanup-agent', tag_count: 1},
      ]),
    })
    expect(result.error).to.equal(undefined)
    expect(result.calls.some(call => call[0] === 'docker' && call[1] === 'buildx')).to.equal(true)
    expect(repositoryDeleteUrls(result.calls)).to.deep.equal([])
  })

  it('explains a push that is denied because the registry is full', async () => {
    const result = await runDeploy({
      mode: 'success',
      pushStderr: 'denied: registry contains 5 repositories, limit is 5',
      repositoryList: JSON.stringify([
        {name: 'gandermd', tag_count: 4},
        {name: 'cast-demo-agent', tag_count: 2},
        {name: 'cast-bb4-do', tag_count: 0, manifest_count: 3},
      ]),
    })
    expect(result.error?.message).to.include('already holds 5 repositories')
    expect(result.error?.message).to.include('limit is 5')
    expect(result.error?.message).to.include('Empty cast-* repositories: cast-bb4-do.')
    expect(result.error?.message).to.not.include('docker push failed')
    expect(result.error?.message).to.not.include('gandermd')
    expect(result.error?.message).to.not.include('cast-demo-agent')
    expect(result.calls.some(call => call[0] === 'docker' && call[1] === 'buildx')).to.equal(true)
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
    sandbox.stub(deployUtils, 'inferenceEnv').resolves({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
      calls.push([command, ...args])
      assertDoctlKeepsTokenOffArgv(command, args, options)
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      const rest = args
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
    const repositoryDeletes = sandbox.stub(axios, 'delete').rejects(new Error('refusing live DigitalOcean call'))
    sandbox.stub(axios, 'get').resolves({
      status: 200,
      data: {subscription: {tier: {name: 'Professional', slug: 'professional', included_repositories: 0}}},
    })
    sandbox.stub(axios, 'post').callsFake(async (url: unknown) => {
      if (String(url).includes('/v2/microvms')) {
        return {status: 201, data: JSON.parse(readyVm())}
      }
      return {status: 401, data: {}}
    })
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
    expect(repositoryDeletes.called).to.equal(false)
  })

  it('keeps the replacement tag when the new MicroVM cannot be deleted', async () => {
    fs.mkdirSync(path.join(home, '.cast', 'agents', agentName), {recursive: true})
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'inferenceEnv').resolves({})
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
      calls.push([command, ...args])
      assertDoctlKeepsTokenOffArgv(command, args, options)
      const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''})
      if (command === 'docker') {
        if (args[0] === 'info' || args[0] === 'buildx' || args[0] === 'tag' || args[0] === 'push') return ok('')
        if (args[0] === 'image') return ok('amd64\n')
        if (args[0] === 'context') return ok('unix:///var/run/docker.sock\n')
        return {exitCode: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}`}
      }
      const rest = args
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
    const repositoryDeletes = sandbox.stub(axios, 'delete').rejects(new Error('refusing live DigitalOcean call'))
    sandbox.stub(axios, 'get').resolves({
      status: 200,
      data: {subscription: {tier: {name: 'Professional', slug: 'professional', included_repositories: 0}}},
    })
    sandbox.stub(axios, 'post').callsFake(async (url: unknown) => {
      if (String(url).includes('/v2/microvms')) {
        return {status: 201, data: JSON.parse(readyVm())}
      }
      return {status: 401, data: {}}
    })
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
    expect(repositoryDeletes.called).to.equal(false)
  })
})

describe('MicroVM shutdown registry tag', () => {
  const agentName = 'mv-shutdown-agent'
  const agentRepositoryUrl = 'https://api.digitalocean.com/v2/registries/cast/repositories/cast-mv-shutdown-agent'
  let sandbox: sinon.SinonSandbox
  let previousToken: string | undefined
  let logs: string[]
  let registryDeletes: sinon.SinonStub
  let microvmLists: sinon.SinonStub

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
    microvmLists = sandbox.stub(axios, 'get').callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.equal('https://api.digitalocean.com/v2/microvms?per_page=200')
      expect(String(url)).to.not.include('dop_test')
      expect(String(url)).to.not.include('gandermd')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return {status: 200, data: {microvms: []}}
    })
    registryDeletes = sandbox.stub(axios, 'delete').callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.not.include('dop_test')
      expect(String(url)).to.not.include('gandermd')
      expect(String(url)).to.not.include('cast-demo-agent')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return {status: 204, data: ''}
    })
  })

  afterEach(() => {
    sandbox.restore()
    if (previousToken === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
    else process.env.DIGITALOCEAN_ACCESS_TOKEN = previousToken
  })

  function stubDoctl(opts: {vmExit?: number; vmStderr?: string; tagExit?: number; tagStderr?: string} = {}): string[][] {
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
      calls.push([command, ...args])
      assertDoctlKeepsTokenOffArgv(command, args, options)
      const rest = args
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

  function deletedUrls(): string[] {
    return registryDeletes.getCalls().map(call => String(call.args[0]))
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
    expect(deletedUrls()).to.deep.equal([])
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
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
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(logs).to.include("Deleted registry repository 'cast-mv-shutdown-agent'.")
  })

  it('warns about a leftover tag when the delete is denied and still finishes', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl({tagExit: 1, tagStderr: 'permission denied'})
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
    expect(warnings).to.deep.equal([
      "Failed to delete registry tag 'cast-mv-shutdown-agent:abc123'. The tag is still in the registry: permission denied",
    ])
    expect(deletedUrls()).to.deep.equal([])
  })

  it('destroys the next MicroVM when an earlier tag delete fails', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123', 'vm-1')},
      {id: 'bbbbbb', provider: 'microvm', volume_id: 'vm-2', volume_config: volumeConfig('bbbbbb', 'vm-2')},
    ])
    const calls: string[][] = []
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
      calls.push([command, ...args])
      assertDoctlKeepsTokenOffArgv(command, args, options)
      const rest = args
      if (rest[2] === 'delete-tag' && rest.includes('abc123')) {
        return {exitCode: 1, stdout: '', stderr: 'permission denied'}
      }
      if (rest[2] === 'delete-tag' || (rest[1] === 'microvm' && rest[2] === 'delete')) {
        return {exitCode: 0, stdout: '', stderr: ''}
      }
      return {exitCode: 1, stdout: '', stderr: `unexpected ${rest.join(' ')}`}
    })
    await MicrovmDeploy.destroy(agentName)
    expect(calls.some(call => call.includes('vm-2') && call.includes('delete'))).to.equal(true)
    expect(calls.some(call => call.includes('delete-tag') && call.includes('bbbbbb'))).to.equal(true)
    expect(logs).to.include("MicroVM 'vm-2' has been destroyed.")
    expect(logs).to.include("Deleted registry tag 'cast-mv-shutdown-agent:bbbbbb'.")
    expect(warnings.join('\n')).to.include("Failed to delete registry tag 'cast-mv-shutdown-agent:abc123'")
    expect(warnings.join('\n')).to.include('still in the registry')
    expect(warnings.join('\n')).to.not.include('bbbbbb')
    expect(deletedUrls()).to.deep.equal([])
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(calls.some(call => call.includes('gandermd'))).to.equal(false)
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
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(logs).to.include("Deleted registry repository 'cast-mv-shutdown-agent'.")
  })

  it('deletes the cast repository after the last MicroVM for the agent is destroyed', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123', 'vm-1')},
      {id: 'bbbbbb', provider: 'microvm', volume_id: 'vm-2', volume_config: volumeConfig('bbbbbb', 'vm-2')},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName)
    expect(tagDeletes(calls)).to.have.length(2)
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(logs).to.include("Deleted registry repository 'cast-mv-shutdown-agent'.")
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(calls.some(call => call.includes('gandermd'))).to.equal(false)
    expect(calls.some(call => call.includes('cast-demo-agent'))).to.equal(false)
  })

  it('does not delete registry repositories that do not belong to the agent', async () => {
    const foreign = (repo: string, id: string) => JSON.stringify({
      microvmId: id,
      region: 'mkc1',
      ociRef: `registry.digitalocean.com/cast/${repo}:abc123`,
      authMode: 'dual',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: foreign('gandermd', 'vm-1')},
      {id: 'bbbbbb', provider: 'microvm', volume_id: 'vm-2', volume_config: foreign('cast-demo-agent', 'vm-2')},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName)
    expect(tagDeletes(calls)).to.have.length(0)
    expect(deletedUrls()).to.deep.equal([])
    expect(calls.some(call => call.includes('gandermd'))).to.equal(false)
    expect(calls.some(call => call.includes('cast-demo-agent'))).to.equal(false)
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(logs.join('\n')).to.include("Left registry repository 'gandermd' in place.")
    expect(logs.join('\n')).to.include("Left registry repository 'cast-demo-agent' in place.")
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
    expect(logs).to.include("MicroVM 'vm-2' has been destroyed.")
  })

  it('warns with the leftover repository when repository delete fails and still finishes', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    registryDeletes.resolves({status: 403, data: {message: 'permission denied'}})
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
    expect(logs).to.include("Deleted registry tag 'cast-mv-shutdown-agent:abc123'.")
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(warnings).to.deep.equal([
      "Failed to delete registry repository 'cast-mv-shutdown-agent'. The repository is still in the registry: permission denied",
    ])
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(calls.some(call => call.includes('gandermd'))).to.equal(false)
  })

  it('warns with the leftover repository when the registry request throws and still finishes', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    registryDeletes.rejects(new Error('socket hang up'))
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
    expect(warnings).to.deep.equal([
      "Failed to delete registry repository 'cast-mv-shutdown-agent'. The repository is still in the registry: socket hang up",
    ])
  })

  it('treats HTTP 202 as a deleted registry repository', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    registryDeletes.callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.equal(agentRepositoryUrl)
      expect(String(url)).to.not.include('dop_test')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return {status: 202, data: ''}
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(logs).to.include("Deleted registry repository 'cast-mv-shutdown-agent'.")
    expect(warnings).to.deep.equal([])
  })

  it('does not count a deployment row with no MicroVM id as destroyed', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123', 'vm-1')},
      {id: 'cccccc', provider: 'microvm'},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy(agentName)
    expect(tagDeletes(calls)).to.have.length(1)
    expect(deletedUrls()).to.deep.equal([])
    expect(microvmLists.called).to.equal(false)
  })

  it('leaves the repository when another live MicroVM uses that image', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    microvmLists.callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.equal('https://api.digitalocean.com/v2/microvms?per_page=200')
      expect(String(url)).to.not.include('dop_test')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return {
        status: 200,
        data: {
          microvms: [
            {
              id: 'vm-1',
              source: {oci_ref: 'registry.digitalocean.com/cast/cast-a-b:abc123'},
            },
            {
              id: 'vm-other',
              source: {oci_ref: 'registry.digitalocean.com/cast/cast-a-b:from-another-machine'},
            },
            {
              id: 'vm-gander',
              source: {oci_ref: 'registry.digitalocean.com/cast/gandermd:latest'},
            },
          ],
        },
      }
    })
    const colliding = JSON.stringify({
      microvmId: 'vm-1',
      region: 'mkc1',
      ociRef: 'registry.digitalocean.com/cast/cast-a-b:abc123',
      authMode: 'dual',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: colliding},
    ])
    const calls = stubDoctl()
    await MicrovmDeploy.destroy('a.b', {id: 'abc123', volume_id: 'vm-1'})
    expect(deletedUrls()).to.deep.equal([])
    expect(calls.some(call => call.includes('gandermd'))).to.equal(false)
    expect(calls.some(call => call.join(' ').includes('ssh-key'))).to.equal(false)
    expect(warnings).to.deep.equal([
      "Left registry repository 'cast-a-b' in place. Another MicroVM still uses an image from that repository.",
    ])
  })

  it('warns and keeps the repository when the live MicroVM list fails', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    microvmLists.rejects(new Error('socket hang up'))
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(deletedUrls()).to.deep.equal([])
    expect(logs).to.include("MicroVM 'vm-1' has been destroyed.")
    expect(warnings).to.deep.equal([
      "Left registry repository 'cast-mv-shutdown-agent' in place. Could not list live MicroVMs: socket hang up",
    ])
  })

  const siblingWarning = "Left registry repository 'cast-mv-shutdown-agent' in place. Another MicroVM still uses an image from that repository."

  async function destroyOne(list: (url: string) => {status: number; data: unknown}): Promise<string[]> {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    microvmLists.callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.not.include('dop_test')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return list(String(url))
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    return warnings
  }

  it('leaves the repository when another MicroVM uses a digest reference', async () => {
    const warnings = await destroyOne(() => ({
      status: 200,
      data: {
        microvms: [{
          id: 'vm-other',
          source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
        }],
      },
    }))
    expect(deletedUrls()).to.deep.equal([])
    expect(warnings).to.deep.equal([siblingWarning])
  })

  it('leaves the repository when another MicroVM uses an untagged reference', async () => {
    const warnings = await destroyOne(() => ({
      status: 200,
      data: {
        microvms: [{
          id: 'vm-other',
          source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent'},
        }],
      },
    }))
    expect(deletedUrls()).to.deep.equal([])
    expect(warnings).to.deep.equal([siblingWarning])
  })

  it('leaves the repository when another MicroVM has no image reference', async () => {
    const warnings = await destroyOne(() => ({
      status: 200,
      data: {
        microvms: [
          {id: 'vm-other'},
          {id: 'vm-blank', source: {oci_ref: ''}},
          {id: 'vm-foreign', source: {oci_ref: 'docker.io/library/nginx:latest'}},
        ],
      },
    }))
    expect(deletedUrls()).to.deep.equal([])
    expect(warnings).to.deep.equal([siblingWarning])
  })

  it('deletes cast-foo when the only other image is cast-foobar', async () => {
    const warnings: string[] = []
    sandbox.stub(console, 'warn').callsFake((line: unknown) => {
      warnings.push(String(line))
    })
    microvmLists.callsFake(async (url: unknown, config?: any) => {
      expect(String(url)).to.equal('https://api.digitalocean.com/v2/microvms?per_page=200')
      expect(config?.headers?.Authorization).to.equal('Bearer dop_test')
      return {
        status: 200,
        data: {
          microvms: [{
            id: 'vm-other',
            source: {oci_ref: 'registry.digitalocean.com/cast/cast-foobar:latest'},
          }],
        },
      }
    })
    const own = JSON.stringify({
      microvmId: 'vm-1',
      region: 'mkc1',
      ociRef: 'registry.digitalocean.com/cast/cast-foo:abc123',
      authMode: 'dual',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
    })
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: own},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy('foo', {id: 'abc123', volume_id: 'vm-1'})
    expect(deletedUrls()).to.deep.equal([
      'https://api.digitalocean.com/v2/registries/cast/repositories/cast-foo',
    ])
    expect(warnings).to.deep.equal([])
  })

  it('follows a relative MicroVM list page and keeps the repository', async () => {
    const seen: string[] = []
    const warnings = await destroyOne(url => {
      seen.push(url)
      if (url === 'https://api.digitalocean.com/v2/microvms?per_page=200') {
        return {
          status: 200,
          data: {
            microvms: [{
              id: 'vm-1',
              source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent:abc123'},
            }],
            links: {pages: {next: '/v2/microvms?page=2&per_page=200'}},
          },
        }
      }
      return {
        status: 200,
        data: {
          microvms: [{
            id: 'vm-other',
            source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
          }],
        },
      }
    })
    expect(seen).to.deep.equal([
      'https://api.digitalocean.com/v2/microvms?per_page=200',
      'https://api.digitalocean.com/v2/microvms?page=2&per_page=200',
    ])
    expect(deletedUrls()).to.deep.equal([])
    expect(warnings).to.deep.equal([siblingWarning])
  })

  it('keeps the repository when the MicroVM list next page is a foreign host', async () => {
    const warnings = await destroyOne(url => {
      expect(url).to.equal('https://api.digitalocean.com/v2/microvms?per_page=200')
      return {
        status: 200,
        data: {
          microvms: [{
            id: 'vm-1',
            source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent:abc123'},
          }],
          links: {pages: {next: 'https://evil.example/v2/microvms?page=2'}},
        },
      }
    })
    expect(microvmLists.calledOnce).to.equal(true)
    expect(deletedUrls()).to.deep.equal([])
    expect(warnings).to.deep.equal([
      "Left registry repository 'cast-mv-shutdown-agent' in place. Could not list live MicroVMs: MicroVM list returned an unexpected next page.",
    ])
  })

  it('still deletes the repository when the only listed MicroVM is the one just destroyed', async () => {
    microvmLists.callsFake(async () => ({
      status: 200,
      data: {
        microvms: [{
          id: 'vm-1',
          source: {oci_ref: 'registry.digitalocean.com/cast/cast-mv-shutdown-agent:abc123'},
        }],
      },
    }))
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'microvm', volume_id: 'vm-1', volume_config: volumeConfig('abc123')},
    ])
    stubDoctl()
    await MicrovmDeploy.destroy(agentName, {id: 'abc123', volume_id: 'vm-1'})
    expect(deletedUrls()).to.deep.equal([agentRepositoryUrl])
    expect(logs).to.include("Deleted registry repository 'cast-mv-shutdown-agent'.")
  })
})
