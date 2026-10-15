import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  assertUpgradeable,
  buildCreateArgs,
  decodeMemoryExport,
  deploymentEnv,
  doctlVersionAtLeast,
  extractExecStdout,
  memoryChunks,
  MEMORY_EXPORT_LIMIT,
  microvmReady,
  mkc1Available,
  parseIdleTimeout,
  parseMicrovmPayload,
  dockerHostFromInspect,
  parseRegistryDockerConfig,
  parseRegistryName,
  parseSize,
  parseVolumeConfig,
  probeAuthResult,
  sanitizeMicrovmName,
  sanitizeRepoName,
  copyCastRuntime,
  resolveFailedMicrovm,
  settleFailedMicrovm,
} from '../../../typescript/cast-cli/src/lib/deploy/microvm'
import {readDoctlAccessToken} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

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
})
