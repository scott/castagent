import {expect} from 'chai'
import {createRequire} from 'module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import * as tar from 'tar'

const nodeRequire = createRequire(__filename)
const childProcess = nodeRequire('child_process') as typeof import('child_process')

import DeployCommand from '../../../../typescript/cast-cli/src/commands/deploy'
import {microvmProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/microvm'
import MicrovmDeploy from '../../../../typescript/cast-cli/src/lib/deploy/microvm'
import {
  upgradeDigitalOceanDeployment,
  upgradeFlyDeployment,
  upgradeRailwayDeployment,
  upgradeSpritesDeployment,
} from '../../../../typescript/cast-cli/src/lib/deploy/upgrades'

const PROVIDERS = ['fly', 'railway', 'sprites', 'digitalocean', 'microvm'] as const

function oclifError(message: string): never {
  const error = new Error(message) as Error & {oclif: {exit: number}}
  error.oclif = {exit: 1}
  throw error
}

describe('ollama remote deploy refusal', () => {
  let home: string
  let sandbox: sinon.SinonSandbox
  const previousHome = process.env.HOME
  const remoteCalls: string[] = []

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ollama-remote-'))
    process.env.HOME = home
    remoteCalls.length = 0
    const note = (command: unknown) => {
      const name = String(command)
      if (name.includes('python')) return
      remoteCalls.push(name)
    }
    sandbox.stub(childProcess, 'spawn').callsFake((command: string) => {
      note(command)
      throw new Error(`remote spawn ${command}`)
    })
    sandbox.stub(childProcess, 'execFile').callsFake((command: string) => {
      note(command)
      throw new Error(`remote execFile ${command}`)
    })
    sandbox.stub(globalThis, 'fetch').callsFake((async () => {
      remoteCalls.push('fetch')
      throw new Error('remote fetch')
    }) as typeof fetch)
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(home, {recursive: true, force: true})
  })

  function host() {
    return {
      log() {},
      warn() {},
      error(message: string): never {
        throw new Error(message)
      },
    }
  }

  async function writeReleaseTarball(model: string): Promise<string> {
    const src = path.join(home, 'release-src')
    fs.mkdirSync(src, {recursive: true})
    fs.writeFileSync(path.join(src, 'agent.yaml'), `brain:\n  model: ${model}\n`)
    fs.writeFileSync(path.join(src, 'from-release.txt'), 'extracted\n')
    const tarball = path.join(home, 'release.tar.gz')
    await tar.c({gzip: true, file: tarball, cwd: src}, ['agent.yaml', 'from-release.txt'])
    return tarball
  }

  function writeAgent(agentName: string, model: string): string {
    const agent = path.join(home, '.cast', 'agents', agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), `name: ${agentName}\nbrain:\n  model: ${model}\n`)
    fs.writeFileSync(path.join(agent, 'keep.txt'), 'working\n')
    return agent
  }

  function assertUntouched(agent: string): void {
    expect(fs.readFileSync(path.join(agent, 'keep.txt'), 'utf8')).to.equal('working\n')
    expect(fs.existsSync(path.join(agent, 'from-release.txt'))).to.equal(false)
    expect(remoteCalls).to.deep.equal([])
  }

  for (const provider of PROVIDERS) {
    it(`cast deploy --provider ${provider} refuses ollama/ before any remote call`, async () => {
      const agentName = `ollama-${provider}`
      const agent = writeAgent(agentName, 'ollama/qwen3')
      const instance = new DeployCommand(['deploy', agentName, '--provider', provider, '--force'], {} as any)
      ;(instance as any).config = {
        runHook: async () => ({successes: [], failures: []}),
        name: 'deploy',
        bin: 'cast',
      }
      ;(instance as any).parse = async () => ({
        args: {agent: agentName},
        flags: {provider, version: 'latest', force: true, port: 8080, 'with-tui': false},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })
      instance.log = () => {}
      instance.error = ((message: string) => oclifError(message)) as typeof instance.error

      let caught: Error | undefined
      try {
        await instance.run()
      } catch (error) {
        caught = error as Error
      }
      expect(caught, 'deploy resolved').to.be.instanceOf(Error)
      expect(caught!.message).to.include(`Refusing to deploy ollama/qwen3 to ${provider}`)
      expect(caught!.message).to.include('OLLAMA_API_KEY')
      expect(caught!.message).to.not.include('from-release')
      assertUntouched(agent)
    })
  }

  for (const provider of ['fly', 'railway', 'sprites', 'digitalocean'] as const) {
    it(`upgrade ${provider} refuses the release model and leaves the agent tree`, async () => {
      const agentName = `upgrade-${provider}`
      const agent = writeAgent(agentName, 'openrouter/minimax/minimax-m2.5')
      const tarball = await writeReleaseTarball('ollama/llama3.1')
      const upgrade = {
        fly: upgradeFlyDeployment,
        railway: upgradeRailwayDeployment,
        sprites: upgradeSpritesDeployment,
        digitalocean: upgradeDigitalOceanDeployment,
      }[provider]
      let caught: Error | undefined
      try {
        await upgrade(host(), agentName, '1.2.0', tarball)
      } catch (error) {
        caught = error as Error
      }
      expect(caught, 'upgrade resolved').to.be.instanceOf(Error)
      expect(caught!.message).to.include(`Refusing to deploy ollama/llama3.1 to ${provider}`)
      expect(fs.readFileSync(path.join(agent, 'agent.yaml'), 'utf8')).to.include('openrouter/minimax/minimax-m2.5')
      assertUntouched(agent)
    })
  }

  it('microvm upgrade refuses before extract and before a remote call', async () => {
    const agentName = 'upgrade-microvm'
    const agent = writeAgent(agentName, 'openrouter/minimax/minimax-m2.5')
    const tarball = await writeReleaseTarball('ollama/qwen3')
    let caught: Error | undefined
    try {
      await microvmProvider.upgrade!({
        agentName,
        agentPath: agent,
        version: '1.2.0',
        versionTarballPath: tarball,
        deployment: {id: 'dep', volume_config: '{}'},
        log() {},
        warn() {},
        error: (message: string): never => {
          throw new Error(message)
        },
      } as any)
    } catch (error) {
      caught = error as Error
    }
    expect(caught, 'provider upgrade resolved').to.be.instanceOf(Error)
    expect(caught!.message).to.include('Refusing to deploy ollama/qwen3 to microvm')
    assertUntouched(agent)

    writeAgent(agentName, 'ollama/qwen3')
    let direct: Error | undefined
    try {
      await MicrovmDeploy.upgrade(agentName, {id: 'dep', volume_config: '{}'}, () => {})
    } catch (error) {
      direct = error as Error
    }
    expect(direct, 'MicrovmDeploy.upgrade resolved').to.be.instanceOf(Error)
    expect(direct!.message).to.include('Refusing to deploy ollama/qwen3 to microvm')
    expect(remoteCalls).to.deep.equal([])
    expect(fs.readFileSync(path.join(agent, 'keep.txt'), 'utf8')).to.equal('working\n')
  })
})
