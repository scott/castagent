import {expect} from 'chai'
import {EventEmitter} from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  attachRuntimeLog,
  collectRuntimeLogs,
  dockerContainerName,
  joinProcessOutput,
  readLocalRuntimeLog,
  type RuntimeDeployment,
  type RuntimeLogDeps,
} from '../../../typescript/cast-cli/src/lib/runtime-logs'

const CRASH = 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'git\'\n'

function deployment(overrides: Partial<RuntimeDeployment> = {}): RuntimeDeployment {
  return {
    id: 'abc123',
    agent_name: 'bb2-chat',
    provider: 'docker',
    deployment_url: 'http://localhost:8080',
    ...overrides,
  }
}

function deps(overrides: Partial<RuntimeLogDeps> = {}): RuntimeLogDeps {
  return {
    getDeploymentBySha: () => null,
    listDeployments: () => [],
    readLocalLog: () => null,
    dockerLogs: async () => ({stdout: '', stderr: '', exitCode: 0}),
    flyLogs: async () => ({stdout: '', stderr: '', exitCode: 0}),
    ...overrides,
  }
}

describe('runtime logs', () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-logs-'))

  after(() => {
    fs.rmSync(logsDir, {recursive: true, force: true})
  })

  it('names the Docker container cast-<agent>', () => {
    expect(dockerContainerName('bb2-chat')).to.equal('cast-bb2-chat')
  })

  it('joins stdout and stderr without dropping a crash', () => {
    expect(joinProcessOutput('Agent ready on port 8080\n', CRASH)).to.equal(
      `Agent ready on port 8080\n${CRASH}`,
    )
    expect(joinProcessOutput('', CRASH)).to.equal(CRASH)
  })

  it('prints a Docker container crash from stderr', async () => {
    const calls: string[][] = []
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment()],
      dockerLogs: async (container) => {
        calls.push([container])
        return {stdout: '', stderr: CRASH, exitCode: 0}
      },
    }))

    expect(result.status).to.equal('ok')
    expect(result.text).to.equal(CRASH)
    expect(calls).to.deep.equal([['cast-bb2-chat']])
  })

  it('prefers Docker logs over a saved local file', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment()],
      readLocalLog: () => 'local only\n',
      dockerLogs: async () => ({stdout: '', stderr: CRASH, exitCode: 0}),
    }))

    expect(result.status).to.equal('ok')
    expect(result.text).to.equal(CRASH)
    expect(result.text).to.not.include('local only')
  })

  it('uses the latest row when Docker was redeployed to the same URL', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [
        deployment({id: 'bbbbbb'}),
        deployment({id: 'aaaaaa'}),
      ],
      dockerLogs: async () => ({stdout: '', stderr: CRASH, exitCode: 0}),
    }))

    expect(result).to.deep.equal({status: 'ok', text: CRASH})
  })

  it('prints Docker logs for a deployment SHA', async () => {
    const result = await collectRuntimeLogs('abc123', deps({
      getDeploymentBySha: (id) => id === 'abc123' ? deployment() : null,
      dockerLogs: async (container) => {
        expect(container).to.equal('cast-bb2-chat')
        return {stdout: '', stderr: CRASH, exitCode: 0}
      },
    }))

    expect(result.text).to.equal(CRASH)
  })

  it('reports a missing Docker container', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment()],
      dockerLogs: async () => ({
        stdout: '',
        stderr: 'Error: No such container: cast-bb2-chat\n',
        exitCode: 1,
      }),
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include('No such container: cast-bb2-chat')
    expect(result.text).to.not.include('Viewing logs')
  })

  it('reports when the docker CLI cannot be started', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment()],
      dockerLogs: async () => {
        throw new Error('spawn docker ENOENT')
      },
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include('spawn docker ENOENT')
  })

  it('says when a Docker container has no output', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment()],
    }))

    expect(result).to.deep.equal({
      status: 'ok',
      text: "No log output for Docker container 'cast-bb2-chat'.",
    })
  })

  it('prints a Sprites service log', async () => {
    const calls: string[][] = []
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment({
        provider: 'sprites',
        deployment_url: 'https://cast-bb2-chat.sprites.app',
      })],
      spriteLogs: async (spriteName) => {
        calls.push([spriteName])
        return {stdout: 'Agent ready on port 8080\n', stderr: '', exitCode: 0}
      },
    }))

    expect(result).to.deep.equal({status: 'ok', text: 'Agent ready on port 8080\n'})
    expect(calls).to.deep.equal([['cast-bb2-chat']])
  })

  it('names the sprite service log when cat fails', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment({
        provider: 'sprites',
        deployment_url: 'https://cast-bb2-chat.sprites.app',
      })],
      spriteLogs: async () => ({
        stdout: '',
        stderr: 'cat: /.sprite/logs/services/cast-agent.log: No such file or directory\n',
        exitCode: 1,
      }),
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include('/.sprite/logs/services/cast-agent.log')
    expect(result.text).to.not.include('/opt/cast-agent/agent.log')
  })

  it('prints Fly.io logs for a Fly deployment', async () => {
    const calls: string[][] = []
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment({
        provider: 'fly',
        deployment_url: 'https://cast-bb2-chat.fly.dev',
      })],
      flyLogs: async (appName) => {
        calls.push([appName])
        return {stdout: 'machine started\n', stderr: '', exitCode: 0}
      },
    }))

    expect(result.status).to.equal('ok')
    expect(result.text).to.equal('machine started\n')
    expect(calls).to.deep.equal([['cast-bb2-chat']])
  })

  it('reports a Fly logs failure', async () => {
    const result = await collectRuntimeLogs('abc123', deps({
      getDeploymentBySha: () => deployment({
        provider: 'fly',
        deployment_url: 'https://cast-bb2-chat.fly.dev',
      }),
      flyLogs: async () => ({
        stdout: '',
        stderr: 'Error: app not found\n',
        exitCode: 1,
      }),
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include("Fly.io logs for app 'cast-bb2-chat'")
    expect(result.text).to.include('app not found')
  })

  it('refuses providers it cannot read', async () => {
    let dockerCalled = false
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [deployment({provider: 'railway', deployment_url: 'https://example.up.railway.app'})],
      dockerLogs: async () => {
        dockerCalled = true
        return {stdout: '', stderr: '', exitCode: 0}
      },
    }))

    expect(dockerCalled).to.equal(false)
    expect(result.status).to.equal('error')
    expect(result.text).to.include('railway')
    expect(result.text).to.include('Docker container logs')
  })

  it('asks for a SHA when live deployments differ', async () => {
    const result = await collectRuntimeLogs('bb2-chat', deps({
      listDeployments: () => [
        deployment({id: 'abc123', deployment_url: 'http://localhost:8080'}),
        deployment({id: 'def456', provider: 'fly', deployment_url: 'https://cast-bb2-chat.fly.dev'}),
      ],
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include('abc123')
    expect(result.text).to.include('def456')
  })

  it('prints a saved local crash when nothing is deployed', async () => {
    const result = await collectRuntimeLogs('email-assistant', deps({
      readLocalLog: () => CRASH,
    }))

    expect(result).to.deep.equal({status: 'ok', text: CRASH})
  })

  it('tells the user when a local run has not recorded logs', async () => {
    const result = await collectRuntimeLogs('email-assistant', deps())

    expect(result.status).to.equal('error')
    expect(result.text).to.include('No local runtime logs')
    expect(result.text).to.include('cast dev')
    expect(result.text).to.not.include('Viewing logs')
  })

  it('reads a six-character agent name as a local agent when it is not a SHA', async () => {
    const result = await collectRuntimeLogs('abc123', deps({
      getDeploymentBySha: () => null,
      listDeployments: () => [],
      readLocalLog: (name) => name === 'abc123' ? 'local line\n' : null,
    }))

    expect(result).to.deep.equal({status: 'ok', text: 'local line\n'})
  })

  it('rejects a name that could escape the log directory', async () => {
    let reads = 0
    const result = await collectRuntimeLogs('../secret', deps({
      readLocalLog: () => {
        reads += 1
        return 'nope'
      },
    }))

    expect(reads).to.equal(0)
    expect(result.status).to.equal('error')
    expect(result.text).to.include('Invalid agent name')
  })

  it('records stdout and stderr and replaces them on the next start', () => {
    const agentName = 'local-agent'
    const stderr: string[] = []
    const streams = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }
    attachRuntimeLog(agentName, streams, {
      logsDir,
      writeStderr: (chunk) => {
        stderr.push(String(chunk))
      },
    })
    streams.stdout.emit('data', Buffer.from('Agent ready on port 4321\n'))
    streams.stderr.emit('data', Buffer.from(CRASH))

    expect(readLocalRuntimeLog(agentName, logsDir)).to.equal(`Agent ready on port 4321\n${CRASH}`)
    expect(stderr).to.deep.equal([CRASH])

    const next = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }
    attachRuntimeLog(agentName, next, {logsDir, writeStderr: () => {}})
    next.stdout.emit('data', Buffer.from('second run\n'))
    expect(readLocalRuntimeLog(agentName, logsDir)).to.equal('second run\n')
  })
})
