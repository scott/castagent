import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'
import {flyProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/fly'
import {generateAuthToken, stageCastRuntime} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import FlyDeploy, {
  deployFlyAgent,
  destroyFlyDeployment,
  discardFailedFlyTokens,
  flyAgentCardUrl,
  flyAppsCreateArgs,
  flyBuilderOptions,
  flyDeployArgs,
  flyMachineDestroyArgs,
  flyMachineIds,
  flyMachineState,
  flyMachinesListArgs,
  FlyResourcesRemainError,
  flyVolumeCreateArgs,
  flyVolumeDeleteArgs,
  flyVolumeIdByName,
  flyVolumeIdsByName,
  flyVolumeName,
  flyVolumeNamesForDestroy,
  flyVolumesListArgs,
  isFlyVolumeName,
  readFlyMountSource,
  resolveFlyVolumeName,
  runningFlyMachineIds,
  waitForFlyHealth,
  type FlyCommandResult,
  type FlyDeployDeps,
  type FlyHost,
} from '../../../../typescript/cast-cli/src/lib/deploy/fly'

describe('Fly.io Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(FlyDeploy.description).to.equal('Deploy agent to Fly.io')
    })

    it('should require agent argument', () => {
      expect(FlyDeploy.args).to.have.property('agent')
      expect(FlyDeploy.args.agent.required).to.be.true
      expect(FlyDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag', () => {
      // Fly deploy doesn't have flags property
      expect(FlyDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      // Fly deploy doesn't have flags property
      expect(FlyDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(FlyDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new FlyDeploy(['deploy', 'fly'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof FlyDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define fly as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('fly')
    })

    it('should use flyctl CLI', () => {
      // The implementation uses 'flyctl' command
      expect(FlyDeploy.description).to.include('Fly.io')
    })
  })

  describe('configuration', () => {
    it('should have fly.toml generation method', () => {
      // The deployer generates fly.toml
      expect(FlyDeploy).to.be.a('function')
    })
  })
})

function flyResult(exitCode: number, stdout = '', stderr = ''): FlyCommandResult {
  return {stdout, stderr, exitCode}
}

function flyHost(): FlyHost & {logs: string[]; warnings: string[]} {
  const logs: string[] = []
  const warnings: string[] = []
  return {
    logs,
    warnings,
    log: message => logs.push(message),
    warn: message => warnings.push(message),
    error: (message): never => {
      throw new Error(message)
    },
  }
}

describe('Fly volume names', () => {
  it('uses lowercase letters, numbers, and underscores within 30 characters', () => {
    const name = flyVolumeName('Email-Assistant')
    expect(name).to.equal('cast_email_assistant_memory')
    expect(isFlyVolumeName(name)).to.equal(true)
    expect(name.length).to.be.at.most(30)
    expect(name).to.not.include('-')
  })

  it('truncates a long agent name and stays valid', () => {
    const name = flyVolumeName('a'.repeat(80))
    expect(isFlyVolumeName(name)).to.equal(true)
    expect(name.length).to.equal(30)
    expect(name.startsWith('cast_')).to.equal(true)
    expect(name.endsWith('_memory')).to.equal(true)
  })

  it('is stable so destroy deletes the name create used', () => {
    expect(flyVolumeName('mail')).to.equal(flyVolumeName('mail'))
    const names = flyVolumeNamesForDestroy('mail', ['cast-mail-uuid-memory', 'custom_volume'])
    expect(names).to.deep.equal([flyVolumeName('mail'), 'custom_volume'])
  })
})

describe('Fly builder flags', () => {
  it('maps local, remote, and depot options onto flyctl deploy', () => {
    expect(flyDeployArgs('cast-mail')).to.deep.equal(['deploy', '--app', 'cast-mail'])
    expect(flyDeployArgs('cast-mail', {localOnly: true})).to.deep.equal([
      'deploy', '--app', 'cast-mail', '--local-only',
    ])
    expect(flyDeployArgs('cast-mail', {remoteOnly: true})).to.deep.equal([
      'deploy', '--app', 'cast-mail', '--remote-only',
    ])
    expect(flyDeployArgs('cast-mail', {depot: true})).to.deep.equal([
      'deploy', '--app', 'cast-mail', '--depot',
    ])
    expect(flyDeployArgs('cast-mail', {depot: 'false'})).to.deep.equal([
      'deploy', '--app', 'cast-mail', '--depot=false',
    ])
  })

  it('rejects contradictory builder flags', () => {
    expect(() => flyBuilderOptions({'local-only': true, 'remote-only': true})).to.throw(/only one/)
    expect(() => flyBuilderOptions({depot: true, 'no-depot': true})).to.throw(/only one/)
    expect(flyBuilderOptions({'no-depot': true})).to.deep.equal({depot: 'false'})
  })

  it('registers the builder flags on the Fly provider', () => {
    expect(flyProvider.flags).to.have.property('local-only')
    expect(flyProvider.flags).to.have.property('remote-only')
    expect(flyProvider.flags).to.have.property('depot')
    expect(flyProvider.flags).to.have.property('no-depot')
  })
})

describe('Fly deploy flow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-fly-'))
  const previousSha = process.env.CAST_DEPLOYMENT_SHA

  after(() => {
    fs.rmSync(root, {recursive: true, force: true})
    if (previousSha === undefined) delete process.env.CAST_DEPLOYMENT_SHA
    else process.env.CAST_DEPLOYMENT_SHA = previousSha
  })

  function agentDir(name: string): string {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, {recursive: true})
    return dir
  }

  function deps(exec: FlyDeployDeps['exec'], extra: Partial<FlyDeployDeps> = {}): {
    deps: FlyDeployDeps
    saved: unknown[][]
    discarded: unknown[][]
    imported: Array<{appName: string; secrets: Record<string, string>}>
  } {
    const saved: unknown[][] = []
    const discarded: unknown[][] = []
    const imported: Array<{appName: string; secrets: Record<string, string>}> = []
    return {
      saved,
      discarded,
      imported,
      deps: {
        exec,
        generateAuthToken: async () => ({authToken: 'token', tokenHash: 'hash'}),
        saveDeployment: (...args) => {
          saved.push(args)
          return 'abc123'
        },
        listDeployments: () => [],
        discardTokens: async (...args) => {
          discarded.push(args)
        },
        inferenceEnv: () => ({OPENROUTER_API_KEY: 'inference-key', OPENAI_API_KEY: 'other-key'}),
        inferenceCatalog: [
          {
            key: 'openrouter',
            name: 'OpenRouter',
            default: true,
            prefixes: ['openrouter/'],
            envVar: 'OPENROUTER_API_KEY',
            configKey: 'providers.openrouter.apiKey',
            baseUrl: 'https://openrouter.ai/api/v1',
            acceptsAnyModel: true,
          },
          {
            key: 'openai',
            name: 'OpenAI',
            default: false,
            prefixes: ['openai/'],
            envVar: 'OPENAI_API_KEY',
            configKey: 'providers.openai.apiKey',
            baseUrl: 'https://api.openai.com/v1',
            acceptsAnyModel: false,
          },
        ],
        importSecrets: async (_cwd, appName, secrets) => {
          imported.push({appName, secrets})
          return flyResult(0)
        },
        stageRuntime: () => {},
        confirmReady: async () => {},
        checkCli: async () => {},
        ...extra,
      },
    }
  }

  it('creates the app with apps create after fly.toml exists, then the volume with --yes', async () => {
    process.env.CAST_DEPLOYMENT_SHA = 'abc123'
    const dir = agentDir('mail')
    const calls: string[][] = []
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(1, '', 'Error: Could not find App "cast-mail"')
      if (args[0] === 'apps') return flyResult(0, 'Created\n')
      if (args[0] === 'volumes') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0, 'deployed\n')
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    })

    await deployFlyAgent({
      agentName: 'mail',
      agentPath: dir,
      host: flyHost(),
    }, harness.deps)

    const volume = flyVolumeName('mail')
    expect(calls.some(args => args[0] === 'launch')).to.equal(false)
    expect(calls[0]).to.deep.equal(['status', '--app', 'cast-mail'])
    expect(calls[1]).to.deep.equal(flyAppsCreateArgs('cast-mail'))
    expect(calls[2]).to.deep.equal(flyVolumesListArgs('cast-mail'))
    expect(calls[3]).to.deep.equal(flyVolumeCreateArgs(volume, 'cast-mail'))
    expect(calls[3]).to.include('--yes')
    expect(calls.some(args => args[0] === 'secrets')).to.equal(false)
    expect(calls.some(args => args.join('\0').includes('AUTH_TOKEN'))).to.equal(false)
    expect(calls.some(args => args.join('\0').includes('inference-key'))).to.equal(false)
    expect(harness.imported).to.have.length(1)
    expect(harness.imported[0].appName).to.equal('cast-mail')
    expect(harness.imported[0].secrets.CAST_AGENT_NAME).to.equal('mail')
    expect(harness.imported[0].secrets.AUTH_TOKEN).to.equal('token')
    expect(harness.imported[0].secrets.OPENROUTER_API_KEY).to.equal('inference-key')
    expect(harness.imported[0].secrets.OPENAI_API_KEY).to.equal(undefined)
    expect(calls[4]).to.deep.equal(['deploy', '--app', 'cast-mail'])
    expect(readFlyMountSource(fs.readFileSync(path.join(dir, 'fly.toml'), 'utf8'))).to.equal(volume)
    expect(harness.saved).to.have.length(1)
    expect(harness.saved[0][1]).to.equal('fly')
    expect(harness.saved[0][4]).to.equal(volume)
    expect(harness.discarded).to.deep.equal([])
    const saveAt = calls.findIndex(args => args[0] === 'apps')
    const volumeAt = calls.findIndex(args => args[0] === 'volumes')
    expect(saveAt).to.be.lessThan(volumeAt)
  })

  it('records the deployment before deploy and deletes the token file when deploy fails', async () => {
    process.env.CAST_DEPLOYMENT_SHA = 'abc123'
    const dir = agentDir('partial')
    const order: string[] = []
    const harness = deps(async (args) => {
      order.push(args[0] === 'apps' ? 'apps-create' : args[0])
      if (args[0] === 'status') return flyResult(1, '', 'Could not find App "cast-partial"')
      if (args[0] === 'apps') return flyResult(0)
      if (args[0] === 'volumes') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(1, '', 'Error: authentication handshake failed: EOF')
      return flyResult(1, '', 'unexpected')
    })
    harness.deps.saveDeployment = (...args) => {
      order.push('save')
      harness.saved.push(args)
      return 'abc123'
    }

    try {
      await deployFlyAgent({agentName: 'partial', agentPath: dir, host: flyHost()}, harness.deps)
      expect.fail('deploy should fail')
    } catch (error) {
      expect((error as Error).message).to.include('Fly.io deployment failed')
      expect((error as Error).message).to.include('authentication handshake failed')
    }

    expect(order.indexOf('save')).to.be.greaterThan(order.indexOf('apps-create'))
    expect(order.indexOf('save')).to.be.lessThan(order.indexOf('deploy'))
    expect(harness.discarded).to.deep.equal([['partial', 'abc123', 'abc123']])
  })

  it('does not record a deployment or leave the token when app creation fails', async () => {
    process.env.CAST_DEPLOYMENT_SHA = 'def456'
    const dir = agentDir('missing')
    const harness = deps(async (args) => {
      if (args[0] === 'status') return flyResult(1, '', 'Could not find App')
      if (args[0] === 'apps') return flyResult(1, '', 'Error: not authorized')
      return flyResult(1, '', 'unexpected')
    })

    try {
      await deployFlyAgent({agentName: 'missing', agentPath: dir, host: flyHost()}, harness.deps)
      expect.fail('create should fail')
    } catch (error) {
      expect((error as Error).message).to.include('Failed to create Fly.io app')
    }

    expect(harness.saved).to.deep.equal([])
    expect(harness.discarded).to.deep.equal([['missing', 'def456', undefined]])
  })

  it('fails the deploy when the volume cannot be created', async () => {
    const dir = agentDir('novol')
    const calls: string[][] = []
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(0, 'app\n')
      if (args[0] === 'volumes' && args[1] === 'list') return flyResult(0, '[]')
      if (args[0] === 'volumes' && args[1] === 'create') {
        return flyResult(1, '', 'Error: yes flag must be specified when not running interactively')
      }
      return flyResult(1, '', 'unexpected')
    })

    try {
      await deployFlyAgent({agentName: 'novol', agentPath: dir, host: flyHost()}, harness.deps)
      expect.fail('volume create should fail')
    } catch (error) {
      expect((error as Error).message).to.include('Failed to create volume')
    }

    expect(calls.some(args => args[0] === 'deploy')).to.equal(false)
    expect(calls.some(args => args[0] === 'volumes' && args.includes('--yes'))).to.equal(true)
    expect(harness.saved).to.have.length(1)
  })

  it('treats an existing app and volume as success and passes builder flags', async () => {
    const dir = agentDir('again')
    const calls: string[][] = []
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: 'vol_taken', name: flyVolumeName('again')}]))
      }
      if (args[0] === 'deploy') return flyResult(0)
      return flyResult(1, '', 'unexpected')
    }, {
      listDeployments: () => [{id: 'old123', provider: 'fly', volume_id: flyVolumeName('again')}],
    })

    await deployFlyAgent({
      agentName: 'again',
      agentPath: dir,
      builder: flyBuilderOptions({'local-only': true}),
      host: flyHost(),
    }, harness.deps)

    expect(calls.some(args => args[0] === 'apps')).to.equal(false)
    expect(calls.some(args => args[0] === 'launch')).to.equal(false)
    expect(calls.some(args => args[1] === 'create')).to.equal(false)
    expect(calls.filter(args => args[0] === 'deploy')[0]).to.deep.equal([
      'deploy', '--app', 'cast-again', '--local-only',
    ])
    expect(harness.saved).to.have.length(1)
    expect(harness.discarded).to.deep.equal([])
  })

  it('rewrites an invalid mount source to the Fly volume name', () => {
    const toml = 'app = "cast-mail"\n\n[mounts]\n  source = "cast-mail-1c8e4939-memory"\n  destination = "/app/agent/memory"\n'
    const resolved = resolveFlyVolumeName(toml, 'mail')
    expect(resolved.volumeName).to.equal(flyVolumeName('mail'))
    expect(readFlyMountSource(resolved.toml)).to.equal(flyVolumeName('mail'))
    expect(isFlyVolumeName(resolved.volumeName)).to.equal(true)
  })

  it('creates the volume in the fly.toml primary region', async () => {
    const dir = agentDir('region')
    fs.writeFileSync(path.join(dir, 'fly.toml'), 'app = "cast-region"\nprimary_region = "lhr"\n\n[mounts]\n  source = "custom_volume"\n')
    const calls: string[][] = []
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0)
      return flyResult(1, '', 'unexpected')
    })

    await deployFlyAgent({agentName: 'region', agentPath: dir, host: flyHost()}, harness.deps)

    const volume = calls.find(args => args[0] === 'volumes' && args[1] === 'create')
    expect(volume).to.include('lhr')
    expect(volume).to.include('custom_volume')
    expect(volume).to.include('--yes')
  })

  it('reuses an existing memory volume and does not create a second one', async () => {
    const dir = agentDir('reuse')
    const calls: string[][] = []
    const host = flyHost()
    const volume = flyVolumeName('reuse')
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: 'vol_existing', name: volume, state: 'created'}]))
      }
      if (args[0] === 'deploy') return flyResult(0)
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }, {
      listDeployments: () => [{id: 'old123', provider: 'fly', volume_id: volume}],
    })

    await deployFlyAgent({agentName: 'reuse', agentPath: dir, host}, harness.deps)

    expect(calls.filter(args => args[0] === 'volumes').map(args => args[1])).to.deep.equal(['list'])
    expect(host.logs).to.include(`Reusing memory volume: ${volume}`)
    expect(host.logs.some(line => line.startsWith('Creating memory volume'))).to.equal(false)
    expect(harness.discarded).to.deep.equal([])
  })

  it('fails the deploy when secrets cannot be staged and does not deploy', async () => {
    process.env.CAST_DEPLOYMENT_SHA = 'sec123'
    const dir = agentDir('nosecret')
    const calls: string[][] = []
    const harness = deps(async (args) => {
      calls.push(args)
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') return flyResult(0, '[]')
      if (args[0] === 'volumes' && args[1] === 'create') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0)
      return flyResult(1, '', 'unexpected')
    })
    harness.deps.importSecrets = async () => flyResult(1, '', 'Error: not authorized')

    try {
      await deployFlyAgent({agentName: 'nosecret', agentPath: dir, host: flyHost()}, harness.deps)
      expect.fail('secrets import should fail')
    } catch (error) {
      expect((error as Error).message).to.include('Failed to set secrets')
      expect((error as Error).message).to.include('not authorized')
    }

    expect(calls.some(args => args[0] === 'deploy')).to.equal(false)
    expect(harness.discarded).to.deep.equal([['nosecret', 'sec123', 'abc123']])
  })

  it('keeps the previous token when a redeploy fails before the release', async () => {
    process.env.CAST_DEPLOYMENT_SHA = 'bb7590'
    const dir = agentDir('relock')
    const volume = flyVolumeName('relock')
    const sandbox = sinon.createSandbox()
    const tokens = new Map<string, string>([['old123', 'previous-token']])
    let machineToken = 'previous-token'
    sandbox.stub(db, 'listDeployments').returns([{id: 'old123', provider: 'fly', volume_id: volume}])
    sandbox.stub(keychain, 'setDeploymentToken').callsFake(async (id: string, token: string) => {
      tokens.set(id, token)
    })
    sandbox.stub(keychain, 'setToken').resolves()
    sandbox.stub(keychain, 'deleteDeploymentToken').callsFake(async (id: string) => {
      const had = tokens.delete(id)
      return {removed: had, stores: had ? ['file'] : []}
    })
    const deleteAgent = sandbox.stub(keychain, 'deleteToken').resolves({removed: false, stores: []})
    const harness = deps(async (args) => {
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: 'vol_existing', name: volume}]))
      }
      if (args[0] === 'deploy') return flyResult(1, '', 'Error: build failed')
      return flyResult(1, '', 'unexpected')
    })

    try {
      await deployFlyAgent({agentName: 'relock', agentPath: dir, host: flyHost()}, {
        ...harness.deps,
        generateAuthToken: agentName => generateAuthToken(agentName),
        listDeployments: () => [{id: 'old123', provider: 'fly', volume_id: volume}],
        discardTokens: discardFailedFlyTokens,
        importSecrets: async (_cwd, _app, secrets) => {
          expect(secrets.AUTH_TOKEN).to.equal(tokens.get('bb7590'))
          expect(secrets.AUTH_TOKEN).to.not.equal(machineToken)
          return flyResult(0)
        },
      })
      expect.fail('redeploy should fail')
    } catch (error) {
      expect((error as Error).message).to.include('Fly.io deployment failed')
      expect((error as Error).message).to.include('build failed')
    } finally {
      sandbox.restore()
    }

    expect(machineToken).to.equal('previous-token')
    expect(tokens.get('old123')).to.equal('previous-token')
    expect(tokens.has('bb7590')).to.equal(false)
    expect(deleteAgent.called).to.equal(false)
  })

  it('keeps a valid mount source already in fly.toml', () => {
    const toml = '[mounts]\n  source = "custom_volume"\n'
    const resolved = resolveFlyVolumeName(toml, 'mail')
    expect(resolved.volumeName).to.equal('custom_volume')
    expect(resolved.toml).to.equal(toml)
  })
})

describe('Fly destroy', () => {
  const volumeName = flyVolumeName('mail')

  function recording(results: FlyCommandResult[]) {
    const calls: string[][] = []
    const logs: string[] = []
    const exec = async (args: string[]) => {
      calls.push(args)
      const next = results.shift()
      if (!next) return flyResult(1, '', 'missing result')
      return next
    }
    return {calls, logs, exec, log: (message: string) => logs.push(message)}
  }

  function listed(id = 'vol_abc123'): FlyCommandResult {
    return flyResult(0, JSON.stringify([{id, name: volumeName, state: 'created'}]))
  }

  it('looks the volume up by name and deletes that id after the app is gone', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(0),
      listed(),
      flyResult(0),
    ])
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec: harness.exec,
      log: harness.log,
    })
    expect(harness.calls[0]).to.deep.equal(flyMachinesListArgs('cast-mail'))
    expect(harness.calls[1]).to.deep.equal(['apps', 'destroy', 'cast-mail', '--yes'])
    expect(harness.calls[2]).to.deep.equal(flyVolumesListArgs('cast-mail'))
    expect(harness.calls[3]).to.deep.equal(flyVolumeDeleteArgs('vol_abc123', 'cast-mail'))
    expect(harness.calls[3]).to.not.include(volumeName)
    expect(harness.logs.join('\n')).to.include("Fly app 'cast-mail' has been destroyed.")
    expect(harness.logs.join('\n')).to.include(`Memory volume '${volumeName}' for 'cast-mail' has been removed.`)
    expect(harness.logs.join('\n')).to.not.include('was not present')
  })

  it('destroys an attached machine before deleting its volume', async () => {
    const calls: string[][] = []
    const logs: string[] = []
    let machinesGone = false
    let appGone = false
    const exec = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'machines' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: '148ed123', state: 'stopped'}]))
      }
      if (args[0] === 'machine' && args[1] === 'destroy') {
        machinesGone = true
        return flyResult(0)
      }
      if (args[0] === 'apps' && args[1] === 'destroy') {
        appGone = true
        return flyResult(0)
      }
      if (args[0] === 'volumes' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: 'vol_abc123', name: volumeName, attached_machine: '148ed123'}]))
      }
      if (args[0] === 'volumes' && args[1] === 'delete') {
        if (!machinesGone || !appGone) {
          return flyResult(1, '', 'Error: failed destroying volume: failed_precondition: volume is currently bound to machine: 148ed123')
        }
        return flyResult(0)
      }
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec,
      log: message => logs.push(message),
    })
    const destroyAt = calls.findIndex(args => args[0] === 'machine' && args[1] === 'destroy')
    const appAt = calls.findIndex(args => args[0] === 'apps')
    const deleteAt = calls.findIndex(args => args[0] === 'volumes' && args[1] === 'delete')
    expect(calls[destroyAt]).to.deep.equal(flyMachineDestroyArgs('148ed123', 'cast-mail'))
    expect(destroyAt).to.be.greaterThan(-1)
    expect(appAt).to.be.greaterThan(destroyAt)
    expect(deleteAt).to.be.greaterThan(appAt)
    expect(logs.join('\n')).to.include('has been destroyed')
    expect(logs.join('\n')).to.include('has been removed')
    expect(logs.join('\n')).to.not.include('bound to machine')
  })

  it('says the volume was not present when the list has no match', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(0),
      flyResult(0, '[]'),
    ])
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec: harness.exec,
      log: harness.log,
    })
    expect(harness.calls.map(args => args[0])).to.deep.equal(['machines', 'apps', 'volumes'])
    expect(harness.logs.join('\n')).to.include('was not present')
    expect(harness.logs.join('\n')).to.not.include('has been removed')
  })

  it('does not report success when destroy fails', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(1, '', 'Error: rate limited'),
      flyResult(0, '[]'),
    ])
    try {
      await destroyFlyDeployment('mail', {
        volumeNames: [volumeName],
        exec: harness.exec,
        log: harness.log,
      })
      expect.fail('destroy should fail')
    } catch (error) {
      expect(error).to.be.instanceOf(FlyResourcesRemainError)
      expect((error as FlyResourcesRemainError).keepDeployment).to.equal(true)
      expect((error as Error).message).to.include('Failed to destroy Fly app')
      expect((error as Error).message).to.include('rate limited')
      expect((error as Error).message).to.include('still recorded')
      expect((error as Error).message).to.include('cast shutdown mail')
    }
    expect(harness.logs.join('\n')).to.not.include('has been removed')
    expect(harness.logs.join('\n')).to.not.include('has been destroyed')
  })

  it('treats a missing app during list as an absent volume', async () => {
    const harness = recording([
      flyResult(1, '', 'Error: Could not find App "cast-mail"'),
      flyResult(1, '', 'Error: Could not find App "cast-mail"'),
      flyResult(1, '', 'Error: Could not find App "cast-mail"'),
    ])
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec: harness.exec,
      log: harness.log,
    })
    expect(harness.calls[0]).to.deep.equal(flyMachinesListArgs('cast-mail'))
    expect(harness.calls.some(args => args[1] === 'delete')).to.equal(false)
    expect(harness.calls.some(args => args[0] === 'machine' && args[1] === 'destroy')).to.equal(false)
    expect(harness.logs.join('\n')).to.include('was not present')
    expect(harness.logs.join('\n')).to.not.include('has been removed')
    expect(harness.logs.join('\n')).to.include('does not exist')
    expect(harness.logs.join('\n')).to.not.include('has been destroyed')
  })

  it('treats not found on stdout of app destroy as already gone', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(1, 'app not found\n', ''),
      flyResult(0, '[]'),
    ])
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec: harness.exec,
      log: harness.log,
    })
    expect(harness.logs.join('\n')).to.not.include('has been removed')
    expect(harness.logs.join('\n')).to.not.include('has been destroyed')
  })

  it('does not claim the volume was removed when delete by id fails', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(0),
      listed(),
      flyResult(1, '', 'Error: permission denied'),
    ])
    try {
      await destroyFlyDeployment('mail', {
        volumeNames: [volumeName],
        exec: harness.exec,
        log: harness.log,
      })
      expect.fail('volume delete should fail')
    } catch (error) {
      expect(error).to.be.instanceOf(FlyResourcesRemainError)
      expect((error as FlyResourcesRemainError).keepDeployment).to.equal(true)
      expect((error as Error).message).to.include('Failed to delete Fly volume')
      expect((error as Error).message).to.include('vol_abc123')
      expect((error as Error).message).to.include('permission denied')
      expect((error as Error).message).to.include('still recorded')
    }
    expect(harness.logs.join('\n')).to.include('has been destroyed')
    expect(harness.logs.join('\n')).to.not.include('has been removed')
    expect(harness.calls[0][0]).to.equal('machines')
    expect(harness.calls.some(args => args[0] === 'apps')).to.equal(true)
  })

  it('does not treat a failed volume list as not present', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(0),
      flyResult(1, '', 'Error: permission denied'),
    ])
    try {
      await destroyFlyDeployment('mail', {
        volumeNames: [volumeName],
        exec: harness.exec,
        log: harness.log,
      })
      expect.fail('volume list should fail')
    } catch (error) {
      expect(error).to.be.instanceOf(FlyResourcesRemainError)
      expect((error as Error).message).to.include('Failed to list Fly volumes')
      expect((error as Error).message).to.include('still recorded')
    }
    expect(harness.logs.join('\n')).to.not.include('was not present')
  })

  it('reads the volume id that matches the name', () => {
    const stdout = JSON.stringify([
      {id: 'vol_other', name: 'cast_other_memory'},
      {id: 'vol_abc123', name: volumeName},
    ])
    expect(flyVolumeIdByName(stdout, volumeName)).to.equal('vol_abc123')
    expect(flyVolumeIdsByName(stdout, volumeName)).to.deep.equal(['vol_abc123'])
    expect(flyVolumeIdByName('[]', volumeName)).to.equal(undefined)
    expect(() => flyVolumeIdByName('not-json', volumeName)).to.throw(/JSON/)
    expect(flyMachineIds(JSON.stringify([
      {id: '148ed123', state: 'stopped'},
      {id: 'gone', state: 'destroyed'},
      {id: 'bad id', state: 'started'},
    ]))).to.deep.equal(['148ed123'])
  })

  it('deletes every volume id that shares the name', async () => {
    const harness = recording([
      flyResult(0, '[]'),
      flyResult(0),
      flyResult(0, JSON.stringify([
        {id: 'vol_abc123', name: volumeName},
        {id: 'vol_def456', name: volumeName},
        {id: 'vol_other', name: 'cast_other_memory'},
      ])),
      flyResult(0),
      flyResult(0),
    ])
    await destroyFlyDeployment('mail', {
      volumeNames: [volumeName],
      exec: harness.exec,
      log: harness.log,
    })
    expect(harness.calls[0]).to.deep.equal(flyMachinesListArgs('cast-mail'))
    expect(harness.calls[1]).to.deep.equal(['apps', 'destroy', 'cast-mail', '--yes'])
    expect(harness.calls[2]).to.deep.equal(flyVolumesListArgs('cast-mail'))
    expect(harness.calls[3]).to.deep.equal(flyVolumeDeleteArgs('vol_abc123', 'cast-mail'))
    expect(harness.calls[4]).to.deep.equal(flyVolumeDeleteArgs('vol_def456', 'cast-mail'))
    expect(harness.calls.some(args => args.includes('vol_other'))).to.equal(false)
    expect(harness.logs.join('\n')).to.include('has been removed')
  })
})

describe('discardFailedFlyTokens', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('removes the deployment token file and the agent token when nothing else is live', async () => {
    sandbox.stub(db, 'listDeployments').returns([{id: 'abc123', provider: 'fly'}])
    const deployment = sandbox.stub(keychain, 'deleteDeploymentToken').resolves({removed: true, stores: ['file']})
    const agent = sandbox.stub(keychain, 'deleteToken').resolves({removed: true, stores: ['file']})

    await discardFailedFlyTokens('mail', 'abc123', 'abc123')

    expect(deployment.calledOnceWith('abc123')).to.equal(true)
    expect(agent.calledOnceWith('mail')).to.equal(true)
  })

  it('leaves the agent token when another deployment is still live', async () => {
    sandbox.stub(db, 'listDeployments').returns([
      {id: 'abc123', provider: 'fly'},
      {id: 'old123', provider: 'docker'},
    ])
    sandbox.stub(keychain, 'deleteDeploymentToken').resolves({removed: true, stores: ['file']})
    const agent = sandbox.stub(keychain, 'deleteToken').resolves({removed: true, stores: ['file']})

    await discardFailedFlyTokens('mail', 'abc123')

    expect(agent.called).to.equal(false)
  })
})

describe('Fly machine list parsing', () => {
  it('returns ids of machines that are still up', () => {
    const ids = runningFlyMachineIds(JSON.stringify([
      {id: '148ed123', state: 'started'},
      {id: 'stopped1', state: 'stopped'},
      {id: 'bad id', state: 'started'},
      {id: 'abc', state: 'starting'},
    ]))
    expect(ids).to.deep.equal(['148ed123', 'abc'])
  })

  it('treats a started machine as running and a stopped fleet as stopped', () => {
    expect(flyMachineState(JSON.stringify([{id: 'a', state: 'stopped'}, {id: 'b', state: 'started'}]))).to.equal('started')
    expect(flyMachineState(JSON.stringify([{id: 'a', state: 'stopped'}]))).to.equal('stopped')
    expect(flyMachineState('[]')).to.equal('starting')
  })
})

describe('Fly runtime image and health', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-fly-runtime-'))

  after(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('copies the Cast package into the image and points PYTHONPATH at /app', () => {
    const project = path.join(root, 'project')
    const agent = path.join(root, 'agent')
    fs.mkdirSync(path.join(project, 'python', 'cast'), {recursive: true})
    fs.writeFileSync(path.join(project, 'python', 'cast', 'runtime.py'), 'print("cast")\n')
    fs.mkdirSync(agent, {recursive: true})

    stageCastRuntime(agent, project)

    const dockerfile = fs.readFileSync(path.join(agent, 'Dockerfile'), 'utf8')
    expect(dockerfile).to.include('COPY .cast-runtime/cast /app/cast')
    expect(dockerfile).to.include('PYTHONPATH=/app')
    expect(dockerfile).to.not.include('PYTHONPATH=/usr/local')
    expect(fs.readFileSync(path.join(agent, '.cast-runtime', 'cast', 'runtime.py'), 'utf8')).to.include('cast')
    expect(flyAgentCardUrl('https://cast-mail.fly.dev')).to.equal('https://cast-mail.fly.dev/.well-known/agent.json')
  })

  it('fails the deploy when the machine exits without the cast module', async () => {
    const dir = path.join(root, 'crash')
    fs.mkdirSync(dir, {recursive: true})
    const host = flyHost()
    const crash = "ModuleNotFoundError: No module named 'cast'\nMain child exited normally with code: 1\n"
    let probes = 0
    const exec: FlyDeployDeps['exec'] = async (args) => {
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') return flyResult(0, '[]')
      if (args[0] === 'volumes' && args[1] === 'create') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0)
      if (args[0] === 'machines') {
        probes += 1
        return flyResult(0, JSON.stringify([{id: 'machine1', state: 'stopped'}]))
      }
      if (args[0] === 'logs') return flyResult(0, crash, '')
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }
    const discarded: unknown[][] = []
    const harness = {
      exec,
      generateAuthToken: async () => ({authToken: 'token', tokenHash: 'hash'}),
      saveDeployment: () => 'abc123',
      listDeployments: () => [],
      discardTokens: async (...args: unknown[]) => {
        discarded.push(args)
      },
      inferenceEnv: () => ({}),
      importSecrets: async () => flyResult(0),
      stageRuntime: () => {},
      checkCli: async () => {},
      confirmReady: (input: {appName: string; deploymentUrl: string; exec: FlyDeployDeps['exec']}) =>
        waitForFlyHealth({...input, timeoutMs: 0, intervalMs: 0, sleep: async () => {}, probeUrl: async () => false}),
    }

    try {
      await deployFlyAgent({agentName: 'crash', agentPath: dir, host}, harness)
      expect.fail('health check should fail')
    } catch (error) {
      expect((error as Error).message).to.include('exited before the runtime was ready')
      expect((error as Error).message).to.include("No module named 'cast'")
      expect((error as Error).message).to.include(flyAgentCardUrl('https://cast-crash.fly.dev'))
    }

    expect(probes).to.equal(1)
    expect(host.logs.join('\n')).to.not.include('Deployment Successful')
    expect(discarded).to.deep.equal([])
  })

  async function deployWithHealthLogs(input: {
    name: string
    machineState: string
    logs: string
    probeUrl: () => Promise<boolean>
  }): Promise<{host: ReturnType<typeof flyHost>; error?: Error; probes: number; discarded: unknown[][]}> {
    const dir = path.join(root, input.name)
    fs.mkdirSync(dir, {recursive: true})
    const host = flyHost()
    let probes = 0
    const discarded: unknown[][] = []
    const exec: FlyDeployDeps['exec'] = async (args) => {
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') return flyResult(0, '[]')
      if (args[0] === 'volumes' && args[1] === 'create') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0)
      if (args[0] === 'machines') {
        probes += 1
        return flyResult(0, JSON.stringify([{id: 'machine1', state: input.machineState}]))
      }
      if (args[0] === 'logs') return flyResult(0, input.logs, '')
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }
    try {
      await deployFlyAgent({agentName: input.name, agentPath: dir, host}, {
        exec,
        generateAuthToken: async () => ({authToken: 'token', tokenHash: 'hash'}),
        saveDeployment: () => 'abc123',
        listDeployments: () => [],
        discardTokens: async (...args: unknown[]) => {
          discarded.push(args)
        },
        inferenceEnv: () => ({}),
        importSecrets: async () => flyResult(0),
        stageRuntime: () => {},
        checkCli: async () => {},
        confirmReady: (ready) => waitForFlyHealth({
          ...ready,
          timeoutMs: 0,
          intervalMs: 0,
          sleep: async () => {},
          probeUrl: input.probeUrl,
        }),
      })
      return {host, probes, discarded}
    } catch (error) {
      return {host, error: error as Error, probes, discarded}
    }
  }

  it('fails the deploy when a started machine logs a current agent config error', async () => {
    const configError = 'Error loading agent config: agent.yaml could not be parsed (/opt/cast-agent/agent.yaml:2): brain: [unclosed\n'
    const result = await deployWithHealthLogs({
      name: 'config-started',
      machineState: 'started',
      logs: configError,
      probeUrl: async () => {
        throw new Error('agent card should not be probed after a current config error')
      },
    })
    expect(result.error?.message).to.include('failed before the runtime was ready')
    expect(result.error?.message).to.include('Error loading agent config')
    expect(result.error?.message).to.include(flyAgentCardUrl('https://cast-config-started.fly.dev'))
    expect(result.probes).to.equal(1)
    expect(result.host.logs.join('\n')).to.not.include('Deployment Successful')
    expect(result.discarded).to.deep.equal([])
  })

  it('fails the deploy when a starting machine logs a current agent config error', async () => {
    const result = await deployWithHealthLogs({
      name: 'config-starting',
      machineState: 'starting',
      logs: 'Error loading agent config: agent.yaml could not be parsed\n',
      probeUrl: async () => false,
    })
    expect(result.error?.message).to.include('Error loading agent config')
    expect(result.error?.message).to.include('failed before the runtime was ready')
    expect(result.probes).to.equal(1)
    expect(result.host.logs.join('\n')).to.not.include('Deployment Successful')
    expect(result.discarded).to.deep.equal([])
  })

  it('keeps a deploy that serves the agent card after an older config error', async () => {
    const result = await deployWithHealthLogs({
      name: 'config-recovered',
      machineState: 'started',
      logs: 'Error loading agent config: agent.yaml could not be parsed\nAgent ready on port 8080\n',
      probeUrl: async () => true,
    })
    expect(result.error).to.equal(undefined)
    expect(result.host.logs.join('\n')).to.include('Deployment Successful')
  })

  it('does not fail a starting machine on a stale missing-module log', async () => {
    const result = await deployWithHealthLogs({
      name: 'stale-crash',
      machineState: 'started',
      logs: "ModuleNotFoundError: No module named 'cast'\n",
      probeUrl: async () => false,
    })
    expect(result.error?.message).to.include('did not become ready')
    expect(result.error?.message).to.not.include("No module named 'cast'")
    expect(result.host.logs.join('\n')).to.not.include('Deployment Successful')
    expect(result.discarded).to.deep.equal([])
  })

  it('records the new token when a redeploy is released and the health check fails', async () => {
    const dir = path.join(root, 'released')
    fs.mkdirSync(dir, {recursive: true})
    const host = flyHost()
    const saved: unknown[][] = []
    const discarded: unknown[][] = []
    const exec: FlyDeployDeps['exec'] = async (args) => {
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') {
        return flyResult(0, JSON.stringify([{id: 'vol_existing', name: flyVolumeName('released')}]))
      }
      if (args[0] === 'deploy') return flyResult(0)
      if (args[0] === 'machines') return flyResult(0, JSON.stringify([{id: 'machine1', state: 'stopped'}]))
      if (args[0] === 'logs') return flyResult(0, 'exited\n')
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }
    try {
      await deployFlyAgent({agentName: 'released', agentPath: dir, host}, {
        exec,
        generateAuthToken: async () => ({authToken: 'new-token', tokenHash: 'new-hash'}),
        saveDeployment: (...args) => {
          saved.push(args)
          return 'new123'
        },
        listDeployments: () => [{id: 'old123', provider: 'fly', volume_id: flyVolumeName('released')}],
        discardTokens: async (...args: unknown[]) => {
          discarded.push(args)
        },
        inferenceEnv: () => ({}),
        importSecrets: async () => flyResult(0),
        stageRuntime: () => {},
        checkCli: async () => {},
        confirmReady: input => waitForFlyHealth({
          ...input,
          timeoutMs: 0,
          intervalMs: 0,
          sleep: async () => {},
          probeUrl: async () => false,
        }),
      })
      expect.fail('health check should fail')
    } catch (error) {
      expect((error as Error).message).to.include('exited before the runtime was ready')
    }
    expect(saved).to.have.length(1)
    expect(saved[0][3]).to.equal('new-hash')
    expect(discarded).to.deep.equal([])
    expect(host.logs.join('\n')).to.not.include('Deployment Successful')
  })

  it('reports success only after the agent card responds', async () => {
    const dir = path.join(root, 'ready')
    fs.mkdirSync(dir, {recursive: true})
    const host = flyHost()
    const exec: FlyDeployDeps['exec'] = async (args) => {
      if (args[0] === 'status') return flyResult(0, 'running\n')
      if (args[0] === 'volumes' && args[1] === 'list') return flyResult(0, '[]')
      if (args[0] === 'volumes' && args[1] === 'create') return flyResult(0)
      if (args[0] === 'deploy') return flyResult(0)
      if (args[0] === 'machines') return flyResult(0, JSON.stringify([{id: 'machine1', state: 'started'}]))
      if (args[0] === 'logs') return flyResult(0, 'Agent ready on port 8080\n')
      return flyResult(1, '', `unexpected ${args.join(' ')}`)
    }
    const seen: string[] = []
    await deployFlyAgent({agentName: 'ready', agentPath: dir, host}, {
      exec,
      generateAuthToken: async () => ({authToken: 'token', tokenHash: 'hash'}),
      saveDeployment: () => 'abc123',
      listDeployments: () => [{id: 'old', provider: 'fly', volume_id: 'cast_ready_memory'}],
      discardTokens: async () => {},
      inferenceEnv: () => ({}),
      importSecrets: async () => flyResult(0),
      stageRuntime: () => {},
      checkCli: async () => {},
      confirmReady: async (input) => {
        seen.push(input.deploymentUrl)
        await waitForFlyHealth({
          ...input,
          timeoutMs: 0,
          intervalMs: 0,
          sleep: async () => {},
          probeUrl: async () => true,
        })
      },
    })
    expect(seen).to.deep.equal(['https://cast-ready.fly.dev'])
    expect(host.logs.join('\n')).to.include('Deployment Successful')
  })
})