import {expect} from 'chai'
import {EventEmitter} from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import * as containerHealth from '../../../../typescript/cast-cli/src/lib/deploy/container-health'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as docker from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import {upgradeDockerDeployment} from '../../../../typescript/cast-cli/src/lib/deploy/upgrades'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'

describe('upgrade keychain token', () => {
  let home: string
  let sandbox: sinon.SinonSandbox
  const previousHome = process.env.HOME
  const previousDo = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-upgrade-key-'))
    process.env.HOME = home
    delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    delete process.env.OPENROUTER_API_KEY
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDo === undefined) delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    else process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = previousDo
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('passes a keychain-only token to the upgraded container', async () => {
    const agentName = 'keychain-upgrade-agent'
    const agent = path.join(home, '.cast', 'agents', agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'brain:\n  model: digitalocean/llama3.3-70b-instruct\n')
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
  })
})
