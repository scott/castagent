import {expect} from 'chai'
import Stop from '../../../typescript/cast-cli/src/commands/stop'
import {
  dockerInspectStatusArgs,
  dockerStopArgs,
  isDockerContainerRunning,
  stopAgent,
  type CommandResult,
  type StopAgentDeps,
} from '../../../typescript/cast-cli/src/lib/stop-agent'

function ok(stdout = ''): CommandResult {
  return {stdout, stderr: '', exitCode: 0}
}

function deps(overrides: Partial<StopAgentDeps> = {}): StopAgentDeps & {dockerArgs: string[][]} {
  const dockerArgs: string[][] = []
  return {
    dockerArgs,
    getLocalAgent: () => null,
    listDeployments: () => [],
    runDocker: async (args) => {
      dockerArgs.push(args)
      return ok('running\n')
    },
    signal: () => {},
    removeLocalAgent: () => {},
    sleep: async () => {},
    ...overrides,
  }
}

describe('stop agent', () => {
  it('describes stop as covering a local agent or a Docker deployment', () => {
    expect(Stop.description).to.equal('Stop a running local agent or Docker deployment')
  })

  it('treats running, restarting, and paused containers as up', () => {
    expect(isDockerContainerRunning('running\n')).to.equal(true)
    expect(isDockerContainerRunning('Restarting')).to.equal(true)
    expect(isDockerContainerRunning('paused')).to.equal(true)
    expect(isDockerContainerRunning('exited')).to.equal(false)
    expect(isDockerContainerRunning('created')).to.equal(false)
  })

  it('stops a running container immediately when force is set', () => {
    expect(dockerStopArgs('cast-bb3-chat', false)).to.deep.equal(['stop', 'cast-bb3-chat'])
    expect(dockerStopArgs('cast-bb3-chat', true)).to.deep.equal(['stop', '--time', '0', 'cast-bb3-chat'])
    expect(dockerInspectStatusArgs('cast-bb3-chat')).to.deep.equal([
      'inspect', '--format', '{{.State.Status}}', 'cast-bb3-chat',
    ])
  })

  it('stops a running Docker deployment when no local PID is recorded', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}, {provider: 'fly'}],
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb3-chat' (Docker container: cast-bb3-chat)...",
      "✓ Agent 'bb3-chat' stopped successfully.",
    ])
    expect(harness.dockerArgs).to.deep.equal([
      ['inspect', '--format', '{{.State.Status}}', 'cast-bb3-chat'],
      ['stop', 'cast-bb3-chat'],
    ])
  })

  it('uses docker stop --time 0 when --force is set', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
    })

    const result = await stopAgent('bb3-chat', {force: true}, harness)

    expect(result.status).to.equal('stopped')
    expect(harness.dockerArgs[1]).to.deep.equal(['stop', '--time', '0', 'cast-bb3-chat'])
  })

  it('reports a Docker deployment as not running when the container has exited', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
      runDocker: async (args) => {
        harness.dockerArgs.push(args)
        return ok('exited\n')
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('not_running')
    expect(result.messages[0].text).to.equal("Agent 'bb3-chat' is not currently running.")
    expect(harness.dockerArgs).to.deep.equal([
      ['inspect', '--format', '{{.State.Status}}', 'cast-bb3-chat'],
    ])
  })

  it('reports not running when the Docker container does not exist', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
      runDocker: async (args) => {
        harness.dockerArgs.push(args)
        return {stdout: '', stderr: 'Error: No such container: cast-bb3-chat\n', exitCode: 1}
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('not_running')
    expect(harness.dockerArgs).to.have.length(1)
  })

  it('does not inspect Docker for a non-Docker deployment', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'railway'}],
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('not_running')
    expect(harness.dockerArgs).to.deep.equal([])
  })

  it('reports a Docker inspect failure instead of claiming the agent is stopped', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
      runDocker: async () => ({
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon\n',
        exitCode: 1,
      }),
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages[0].text).to.equal('Failed to stop agent: Cannot connect to the Docker daemon')
  })

  it('reports a failed docker stop', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
      runDocker: async (args) => {
        if (args[0] === 'inspect') return ok('running\n')
        return {stdout: '', stderr: 'container is restarting\n', exitCode: 1}
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb3-chat' (Docker container: cast-bb3-chat)...",
      'Failed to stop agent: container is restarting',
    ])
    expect(result.messages[1].kind).to.equal('error')
  })

  it('announces the Docker stop before it runs docker stop', async () => {
    const lines: string[] = []
    let stopped = false
    const harness = deps({
      listDeployments: () => [{provider: 'docker'}],
      onLog: (text) => {
        lines.push(text)
      },
      runDocker: async (args) => {
        if (args[0] === 'stop') {
          stopped = true
          expect(lines).to.deep.equal([
            "Stopping agent 'bb3-chat' (Docker container: cast-bb3-chat)...",
          ])
        }
        return ok(args[0] === 'inspect' ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(stopped).to.equal(true)
    expect(result.status).to.equal('stopped')
  })

  it('stops the local process and leaves a Docker deployment alone while that process is alive', async () => {
    const signals: Array<NodeJS.Signals | 0> = []
    let removed = 0
    let checks = 0
    const harness = deps({
      getLocalAgent: () => ({pid: 4242, port: 8080}),
      listDeployments: () => [{provider: 'docker'}],
      signal: (pid, signal) => {
        expect(pid).to.equal(4242)
        signals.push(signal)
        if (signal === 0) {
          checks += 1
          if (checks > 1) throw new Error('gone')
        }
      },
      removeLocalAgent: () => {
        removed += 1
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(signals).to.deep.equal([0, 'SIGTERM', 0])
    expect(removed).to.equal(1)
    expect(harness.dockerArgs).to.deep.equal([])
    expect(result.messages.map(message => message.text)[0]).to.equal(
      "Stopping agent 'bb3-chat' (PID: 4242, port: 8080)...",
    )
  })

  it('sends SIGKILL to a local process when --force is set', async () => {
    const signals: Array<NodeJS.Signals | 0> = []
    let checks = 0
    const harness = deps({
      getLocalAgent: () => ({pid: 7, port: 9}),
      signal: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0) {
          checks += 1
          if (checks > 1) throw new Error('gone')
        }
      },
    })

    await stopAgent('bb3-chat', {force: true}, harness)

    expect(signals).to.include('SIGKILL')
  })

  it('warns when a local process does not exit', async () => {
    const harness = deps({
      getLocalAgent: () => ({pid: 7, port: 9}),
      signal: () => {},
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('timeout')
    expect(result.messages).to.deep.equal([
      {kind: 'log', text: "Stopping agent 'bb3-chat' (PID: 7, port: 9)..."},
      {kind: 'warn', text: "Agent 'bb3-chat' did not stop gracefully."},
      {kind: 'log', text: 'Use --force to kill it immediately.'},
    ])
  })

  it('stops a running Docker container after dropping a stale local PID', async () => {
    let removed = 0
    const harness = deps({
      getLocalAgent: () => ({pid: 99999, port: 1234}),
      listDeployments: () => [{provider: 'docker'}],
      signal: () => {
        throw new Error('ESRCH')
      },
      removeLocalAgent: () => {
        removed += 1
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(removed).to.equal(1)
    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb3-chat' (PID: 99999, port: 1234)...",
      'Process 99999 is not running. Cleaning up database entry.',
      "Stopping agent 'bb3-chat' (Docker container: cast-bb3-chat)...",
      "✓ Agent 'bb3-chat' stopped successfully.",
    ])
    expect(harness.dockerArgs[1]).to.deep.equal(['stop', 'cast-bb3-chat'])
  })

  it('cleans a stale local PID and does not claim a second failure when Docker is down', async () => {
    const harness = deps({
      getLocalAgent: () => ({pid: 99999, port: 1234}),
      listDeployments: () => [],
      signal: () => {
        throw new Error('ESRCH')
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('cleaned')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb3-chat' (PID: 99999, port: 1234)...",
      'Process 99999 is not running. Cleaning up database entry.',
    ])
    expect(harness.dockerArgs).to.deep.equal([])
  })
})
