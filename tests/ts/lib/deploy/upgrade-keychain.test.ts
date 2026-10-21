import {expect} from 'chai'
import {EventEmitter} from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import * as containerHealth from '../../../../typescript/cast-cli/src/lib/deploy/container-health'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as docker from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import {
  upgradeDockerDeployment,
  upgradeFlyDeployment,
  upgradeRailwayDeployment,
} from '../../../../typescript/cast-cli/src/lib/deploy/upgrades'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'

describe('upgrade keychain token', () => {
  let home: string
  let sandbox: sinon.SinonSandbox
  const previousHome = process.env.HOME
  const previousDo = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
  const previousDoBase = process.env.DIGITALOCEAN_INFERENCE_BASE_URL
  const previousOpenRouterBase = process.env.OPENROUTER_BASE_URL

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-upgrade-key-'))
    process.env.HOME = home
    delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
    delete process.env.OPENROUTER_BASE_URL
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDo === undefined) delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    else process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = previousDo
    if (previousDoBase === undefined) delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
    else process.env.DIGITALOCEAN_INFERENCE_BASE_URL = previousDoBase
    if (previousOpenRouterBase === undefined) delete process.env.OPENROUTER_BASE_URL
    else process.env.OPENROUTER_BASE_URL = previousOpenRouterBase
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('passes a keychain-only token to the upgraded container', async () => {
    const agentName = 'keychain-upgrade-agent'
    const agent = path.join(home, '.cast', 'agents', agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'brain:\n  model: digitalocean/llama3.3-70b-instruct\n')
    fs.mkdirSync(path.join(home, '.cast'), {recursive: true})
    fs.writeFileSync(path.join(home, '.cast', 'config.yaml'), [
      'providers:',
      '  digitalocean_inference:',
      '    base_url: https://inference.example/v1',
      '',
    ].join('\n'))
    process.env.DIGITALOCEAN_INFERENCE_BASE_URL = 'https://inference.example/v1'
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/v1'
    await keychain.setInferenceToken('digitalocean', 'do-upgrade-secret')

    let captured = ''
    sandbox.stub(deployUtils, 'execCommand').resolves({exitCode: 0, stdout: '', stderr: ''})
    sandbox.stub(docker, 'startDockerAgentContainer').callsFake(async (_args, env) => {
      captured = JSON.stringify(env)
      return 0
    })
    sandbox.stub(containerHealth, 'waitForContainerHealth').resolves({ok: true})
    sandbox.stub(require('child_process'), 'spawn').callsFake(() => {
      const proc = new EventEmitter()
      setImmediate(() => proc.emit('exit', 0))
      return proc
    })

    await upgradeDockerDeployment({
      log() {},
      warn() {},
      error(message: string): never {
        throw new Error(message)
      },
    }, agentName, '1.0.0', null)

    expect(captured).to.include('DIGITALOCEAN_MODEL_ACCESS_KEY')
    expect(captured).to.include('do-upgrade-secret')
    expect(captured).to.not.include('OPENROUTER_API_KEY')
    expect(captured).to.not.include('BASE_URL')
    expect(captured).to.not.include('https://inference.example')
    expect(captured).to.not.include('https://openrouter.example')
  })

  it('does not set Railway variables or Fly secrets on upgrade', async () => {
    const agentName = 'hosted-upgrade-agent'
    const agent = path.join(home, '.cast', 'agents', agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'brain:\n  model: digitalocean/llama3.3-70b-instruct\n')
    process.env.DIGITALOCEAN_INFERENCE_BASE_URL = 'https://inference.example/v1'
    await keychain.setInferenceToken('digitalocean', 'do-upgrade-secret')

    const commands: string[] = []
    const record = (args: unknown[]) => {
      const command = String(args[0])
      const argv = Array.isArray(args[1]) ? args[1].map(String) : []
      commands.push([command, ...argv].join(' '))
    }
    sandbox.stub(deployUtils, 'execCommand').callsFake(async (...args: unknown[]) => {
      record(args)
      return {exitCode: 0, stdout: '', stderr: ''}
    })
    sandbox.stub(require('child_process'), 'spawn').callsFake((...args: unknown[]) => {
      record(args)
      const proc = new EventEmitter()
      setImmediate(() => proc.emit('exit', 0))
      return proc
    })

    const host = {
      log() {},
      warn() {},
      error(message: string): never {
        throw new Error(message)
      },
    }
    await upgradeRailwayDeployment(host, agentName, '1.0.0', null)
    await upgradeFlyDeployment(host, agentName, '1.0.0', null)

    const joined = commands.join('\n')
    expect(joined).to.include('railway up --detach')
    expect(joined).to.include('flyctl deploy --detach')
    expect(joined).to.not.include('variables')
    expect(joined).to.not.include('secrets')
    expect(joined).to.not.include('do-upgrade-secret')
    expect(joined).to.not.include('BASE_URL')
    expect(joined).to.not.include('https://inference.example')
  })
})
