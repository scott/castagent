import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import Logs from '../../../typescript/cast-cli/src/commands/logs'
import * as deployUtils from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

const CRASH = 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'git\'\n'

function command(agent: string): Logs {
  const instance = new Logs(['logs', agent], {color: false} as any) as any
  instance.parse = async () => ({args: {agent}, flags: {}, argv: [agent], raw: []})
  instance.error = (message?: string) => {
    throw new Error(message ?? '')
  }
  return instance
}

async function printed(agent: string): Promise<string> {
  const chunks: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await command(agent).run()
  } finally {
    process.stdout.write = write
  }
  return chunks.join('')
}

describe('logs command', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('describes the agent argument', () => {
    expect(Logs.description).to.equal('Print local runtime logs, Docker container logs, or Sprites service logs')
    expect(Logs.args.agent.required).to.equal(true)
    expect(Logs.args.agent.description).to.equal('Agent name or deployment SHA')
  })

  it('prints a Docker crash instead of a placeholder line', async () => {
    sandbox.stub(db, 'listDeployments').returns([{
      id: 'abc123',
      agent_name: 'bb2-chat',
      provider: 'docker',
      deployment_url: 'http://localhost:8080',
    }])
    const exec = sandbox.stub(deployUtils, 'execCommand').resolves({
      stdout: '',
      stderr: CRASH,
      exitCode: 0,
    })

    const output = await printed('bb2-chat')

    expect(output).to.equal(CRASH)
    expect(output).to.not.include('Viewing logs')
    expect(exec.calledOnce).to.equal(true)
    expect(exec.firstCall.args[0]).to.equal('docker')
    expect(exec.firstCall.args[1]).to.deep.equal(['logs', 'cast-bb2-chat'])
    expect(exec.firstCall.args[2]).to.include({silent: true, shell: false})
  })

  it('prints a saved local crash and does not call docker', async () => {
    const agent = `test-logs-local-${Date.now()}`
    const logFile = path.join(os.homedir(), '.cast', 'logs', `${agent}.log`)
    fs.mkdirSync(path.dirname(logFile), {recursive: true})
    fs.writeFileSync(logFile, CRASH)
    const exec = sandbox.stub(deployUtils, 'execCommand').rejects(new Error('docker should not be called'))

    try {
      const output = await printed(agent)
      expect(output).to.equal(CRASH)
      expect(output).to.not.include('Viewing logs')
      expect(exec.called).to.equal(false)
    } finally {
      fs.rmSync(logFile, {force: true})
    }
  })

  it('fails with an accurate message when a local agent has no log file', async () => {
    const agent = `test-logs-missing-${Date.now()}`
    sandbox.stub(deployUtils, 'execCommand').rejects(new Error('docker should not be called'))

    try {
      await printed(agent)
      expect.fail('missing logs should fail')
    } catch (error) {
      const message = (error as Error).message
      expect(message).to.include(`No local runtime logs for '${agent}'`)
      expect(message).to.not.include('Viewing logs')
    }
  })
})
