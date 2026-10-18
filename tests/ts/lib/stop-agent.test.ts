import {expect} from 'chai'
import Stop from '../../../typescript/cast-cli/src/commands/stop'
import {
  flyMachineStopArgs,
  flyMachinesListArgs,
} from '../../../typescript/cast-cli/src/lib/deploy/fly'
import {
  digitalOceanDropletIp,
  digitalOceanInspectCommand,
  digitalOceanStopCommand,
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
    runSsh: async () => {
      throw new Error('unexpected ssh')
    },
    runFly: async () => {
      throw new Error('unexpected flyctl')
    },
    signal: () => {},
    removeLocalAgent: () => {},
    sleep: async () => {},
    ...overrides,
  }
}

describe('stop agent', () => {
  it('describes stop as covering a local agent or a Docker deployment', () => {
    expect(Stop.description).to.equal('Stop a running local agent, Docker deployment, DigitalOcean droplet, or Fly.io machine')
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

  it('reads the droplet address from current and older deployment URLs', () => {
    expect(digitalOceanDropletIp('https://203.0.113.10')).to.equal('203.0.113.10')
    expect(digitalOceanDropletIp('http://203.0.113.10:8080')).to.equal('203.0.113.10')
    expect(() => digitalOceanDropletIp('')).to.throw('no droplet address')
    expect(() => digitalOceanDropletIp('https://example.com')).to.throw('no IPv4 droplet address')
    expect(() => digitalOceanDropletIp('https://127.0.0.1')).to.throw('droplet address')
    expect(() => digitalOceanDropletIp('not a url')).to.throw('not valid')
  })

  it('builds remote docker commands that do not take the agent name', () => {
    expect(digitalOceanInspectCommand()).to.equal("docker inspect --format '{{.State.Status}}' cast-agent")
    expect(digitalOceanStopCommand(false)).to.equal('docker stop cast-agent')
    expect(digitalOceanStopCommand(true)).to.equal('docker stop --time 0 cast-agent')
    for (const command of [
      digitalOceanInspectCommand(),
      digitalOceanStopCommand(false),
      digitalOceanStopCommand(true),
    ]) {
      expect(command).to.not.match(/[;$`]/)
      expect(command).to.not.include('bb4-do')
    }
  })

  it('stops a running DigitalOcean container when no local process is recorded', async () => {
    const sshCalls: Array<{ip: string; command: string}> = []
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async (ip, command) => {
        sshCalls.push({ip, command})
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb4-do' (DigitalOcean droplet 203.0.113.10, container cast-agent)...",
      "✓ Agent 'bb4-do' stopped successfully.",
    ])
    expect(sshCalls).to.deep.equal([
      {ip: '203.0.113.10', command: digitalOceanInspectCommand()},
      {ip: '203.0.113.10', command: digitalOceanStopCommand(false)},
    ])
    expect(harness.dockerArgs).to.deep.equal([])
  })

  it('accepts an older http://ip:8080 droplet URL', async () => {
    const sshCalls: string[] = []
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'http://203.0.113.10:8080'}],
      runSsh: async (ip, command) => {
        expect(ip).to.equal('203.0.113.10')
        sshCalls.push(command)
        return ok('running\n')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(sshCalls[1]).to.equal(digitalOceanStopCommand(false))
  })

  it('uses docker stop --time 0 on the droplet when --force is set', async () => {
    const sshCalls: string[] = []
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async (_ip, command) => {
        sshCalls.push(command)
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb4-do', {force: true}, harness)

    expect(result.status).to.equal('stopped')
    expect(sshCalls[1]).to.equal('docker stop --time 0 cast-agent')
  })

  it('does not send the agent name or URL userinfo to the droplet', async () => {
    const secret = 'token-value-should-not-leak'
    const sshCalls: string[] = []
    const harness = deps({
      listDeployments: () => [{
        provider: 'digitalocean',
        deployment_url: `https://user:${secret}@203.0.113.10/path?x=${secret}`,
      }],
      runSsh: async (_ip, command) => {
        sshCalls.push(command)
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    await stopAgent(`bb4-do';$(${secret})`, {}, harness)

    const sent = sshCalls.join('\n')
    expect(sent).to.not.include(secret)
    expect(sent).to.not.include('bb4-do')
    expect(sshCalls).to.deep.equal([
      digitalOceanInspectCommand(),
      digitalOceanStopCommand(false),
    ])
  })

  it('stops the newest DigitalOcean deployment and ignores a MicroVM row', async () => {
    const ips: string[] = []
    const harness = deps({
      listDeployments: () => [
        {provider: 'microvm', deployment_url: 'https://198.51.100.8'},
        {provider: 'digitalocean', deployment_url: 'https://203.0.113.10'},
        {provider: 'digitalocean', deployment_url: 'https://203.0.113.20'},
      ],
      runSsh: async (ip, command) => {
        ips.push(ip)
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(ips).to.deep.equal(['203.0.113.10', '203.0.113.10'])
  })

  it('reports a stopped droplet container as not running', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async () => ok('exited\n'),
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('not_running')
    expect(result.messages[0].text).to.equal("Agent 'bb4-do' is not currently running.")
  })

  it('reports a missing droplet container as not running', async () => {
    let calls = 0
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async () => {
        calls += 1
        return {stdout: '', stderr: 'Error: No such container: cast-agent\n', exitCode: 1}
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('not_running')
    expect(calls).to.equal(1)
  })

  it('reports an SSH failure instead of claiming the droplet agent is stopped', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async () => {
        throw new Error('Refusing to connect to 203.0.113.10 because no pinned SSH host key is stored')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages[0].text).to.equal(
      'Failed to stop agent: Refusing to connect to 203.0.113.10 because no pinned SSH host key is stored',
    )
  })

  it('reports a failed remote docker inspect', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async () => ({stdout: '', stderr: 'Connection refused\n', exitCode: 255}),
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages[0].text).to.equal('Failed to stop agent: Connection refused')
  })

  it('reports a failed remote docker stop', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      runSsh: async (_ip, command) => {
        if (command.startsWith('docker inspect')) return ok('running\n')
        return {stdout: '', stderr: 'container is restarting\n', exitCode: 1}
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb4-do' (DigitalOcean droplet 203.0.113.10, container cast-agent)...",
      'Failed to stop agent: container is restarting',
    ])
    expect(result.messages[1].kind).to.equal('error')
  })

  it('announces the droplet stop before it runs docker stop', async () => {
    const lines: string[] = []
    let stopped = false
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      onLog: (text) => {
        lines.push(text)
      },
      runSsh: async (_ip, command) => {
        if (command.startsWith('docker stop')) {
          stopped = true
          expect(lines).to.deep.equal([
            "Stopping agent 'bb4-do' (DigitalOcean droplet 203.0.113.10, container cast-agent)...",
          ])
        }
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(stopped).to.equal(true)
    expect(result.status).to.equal('stopped')
  })

  it('does not SSH when the deployment URL has no IPv4 droplet address', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://example.com'}],
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages[0].text).to.equal('Failed to stop agent: DigitalOcean deployment has no IPv4 droplet address')
  })

  it('does not SSH to a loopback deployment URL', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://127.0.0.1'}],
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages[0].text).to.include('droplet address')
    expect(result.messages[0].text).to.not.include('not currently running')
  })

  it('does not SSH while a local Docker container is running', async () => {
    const harness = deps({
      listDeployments: () => [
        {provider: 'docker'},
        {provider: 'digitalocean', deployment_url: 'https://203.0.113.10'},
      ],
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(harness.dockerArgs[1]).to.deep.equal(['stop', 'cast-bb4-do'])
  })

  it('stops the droplet when the local Docker container is not running', async () => {
    const sshCalls: string[] = []
    const harness = deps({
      listDeployments: () => [
        {provider: 'docker'},
        {provider: 'digitalocean', deployment_url: 'https://203.0.113.10'},
      ],
      runDocker: async (args) => {
        harness.dockerArgs.push(args)
        return ok('exited\n')
      },
      runSsh: async (_ip, command) => {
        sshCalls.push(command)
        return ok(command.startsWith('docker inspect') ? 'running\n' : '')
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(harness.dockerArgs).to.deep.equal([
      ['inspect', '--format', '{{.State.Status}}', 'cast-bb4-do'],
    ])
    expect(sshCalls[1]).to.equal(digitalOceanStopCommand(false))
  })

  it('stops the droplet container after dropping a stale local PID', async () => {
    const harness = deps({
      getLocalAgent: () => ({pid: 99999, port: 1234}),
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      signal: () => {
        throw new Error('ESRCH')
      },
      runSsh: async (_ip, command) => ok(command.startsWith('docker inspect') ? 'running\n' : ''),
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb4-do' (PID: 99999, port: 1234)...",
      'Process 99999 is not running. Cleaning up database entry.',
      "Stopping agent 'bb4-do' (DigitalOcean droplet 203.0.113.10, container cast-agent)...",
      "✓ Agent 'bb4-do' stopped successfully.",
    ])
  })

  it('stops a live local process and does not SSH to the droplet', async () => {
    let checks = 0
    const harness = deps({
      getLocalAgent: () => ({pid: 4242, port: 8080}),
      listDeployments: () => [{provider: 'digitalocean', deployment_url: 'https://203.0.113.10'}],
      signal: (_pid, signal) => {
        if (signal === 0) {
          checks += 1
          if (checks > 1) throw new Error('gone')
        }
      },
    })

    const result = await stopAgent('bb4-do', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)[0]).to.equal(
      "Stopping agent 'bb4-do' (PID: 4242, port: 8080)...",
    )
  })

  it('stops a started Fly machine when no local or Docker process is running', async () => {
    const flyCalls: string[][] = []
    const harness = deps({
      listDeployments: () => [{provider: 'fly', deployment_url: 'https://cast-bb3-chat.fly.dev'}],
      runFly: async (args) => {
        flyCalls.push(args)
        if (args[0] === 'machines') {
          return ok(JSON.stringify([{id: '148ed123', state: 'started'}, {id: 'stopped1', state: 'stopped'}]))
        }
        return ok('')
      },
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('stopped')
    expect(result.messages.map(message => message.text)).to.deep.equal([
      "Stopping agent 'bb3-chat' (Fly app cast-bb3-chat)...",
      "✓ Agent 'bb3-chat' stopped successfully.",
    ])
    expect(flyCalls).to.deep.equal([
      flyMachinesListArgs('cast-bb3-chat'),
      flyMachineStopArgs('148ed123', 'cast-bb3-chat', false),
    ])
    expect(harness.dockerArgs).to.deep.equal([])
  })

  it('uses SIGKILL when stopping a Fly machine with --force', async () => {
    const flyCalls: string[][] = []
    const harness = deps({
      listDeployments: () => [{provider: 'fly', deployment_url: 'https://cast-bb3-chat.fly.dev'}],
      runFly: async (args) => {
        flyCalls.push(args)
        if (args[0] === 'machines') return ok('[{"id":"abc","state":"starting"}]')
        return ok('')
      },
    })

    const result = await stopAgent('bb3-chat', {force: true}, harness)

    expect(result.status).to.equal('stopped')
    expect(flyCalls[1]).to.deep.equal(flyMachineStopArgs('abc', 'cast-bb3-chat', true))
  })

  it('does not claim a Fly app is stopped when flyctl fails', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'fly', deployment_url: 'https://cast-bb3-chat.fly.dev'}],
      runFly: async () => ({stdout: '', stderr: 'Error: authentication handshake failed\n', exitCode: 1}),
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('error')
    expect(result.messages.map(message => message.text).join('\n')).to.include('authentication handshake failed')
    expect(result.messages.map(message => message.text).join('\n')).to.not.include('stopped successfully')
  })

  it('reports a stopped Fly app as not running', async () => {
    const harness = deps({
      listDeployments: () => [{provider: 'fly', deployment_url: 'https://cast-bb3-chat.fly.dev'}],
      runFly: async () => ok('[{"id":"abc","state":"stopped"}]'),
    })

    const result = await stopAgent('bb3-chat', {}, harness)

    expect(result.status).to.equal('not_running')
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
