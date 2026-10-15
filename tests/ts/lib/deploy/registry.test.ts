import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import DeployCommand from '../../../../typescript/cast-cli/src/commands/deploy'
import {localProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/local'
import {microvmProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/microvm'
import type {ConnectContext, DeployContext} from '../../../../typescript/cast-cli/src/lib/deploy/types'
import {
  builtinDeploymentProviders,
  deploymentProviderKeys,
  deploymentProviderLoadErrors,
  deploymentProviderSource,
  getDeploymentProvider,
  listDeploymentProviders,
  resetDeploymentProviderRegistry,
} from '../../../../typescript/cast-cli/src/lib/deploy/registry'

const root = path.resolve(__dirname, '../../../..')
const MICROVM_WITH_TUI_REJECTION =
  'On-host TUI is not available for DigitalOcean MicroVMs. Deploy with --provider digitalocean --with-tui to SSH into a Droplet.'

function castHome(...parts: string[]): string {
  return path.join(os.homedir(), '.cast', ...parts)
}

function writeProvider(dirName: string, source: string): string {
  const dir = castHome('providers', dirName)
  fs.mkdirSync(dir, {recursive: true})
  const filePath = path.join(dir, 'provider.cjs')
  fs.writeFileSync(filePath, source)
  return filePath
}

function clearProviders(): void {
  const providersDir = castHome('providers')
  if (fs.existsSync(providersDir)) fs.rmSync(providersDir, {recursive: true, force: true})
  const configPath = castHome('config.yaml')
  if (fs.existsSync(configPath)) fs.rmSync(configPath)
  resetDeploymentProviderRegistry()
}

describe('deployment provider registry', () => {
  beforeEach(() => {
    clearProviders()
  })

  afterEach(() => {
    clearProviders()
  })

  it('lists built-ins in picker order and keeps number key 7 on local', () => {
    const keys = listDeploymentProviders().map(provider => provider.key)
    expect(keys).to.deep.equal(['railway', 'fly', 'digitalocean', 'microvm', 'sprites', 'docker', 'local'])
    expect(builtinDeploymentProviders.map(provider => provider.key)).to.deep.equal(keys)
    expect(keys[6]).to.equal('local')
    expect(DeployCommand.flags.provider.options).to.deep.equal(keys)
  })

  it('fails unimplemented local deploy and keeps the microvm connect result', async () => {
    const logs: string[] = []
    const ctx = {
      agentName: 'agent',
      agentPath: '/tmp/agent',
      force: false,
      authToken: '',
      tokenHash: '',
      flags: {},
      version: 'latest',
      deploymentSha: 'abc123',
      port: 8080,
      withTui: false,
      log: (message: string) => logs.push(message),
      warn: () => {},
      error: (message: string): never => { throw new Error(message) },
      confirm: async () => true,
    } satisfies DeployContext
    let thrown = ''
    try {
      await localProvider.deploy(ctx)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    expect(thrown).to.equal('Not yet implemented. Use --provider docker for now.')
    expect(logs).to.deep.equal([])
    expect(localProvider.destroy).to.equal(undefined)

    const previous = process.env.DIGITALOCEAN_ACCESS_TOKEN
    process.env.DIGITALOCEAN_ACCESS_TOKEN = 'edge-token'
    try {
      const connectCtx: ConnectContext = {
        agentName: 'agent',
        deployment: {
          id: 'abc123',
          agent_name: 'agent',
          provider: 'microvm',
          deployment_url: 'https://example.invalid',
          volume_config: JSON.stringify({authMode: 'edge-only'}),
        },
        url: 'https://example.invalid',
        token: 'agent-token',
        log: () => {},
        warn: () => {},
        error: (message: string): never => { throw new Error(message) },
      }
      const result = await microvmProvider.connect!(connectCtx)
      expect(result?.edgeToken).to.equal('edge-token')
      expect(result?.token).to.equal(null)
      expect(result?.timeoutHint).to.equal('\nThe MicroVM may be resuming from pause. Try again in a moment.')
    } finally {
      if (previous === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
      else process.env.DIGITALOCEAN_ACCESS_TOKEN = previous
    }
  })

  it('supports with-tui only for digitalocean and rejects it for microvm', () => {
    const digitalocean = getDeploymentProvider('digitalocean')
    const microvm = getDeploymentProvider('microvm')
    expect(digitalocean?.withTui).to.equal('supported')
    expect(microvm?.withTui).to.equal('rejected')
    expect(microvm?.withTuiRejectMessage).to.equal(MICROVM_WITH_TUI_REJECTION)
    for (const provider of listDeploymentProviders()) {
      if (provider.key === 'digitalocean') continue
      expect(provider.withTui).to.not.equal('supported')
    }
  })

  it('matches providers.manifest.json to the built-in modules', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, 'typescript/cast-cli/src/lib/deploy/providers.manifest.json'),
      'utf8',
    )) as Array<Record<string, unknown>>
    expect(manifest.map(entry => entry.key)).to.deep.equal(builtinDeploymentProviders.map(provider => provider.key))
    builtinDeploymentProviders.forEach((provider, index) => {
      const entry = manifest[index]
      expect(entry.key).to.equal(provider.key)
      expect(entry.name).to.equal(provider.name)
      expect(entry.description).to.equal(provider.description)
      expect(entry.cliCommand).to.equal(provider.cli?.command || '')
      expect(entry.cliInstallUrl).to.equal(provider.cli?.installUrl || '')
      expect(entry.supportsWithTui).to.equal(provider.withTui === 'supported')
      expect(entry.order).to.equal((index + 1) * 10)
      if (provider.auth?.command) expect(entry.authCommand).to.equal(provider.auth.command)
      else expect(entry).to.not.have.property('authCommand')
      const envVar = provider.auth?.envVars?.[0]
      if (envVar) expect(entry.authEnvVar).to.equal(envVar)
      else expect(entry).to.not.have.property('authEnvVar')
    })
  })

  it('loads a fixture provider.cjs and accepts it as --provider', () => {
    writeProvider('fixture-host', `
      module.exports = {
        key: 'fixture-host',
        name: 'Fixture Host',
        description: 'External fixture provider',
        async deploy(ctx) { ctx.log('fixture deploy') },
      }
    `)
    resetDeploymentProviderRegistry()
    const keys = deploymentProviderKeys()
    expect(keys.slice(0, 7)).to.deep.equal(['railway', 'fly', 'digitalocean', 'microvm', 'sprites', 'docker', 'local'])
    expect(keys).to.include('fixture-host')
    expect(DeployCommand.flags.provider.options).to.include('fixture-host')
    expect(getDeploymentProvider('fixture-host')?.name).to.equal('Fixture Host')
  })

  it('names both sources when an external reuses railway', () => {
    const filePath = writeProvider('railway', `
      module.exports = {
        key: 'railway',
        name: 'Other Railway',
        description: 'collides',
        async deploy() {},
      }
    `)
    resetDeploymentProviderRegistry()
    const message = deploymentProviderLoadErrors().map(error => error.message).join('\n')
    expect(message).to.include("Deployment provider key 'railway' collides between")
    expect(message).to.include('built-in (providers/railway.ts)')
    expect(message).to.include(filePath)
    expect(deploymentProviderSource('railway')).to.equal('built-in (providers/railway.ts)')
    expect(getDeploymentProvider('railway')?.name).to.equal('Railway')
    expect(listDeploymentProviders().filter(provider => provider.key === 'railway')).to.have.length(1)
  })

  it('keeps built-ins when one external file throws', () => {
    const filePath = writeProvider('bad-host', `throw new Error('fixture-boom')\n`)
    resetDeploymentProviderRegistry()
    const message = deploymentProviderLoadErrors().map(error => error.message).join('\n')
    expect(message).to.include(`Failed to load deployment provider at ${filePath}`)
    expect(message).to.include('fixture-boom')
    expect(deploymentProviderKeys()).to.deep.equal(['railway', 'fly', 'digitalocean', 'microvm', 'sprites', 'docker', 'local'])
  })

  it('loads a deploymentProviders config entry after directory providers', () => {
    writeProvider('dir-host', `
      module.exports = {
        key: 'dir-host',
        name: 'Dir Host',
        description: 'from the providers directory',
        async deploy() {},
      }
    `)
    const configFile = path.join(os.tmpdir(), `cast-config-host-${Date.now()}.cjs`)
    fs.writeFileSync(configFile, `
      module.exports = {
        key: 'config-host',
        name: 'Config Host',
        description: 'from config.yaml',
        async deploy() {},
      }
    `)
    fs.mkdirSync(castHome(), {recursive: true})
    fs.writeFileSync(castHome('config.yaml'), `deploymentProviders:\n  - ${configFile}\n`)
    resetDeploymentProviderRegistry()
    const keys = deploymentProviderKeys()
    expect(keys.indexOf('local')).to.be.lessThan(keys.indexOf('dir-host'))
    expect(keys.indexOf('dir-host')).to.be.lessThan(keys.indexOf('config-host'))
    fs.rmSync(configFile, {force: true})
  })

  it('keeps shared deploy flags and merges microvm flags without a host switch', () => {
    const flags = DeployCommand.flags
    expect(flags.provider.options).to.deep.equal(['railway', 'fly', 'digitalocean', 'microvm', 'sprites', 'docker', 'local'])
    expect(flags.port.default).to.equal(8080)
    // Droplet and MicroVM both declare --size, with different defaults.
    expect(flags.size.default).to.equal(undefined)
    expect(flags['idle-timeout'].default).to.equal('15m')
    expect(flags['edge-auth-only'].default).to.equal(false)
    expect(flags['with-tui'].default).to.equal(false)
    expect(String(flags.size.description)).to.include('DigitalOcean Droplet')
    expect(String(flags.size.description)).to.include('s-2vcpu-2gb')
    expect(String(flags.size.description)).to.include('DigitalOcean MicroVM')
  })

  it('does not switch on provider keys in the command facades', () => {
    const files = [
      'typescript/cast-cli/src/commands/deploy.ts',
      'typescript/cast-cli/src/commands/upgrade.ts',
      'typescript/cast-cli/src/commands/shutdown.ts',
      'typescript/cast-cli/src/commands/connect.ts',
      'typescript/cast-cli/src/lib/deploy/deploy-utils.ts',
    ]
    const providerCase = /case\s+['"](railway|fly|digitalocean|microvm|sprites|docker|local)['"]/
    for (const rel of files) {
      const source = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(source, rel).to.not.match(providerCase)
    }
    const dev = fs.readFileSync(path.join(root, 'typescript/cast-cli/src/commands/dev.ts'), 'utf8')
    expect(dev).to.not.include('lib/deploy/registry')
  })
})

describe('extract-providers manifest', () => {
  it('emits the seven built-ins from providers.manifest.json', () => {
    const tsx = path.join(root, 'docs-site/node_modules/.bin/tsx')
    execFileSync(tsx, ['docs-site/scripts/extract-providers.ts'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    })
    const script = fs.readFileSync(path.join(root, 'docs-site/scripts/extract-providers.ts'), 'utf8')
    expect(script).to.include('JSON.parse')
    expect(script).to.not.include('PROVIDERS')
    expect(script).to.not.include('detectWithTuiSupport')
    expect(script).to.not.include('commands/deploy.ts')

    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, 'typescript/cast-cli/src/lib/deploy/providers.manifest.json'),
      'utf8',
    )) as Array<Record<string, unknown>>
    const extracted = JSON.parse(fs.readFileSync(
      path.join(root, 'docs-site/data/providers.json'),
      'utf8',
    )) as Array<Record<string, unknown>>
    const expected = [...manifest]
      .map(entry => {
        const info: Record<string, unknown> = {
          key: entry.key,
          name: entry.name,
          description: entry.description,
          cliCommand: entry.cliCommand,
          cliInstallUrl: entry.cliInstallUrl,
          supportsWithTui: entry.supportsWithTui === true,
        }
        if (entry.authCommand) info.authCommand = entry.authCommand
        if (entry.authEnvVar) info.authEnvVar = entry.authEnvVar
        return info
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    expect(extracted).to.deep.equal(expected)
    expect(extracted.map(entry => entry.key).sort()).to.deep.equal([
      'digitalocean', 'docker', 'fly', 'local', 'microvm', 'railway', 'sprites',
    ])
    expect(extracted.find(entry => entry.key === 'digitalocean')?.supportsWithTui).to.equal(true)
    expect(extracted.find(entry => entry.key === 'microvm')?.supportsWithTui).to.equal(false)
  })
})
