import {expect} from 'chai'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import Deploy from '../../../typescript/cast-cli/src/commands/deploy'
import Update from '../../../typescript/cast-cli/src/commands/update'
import Upgrade from '../../../typescript/cast-cli/src/commands/upgrade'
import {missingAgentError} from '../../../typescript/cast-cli/src/lib/missing-agent'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

function captureError(instance: {error: (message: string) => never}): string[] {
  const messages: string[] = []
  sinon.stub(instance, 'error').callsFake((message: string) => {
    messages.push(message)
    throw new Error('stopped')
  })
  return messages
}

describe('missing agent errors', () => {
  const sandbox = sinon.createSandbox()

  afterEach(() => {
    sandbox.restore()
  })

  it('tells the user to run cast new', () => {
    const agentPath = path.join(os.homedir(), '.cast', 'agents', 'nosuch')
    const message = missingAgentError('nosuch', agentPath)
    expect(message).to.include(`Agent 'nosuch' not found at ${agentPath}`)
    expect(message).to.include('Create the agent first with: cast new')
    expect(message).to.not.include('cast dev')
    expect(message).to.not.include('--no-tui')
  })

  it('cast update suggests cast new for a missing agent', async () => {
    const agentName = 'nosuch-update-agent'
    const instance = new Update(['update', agentName, '--description', 'x'], {} as any)
    ;(instance as any).parse = async () => ({
      args: {agent: agentName},
      flags: {description: 'x'},
      argv: [agentName],
      raw: [],
      metadata: {},
      nonExistentFlags: [],
    })
    const messages = captureError(instance)

    try {
      await instance.run()
      expect.fail('update should reject a missing agent')
    } catch (err: any) {
      expect(err.message).to.equal('stopped')
    }

    expect(messages).to.have.length(1)
    expect(messages[0]).to.include('Create the agent first with: cast new')
    expect(messages[0]).to.not.include('cast dev')
  })

  it('cast deploy suggests cast new for a missing agent', async () => {
    const agentName = 'nosuch-deploy-agent'
    const instance = new Deploy(['deploy', agentName], {} as any)
    ;(instance as any).parse = async () => ({
      args: {agent: agentName},
      flags: {},
      argv: [agentName],
      raw: [],
      metadata: {},
      nonExistentFlags: [],
    })
    const messages = captureError(instance)

    try {
      await instance.run()
      expect.fail('deploy should reject a missing agent')
    } catch (err: any) {
      expect(err.message).to.equal('stopped')
    }

    expect(messages).to.have.length(1)
    expect(messages[0]).to.include('Create the agent first with: cast new')
    expect(messages[0]).to.not.include('cast dev')
  })

  it('cast upgrade suggests cast new when the deployed agent directory is missing', async () => {
    const agentName = 'nosuch-upgrade-agent'
    const instance = new Upgrade(['upgrade', agentName], {} as any)
    ;(instance as any).parse = async () => ({
      args: {agent: agentName},
      flags: {},
      argv: [agentName],
      raw: [],
      metadata: {},
      nonExistentFlags: [],
    })
    sandbox.stub(db, 'listDeployments').returns([{
      id: 'abc123',
      agent_name: agentName,
      provider: 'docker',
      deployment_url: 'http://127.0.0.1:1',
    }])
    const messages = captureError(instance)

    try {
      await instance.run()
      expect.fail('upgrade should reject a missing agent directory')
    } catch (err: any) {
      expect(err.message).to.equal('stopped')
    }

    expect(messages).to.have.length(1)
    expect(messages[0]).to.include('Create the agent first with: cast new')
    expect(messages[0]).to.not.include('cast dev')
  })
})
