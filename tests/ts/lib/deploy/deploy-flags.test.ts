import {expect} from 'chai'
import sinon from 'sinon'
import DeployCommand from '../../../../typescript/cast-cli/src/commands/deploy'
import DigitalOceanDeploy from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import MicrovmDeploy from '../../../../typescript/cast-cli/src/lib/deploy/microvm'
import {digitaloceanProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/digitalocean'
import {microvmProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/microvm'
import type {DeployContext} from '../../../../typescript/cast-cli/src/lib/deploy/types'
import {resetDeploymentProviderRegistry} from '../../../../typescript/cast-cli/src/lib/deploy/registry'

const {cacheCommand} = require('@oclif/core/lib/util/cache-command') as {
  cacheCommand: (command: unknown) => Promise<{flags: Record<string, {description?: string; default?: unknown}>}>
}

function deployContext(overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    agentName: 'demo-agent',
    agentPath: '/tmp/demo-agent',
    force: true,
    authToken: '',
    tokenHash: '',
    flags: {},
    version: 'latest',
    deploymentSha: 'abc123',
    port: 8080,
    withTui: false,
    log: () => {},
    warn: () => {},
    error: (message: string): never => {
      throw new Error(message)
    },
    confirm: async () => true,
    ...overrides,
  }
}

describe('cast deploy flags', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    resetDeploymentProviderRegistry()
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('keeps provider defaults on the provider and leaves the shared --size flag without one', () => {
    const droplet = digitaloceanProvider.flags?.size as {default?: string; description?: string}
    const microvm = microvmProvider.flags?.size as {default?: string; description?: string}
    expect(droplet.default).to.equal('s-2vcpu-2gb')
    expect(droplet.description).to.include('DigitalOcean Droplet')
    expect(microvm.default).to.equal('1:2048')

    const shared = DeployCommand.flags.size
    expect(shared.default).to.equal(undefined)
    expect(String(shared.description)).to.include('s-2vcpu-2gb')
    expect(String(shared.description)).to.include('DigitalOcean MicroVM')
    expect(DeployCommand.flags.port.default).to.equal(8080)
    expect(DeployCommand.flags['idle-timeout'].default).to.equal('15m')
  })

  it('lists deploy flags in oclif help', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(DeployCommand, 'flags')
    expect(descriptor?.enumerable).to.equal(true)

    const copied = {...(DeployCommand as unknown as Record<string, unknown>)}
    const spreadFlags = copied.flags as Record<string, {description?: string}>
    expect(Object.keys(spreadFlags)).to.include.members([
      'force',
      'provider',
      'port',
      'version',
      'with-tui',
      'size',
      'idle-timeout',
      'edge-auth-only',
    ])

    const cached = await cacheCommand(DeployCommand)
    expect(Object.keys(cached.flags)).to.include.members(['force', 'provider', 'with-tui', 'size'])
    expect(cached.flags.size.description).to.include('s-2vcpu-2gb')
    expect(cached.flags.size.default).to.equal(undefined)
  })

  it('forwards --size and --with-tui to the droplet deploy', async () => {
    const run = sandbox.stub(DigitalOceanDeploy, 'run').resolves()
    await digitaloceanProvider.deploy(deployContext({
      withTui: true,
      flags: {size: 's-1vcpu-1gb'},
    }))
    expect(run.calledOnce).to.equal(true)
    expect(run.firstCall.args[0]).to.deep.equal([
      'demo-agent',
      '--with-tui',
      '--size',
      's-1vcpu-1gb',
    ])
  })

  it('leaves the droplet default in place when --size was not passed', async () => {
    const run = sandbox.stub(DigitalOceanDeploy, 'run').resolves()
    await digitaloceanProvider.deploy(deployContext())
    expect(run.firstCall.args[0]).to.deep.equal(['demo-agent'])
  })

  it('uses the MicroVM size default when --size was not passed', async () => {
    const run = sandbox.stub(MicrovmDeploy, 'run').resolves()
    await microvmProvider.deploy(deployContext())
    expect(run.firstCall.args[0]).to.deep.equal([
      'demo-agent',
      '--size',
      '1:2048',
      '--idle-timeout',
      '15m',
    ])
  })

  it('forwards an explicit MicroVM size', async () => {
    const run = sandbox.stub(MicrovmDeploy, 'run').resolves()
    await microvmProvider.deploy(deployContext({
      flags: {size: '2:4096', 'idle-timeout': '30m'},
    }))
    expect(run.firstCall.args[0]).to.deep.equal([
      'demo-agent',
      '--size',
      '2:4096',
      '--idle-timeout',
      '30m',
    ])
  })
})
