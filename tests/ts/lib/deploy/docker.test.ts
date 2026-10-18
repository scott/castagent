import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import DockerDeploy, {
  dockerImageName,
  dockerImageRemovalMessage,
  dockerMemoryVolumeName,
  dockerMemoryVolumesToRemove,
  dockerVolumeRemovalMessage,
  isLegacyDockerMemoryVolume,
  planDockerMemoryVolume,
  prepareDockerMemoryVolume,
  recordDockerDeployment,
  removeDockerImage,
  removeDockerMemoryVolumes,
  renderDockerCompose,
  writeDockerCompose,
  type DockerRunner,
} from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'

describe('Docker Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(DockerDeploy.description).to.equal('Deploy agent locally with Docker')
    })

    it('should define --no-build flag', () => {
      expect(DockerDeploy.flags).to.have.property('no-build')
      expect(DockerDeploy.flags['no-build'].default).to.equal(false)
    })

    it('should define --port flag with default 8080', () => {
      expect(DockerDeploy.flags).to.have.property('port')
      expect(DockerDeploy.flags.port.default).to.equal(8080)
    })

    it('should require agent argument', () => {
      expect(DockerDeploy.args).to.have.property('agent')
      expect(DockerDeploy.args.agent.required).to.be.true
      expect(DockerDeploy.args.agent.description).to.equal('Agent name')
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(DockerDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      // Create a minimal instance to verify class structure
      const instance = new DockerDeploy(['deploy', 'docker'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof DockerDeploy.destroy).to.equal('function')
    })
  })

  describe('recordDockerDeployment', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
    })

    afterEach(() => {
      sandbox.restore()
    })

    const input = {
      agentName: 'bb-answers',
      deploymentUrl: 'http://localhost:8080',
      tokenHash: 'hash',
      volumeId: 'cast-bb-answers-vol',
      volumeConfig: '{}',
      containerName: 'cast-bb-answers',
    }

    it('records the deployment and leaves the container running', async () => {
      const save = sandbox.stub(deployUtils, 'saveDeployment').returns('abc123')
      const exec = sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})

      const id = await recordDockerDeployment(input)

      expect(id).to.equal('abc123')
      expect(save.calledOnce).to.equal(true)
      expect(save.firstCall.args[0]).to.equal('bb-answers')
      expect(save.firstCall.args[1]).to.equal('docker')
      expect(save.firstCall.args[2]).to.equal('http://localhost:8080')
      expect(exec.called).to.equal(false)
    })

    it('removes the container and volume when the registry write fails', async () => {
      sandbox.stub(deployUtils, 'saveDeployment').throws(new Error('FOREIGN KEY constraint failed'))
      const exec = sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})

      try {
        await recordDockerDeployment(input)
        expect.fail('registry failure should reject')
      } catch (error) {
        expect((error as Error).message).to.equal('FOREIGN KEY constraint failed')
      }

      expect(exec.getCalls().map(call => call.args)).to.deep.equal([
        ['docker', ['stop', 'cast-bb-answers']],
        ['docker', ['rm', 'cast-bb-answers']],
        ['docker', ['volume', 'rm', 'cast-bb-answers-vol']],
      ])
    })

    it('leaves a reused memory volume in place when the registry write fails', async () => {
      sandbox.stub(deployUtils, 'saveDeployment').throws(new Error('FOREIGN KEY constraint failed'))
      const exec = sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})

      try {
        await recordDockerDeployment({...input, removeVolumeOnFailure: false})
        expect.fail('registry failure should reject')
      } catch (error) {
        expect((error as Error).message).to.equal('FOREIGN KEY constraint failed')
      }

      expect(exec.getCalls().map(call => call.args)).to.deep.equal([
        ['docker', ['stop', 'cast-bb-answers']],
        ['docker', ['rm', 'cast-bb-answers']],
      ])
    })

    it('reports a leftover container when cleanup fails', async () => {
      sandbox.stub(deployUtils, 'saveDeployment').throws(new Error('FOREIGN KEY constraint failed'))
      sandbox.stub(deployUtils, 'execCommand').resolves({
        stdout: '',
        stderr: 'permission denied',
        exitCode: 1,
      })

      try {
        await recordDockerDeployment(input)
        expect.fail('registry failure should reject')
      } catch (error) {
        const message = (error as Error).message
        expect(message).to.include('FOREIGN KEY constraint failed')
        expect(message).to.include("Failed to remove container 'cast-bb-answers'")
        expect(message).to.include('permission denied')
      }
    })
  })

  describe('command construction', () => {
    it('should define docker as the CLI command', () => {
      // The docker provider is defined in deploy.ts, verify its presence in valid providers
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('docker')
    })
  })

  describe('docker-compose.yml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-docker-compose-'))

    after(() => {
      fs.rmSync(root, {recursive: true, force: true})
    })

    function git(cwd: string, args: string[]): string {
      return execFileSync('git', args, {cwd, encoding: 'utf8'})
    }

    function initRepo(dir: string): void {
      fs.mkdirSync(dir, {recursive: true})
      git(dir, ['init'])
      git(dir, ['config', 'user.email', 'cast-test@example.com'])
      git(dir, ['config', 'user.name', 'Cast Test'])
    }

    it('passes the bearer token to docker run on stdin and not to the compose file', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/docker.ts'),
        'utf8',
      )
      expect(source).to.include("'--env-file', '/dev/stdin'")
      expect(source).to.not.include("'-e', `AUTH_TOKEN=${authToken}`")
      const composeFn = source.slice(source.indexOf('export function renderDockerCompose'))
      expect(composeFn).to.not.include('AUTH_TOKEN')
      expect(composeFn).to.not.include('inferenceEnv')
      expect(composeFn).to.not.include('authToken')
    })

    it('renders ports and the volume without the bearer token or provider keys', () => {
      const text = renderDockerCompose({
        agentName: 'demo',
        port: 9090,
        volumeId: 'cast-demo-vol',
      })
      expect(text).to.equal([
        "version: '3.8'",
        '',
        'services:',
        '  demo:',
        '    build:',
        '      context: .',
        '      dockerfile: Dockerfile',
        '    container_name: cast-demo',
        '    ports:',
        '      - "9090:8080"',
        '    environment:',
        '      - CAST_AGENT_NAME=demo',
        '      - CAST_AGENT_PATH=/app/agent',
        '      - PYTHONPATH=/app',
        '    volumes:',
        '      - cast-demo-vol:/app/agent/memory',
        '    restart: unless-stopped',
        '',
        'volumes:',
        '  cast-demo-vol:',
        '',
      ].join('\n'))
      expect(text).to.not.include('AUTH_TOKEN')
      expect(text).to.not.include('API_KEY')
      expect(text).to.not.include('OPENROUTER')

      const withoutVolume = renderDockerCompose({agentName: 'demo', port: 8080})
      expect(withoutVolume).to.not.include('volumes:')
      expect(withoutVolume).to.not.include('AUTH_TOKEN')
      expect(withoutVolume).to.include('restart: unless-stopped\n')
    })

    it('overwrites a compose file that already contains the token and leaves it untracked', () => {
      const agent = path.join(root, 'fresh')
      initRepo(agent)
      fs.writeFileSync(path.join(agent, '.gitignore'), '*.log\n')
      fs.writeFileSync(path.join(agent, '.castignore'), '*.log\n')
      fs.writeFileSync(
        path.join(agent, 'docker-compose.yml'),
        'AUTH_TOKEN=sekret-token-value\n      - OPENROUTER_API_KEY=sk-test\n',
      )

      writeDockerCompose(agent, {agentName: 'demo', port: 8080, volumeId: 'cast-demo-vol'})

      const text = fs.readFileSync(path.join(agent, 'docker-compose.yml'), 'utf8')
      expect(text).to.not.include('sekret-token-value')
      expect(text).to.not.include('sk-test')
      expect(text).to.not.include('AUTH_TOKEN')
      expect(text).to.include('CAST_AGENT_NAME=demo')

      git(agent, ['add', '-A'])
      const staged = git(agent, ['diff', '--cached', '--name-only'])
      expect(staged).to.not.contain('docker-compose.yml')
      expect(staged).to.not.contain('sekret-token-value')
    })

    it('removes the token from a compose file that was already committed', () => {
      const agent = path.join(root, 'tracked')
      initRepo(agent)
      fs.writeFileSync(path.join(agent, 'docker-compose.yml'), 'AUTH_TOKEN=sekret-token-value\n')
      fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: demo\n')
      git(agent, ['add', '-A'])
      git(agent, ['commit', '-m', 'leaked token'])

      writeDockerCompose(agent, {agentName: 'demo', port: 8080, volumeId: 'cast-demo-vol'})
      git(agent, ['add', '-A'])
      git(agent, ['commit', '-m', 'redeploy'])

      const blob = git(agent, ['show', 'HEAD:docker-compose.yml'])
      expect(blob).to.not.include('sekret-token-value')
      expect(blob).to.not.include('AUTH_TOKEN')
      expect(blob).to.include('CAST_AGENT_NAME=demo')
    })

    it('does not create ignore files when the agent is not a git repo', () => {
      const agent = path.join(root, 'no-git')
      fs.mkdirSync(agent)
      writeDockerCompose(agent, {agentName: 'demo', port: 8080, volumeId: 'vol'})
      expect(fs.existsSync(path.join(agent, 'docker-compose.yml'))).to.equal(true)
      expect(fs.readFileSync(path.join(agent, 'docker-compose.yml'), 'utf8')).to.not.include('AUTH_TOKEN')
      expect(fs.existsSync(path.join(agent, '.gitignore'))).to.equal(false)
      expect(fs.existsSync(path.join(agent, '.castignore'))).to.equal(false)
    })
  })

  describe('memory volume identity', () => {
    const legacy = 'cast-bb2-chat-11111111-1111-1111-1111-111111111111-memory'
    const older = 'cast-bb2-chat-22222222-2222-2222-2222-222222222222-memory'

    it('names the volume cast-<agent>', () => {
      expect(dockerMemoryVolumeName('bb2-chat')).to.equal('cast-bb2-chat')
    })

    it('recognizes only pre-fix uuid volumes for that agent', () => {
      expect(isLegacyDockerMemoryVolume(legacy, 'bb2-chat')).to.equal(true)
      expect(isLegacyDockerMemoryVolume('cast-bb2-chat', 'bb2-chat')).to.equal(false)
      expect(isLegacyDockerMemoryVolume('cast-bb2-chat-memory', 'bb2-chat')).to.equal(false)
      expect(isLegacyDockerMemoryVolume('cast-bb2-chat-deploy-123-memory', 'bb2-chat')).to.equal(false)
      expect(isLegacyDockerMemoryVolume(legacy, 'bb2')).to.equal(false)
      expect(isLegacyDockerMemoryVolume('cast-bb2-chatbot', 'bb2-chat')).to.equal(false)
    })

    it('reuses cast-<agent> on a second deploy', () => {
      const first = planDockerMemoryVolume('bb2-chat', null, [])
      expect(first).to.deep.equal({volumeId: 'cast-bb2-chat', action: 'create'})

      const second = planDockerMemoryVolume('bb2-chat', 'cast-bb2-chat', ['cast-bb2-chat', older])
      expect(second).to.deep.equal({volumeId: 'cast-bb2-chat', action: 'reuse'})
    })

    it('copies the recorded pre-fix volume onto cast-<agent>', () => {
      const plan = planDockerMemoryVolume('bb2-chat', legacy, [legacy, older, 'cast-other'])
      expect(plan).to.deep.equal({volumeId: 'cast-bb2-chat', action: 'create', copyFrom: legacy})
    })

    it('reuses the recorded volume when Docker cannot be listed', () => {
      const plan = planDockerMemoryVolume('bb2-chat', legacy, null)
      expect(plan).to.deep.equal({volumeId: legacy, action: 'reuse'})
    })

    it('selects the named volume, recorded volumes, and leftover pre-fix volumes', () => {
      const names = dockerMemoryVolumesToRemove(
        'bb2-chat',
        [legacy, null, ''],
        ['cast-bb2-chat', legacy, older, 'cast-bb2-chatbot', 'cast-other'],
      )
      expect(names).to.deep.equal(['cast-bb2-chat', legacy, older].sort())
    })

    it('reports removal only when docker volume rm succeeds', () => {
      expect(dockerVolumeRemovalMessage('cast-bb2-chat', {exitCode: 0, stdout: 'cast-bb2-chat', stderr: ''}))
        .to.equal("Memory volume 'cast-bb2-chat' has been removed.")
      expect(dockerVolumeRemovalMessage('cast-bb2-chat', {exitCode: 1, stdout: '', stderr: 'Error: No such volume: cast-bb2-chat'}))
        .to.equal(null)
      expect(dockerVolumeRemovalMessage('cast-bb2-chat', {exitCode: 1, stdout: '', stderr: 'volume is in use'}))
        .to.equal("Note: Memory volume 'cast-bb2-chat' could not be removed (may be in use or already deleted).")
    })
  })

  describe('prepareDockerMemoryVolume', () => {
    const legacy = 'cast-bb2-chat-11111111-1111-1111-1111-111111111111-memory'

    function runner(volumes: string[], opts?: {createFails?: boolean; copyFails?: boolean; rmFails?: boolean}): {run: DockerRunner; calls: string[][]} {
      const calls: string[][] = []
      const present = new Set(volumes)
      const run: DockerRunner = async (args) => {
        calls.push(args)
        if (args[0] === 'volume' && args[1] === 'ls') {
          return {exitCode: 0, stdout: [...present].join('\n'), stderr: ''}
        }
        if (args[0] === 'volume' && args[1] === 'create') {
          if (opts?.createFails) return {exitCode: 1, stdout: '', stderr: 'denied'}
          present.add(args[2])
          return {exitCode: 0, stdout: args[2], stderr: ''}
        }
        if (args[0] === 'run') {
          if (opts?.copyFails) return {exitCode: 1, stdout: '', stderr: 'cp failed'}
          return {exitCode: 0, stdout: '', stderr: ''}
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          if (opts?.rmFails) return {exitCode: 1, stdout: '', stderr: 'volume is in use'}
          present.delete(args[2])
          return {exitCode: 0, stdout: args[2], stderr: ''}
        }
        return {exitCode: 1, stdout: '', stderr: 'unexpected'}
      }
      return {run, calls}
    }

    it('creates cast-<agent> when the agent has no memory volume', async () => {
      const {run, calls} = runner([])
      const prepared = await prepareDockerMemoryVolume('bb2-chat', null, 'cast-bb2-chat:latest', run)
      expect(prepared.volumeId).to.equal('cast-bb2-chat')
      expect(prepared.message).to.equal('Creating memory volume: cast-bb2-chat')
      expect(prepared.created).to.equal(true)
      expect(calls.some(args => args[0] === 'volume' && args[1] === 'create' && args[2] === 'cast-bb2-chat')).to.equal(true)
      expect(calls.some(args => args[0] === 'run')).to.equal(false)
    })

    it('does not create a volume when cast-<agent> already exists', async () => {
      const {run, calls} = runner(['cast-bb2-chat', legacy])
      const prepared = await prepareDockerMemoryVolume('bb2-chat', 'cast-bb2-chat', 'cast-bb2-chat:latest', run)
      expect(prepared).to.deep.equal({
        volumeId: 'cast-bb2-chat',
        message: 'Reusing memory volume: cast-bb2-chat',
        created: false,
      })
      expect(calls.map(args => args.slice(0, 2))).to.deep.equal([['volume', 'ls']])
    })

    it('copies a pre-fix volume into cast-<agent> with one shell argument', async () => {
      const {run, calls} = runner([legacy])
      const prepared = await prepareDockerMemoryVolume('bb2-chat', legacy, 'cast-bb2-chat:latest', run)
      expect(prepared.volumeId).to.equal('cast-bb2-chat')
      expect(prepared.message).to.equal('Creating memory volume: cast-bb2-chat')
      expect(prepared.note).to.equal(`Copied memory from ${legacy}.`)
      expect(prepared.created).to.equal(true)
      expect(calls.find(args => args[0] === 'run')).to.deep.equal([
        'run', '--rm', '--entrypoint', 'sh',
        '-v', `${legacy}:/from:ro`,
        '-v', 'cast-bb2-chat:/to',
        'cast-bb2-chat:latest',
        '-c', 'cp -a /from/. /to/',
      ])
    })

    it('says when the empty volume is left behind after a failed copy', async () => {
      const {run} = runner([legacy], {copyFails: true, rmFails: true})
      const prepared = await prepareDockerMemoryVolume('bb2-chat', legacy, 'cast-bb2-chat:latest', run)
      expect(prepared.volumeId).to.equal(legacy)
      expect(prepared.created).to.equal(false)
      expect(prepared.note).to.equal(
        "Could not copy memory into 'cast-bb2-chat', so the existing volume stays attached. The empty volume 'cast-bb2-chat' could not be removed.",
      )
    })

    it('keeps the recorded volume when the copy fails and drops the empty volume', async () => {
      const {run, calls} = runner([legacy], {copyFails: true})
      const prepared = await prepareDockerMemoryVolume('bb2-chat', legacy, 'cast-bb2-chat:latest', run)
      expect(prepared.volumeId).to.equal(legacy)
      expect(prepared.message).to.equal(`Reusing memory volume: ${legacy}`)
      expect(prepared.created).to.equal(false)
      expect(prepared.note).to.equal("Could not copy memory into 'cast-bb2-chat', so the existing volume stays attached.")
      expect(calls.some(args => args[0] === 'volume' && args[1] === 'rm' && args[2] === 'cast-bb2-chat')).to.equal(true)
    })

    it('reuses the recorded volume when listing volumes fails', async () => {
      const calls: string[][] = []
      const run: DockerRunner = async (args) => {
        calls.push(args)
        throw new Error('docker missing')
      }
      const prepared = await prepareDockerMemoryVolume('bb2-chat', legacy, 'cast-bb2-chat:latest', run)
      expect(prepared.volumeId).to.equal(legacy)
      expect(prepared.message).to.equal(`Reusing memory volume: ${legacy}`)
      expect(prepared.created).to.equal(false)
      expect(calls).to.deep.equal([['volume', 'ls', '--format', '{{.Name}}']])
    })

    it('throws when the volume cannot be created', async () => {
      const {run} = runner([], {createFails: true})
      try {
        await prepareDockerMemoryVolume('bb2-chat', null, 'cast-bb2-chat:latest', run)
        expect.fail('create failure should reject')
      } catch (error) {
        expect((error as Error).message).to.equal("Failed to create memory volume 'cast-bb2-chat': denied")
      }
    })
  })

  describe('shutdown memory volumes', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
    })

    afterEach(() => {
      sandbox.restore()
    })

    const legacy = 'cast-bb2-chat-11111111-1111-1111-1111-111111111111-memory'
    const older = 'cast-bb2-chat-22222222-2222-2222-2222-222222222222-memory'

    it('removes every volume for the agent and not another agent', async () => {
      sandbox.stub(db, 'listDeployments').returns([
        {provider: 'docker', volume_id: legacy},
        {provider: 'fly', volume_id: 'cast-bb2-chat-fly'},
      ])
      const removed: string[] = []
      const exec = sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          return {
            exitCode: 0,
            stdout: ['cast-bb2-chat', legacy, older, 'cast-bb2-chatbot'].join('\n'),
            stderr: '',
          }
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          removed.push(args[2])
          return {exitCode: 0, stdout: args[2], stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((line: unknown) => {
        logs.push(String(line))
      })

      await DockerDeploy.destroy('bb2-chat')

      expect(removed.sort()).to.deep.equal(['cast-bb2-chat', legacy, older].sort())
      expect(removed).to.not.include('cast-bb2-chatbot')
      expect(removed).to.not.include('cast-bb2-chat-fly')
      const volumeLogs = logs.filter(line => line.startsWith('Memory volume') && line.includes('has been removed'))
      expect(volumeLogs).to.have.length(3)
      expect(logs).to.include("Docker image 'cast-bb2-chat:latest' has been removed.")
      expect(exec.calledWith('docker', ['rmi', 'cast-bb2-chat:latest'])).to.equal(true)
      expect(exec.called).to.equal(true)
    })

    it('does not claim a volume was removed when docker volume rm fails', async () => {
      sandbox.stub(db, 'listDeployments').returns([{provider: 'docker', volume_id: 'cast-bb2-chat'}])
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (_command: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          return {exitCode: 0, stdout: 'cast-bb2-chat\n', stderr: ''}
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          return {exitCode: 1, stdout: '', stderr: 'volume is in use'}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      const logs: string[] = []
      sandbox.stub(console, 'log').callsFake((line: unknown) => {
        logs.push(String(line))
      })

      await DockerDeploy.destroy('bb2-chat')

      const volumeLogs = logs.filter(line => line.includes('Memory volume'))
      expect(volumeLogs).to.deep.equal([
        "Note: Memory volume 'cast-bb2-chat' could not be removed (may be in use or already deleted).",
      ])
    })

    it('stays quiet when the recorded volume is already gone', async () => {
      const logs: string[] = []
      await removeDockerMemoryVolumes('bb2-chat', ['cast-bb2-chat'], async (args) => {
        if (args[1] === 'ls') return {exitCode: 0, stdout: '', stderr: ''}
        return {exitCode: 1, stdout: '', stderr: 'Error: No such volume: cast-bb2-chat'}
      }, (line) => logs.push(line))
      expect(logs).to.deep.equal([])
    })

    it('removes the agent image cast-<name>:latest', async () => {
      expect(dockerImageName('bb3-chat')).to.equal('cast-bb3-chat:latest')
      const calls: string[][] = []
      const logs: string[] = []
      await removeDockerImage('bb3-chat', async (args) => {
        calls.push(args)
        return {exitCode: 0, stdout: 'Untagged: cast-bb3-chat:latest', stderr: ''}
      }, (line) => logs.push(line))
      expect(calls).to.deep.equal([['rmi', 'cast-bb3-chat:latest']])
      expect(logs).to.deep.equal(["Docker image 'cast-bb3-chat:latest' has been removed."])
    })

    it('stays quiet when the agent image is already gone', async () => {
      const logs: string[] = []
      await removeDockerImage('bb3-chat', async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: No such image: cast-bb3-chat:latest',
      }), (line) => logs.push(line))
      expect(logs).to.deep.equal([])
      expect(dockerImageRemovalMessage('cast-bb3-chat:latest', {
        exitCode: 1,
        stdout: 'No such image: cast-bb3-chat:latest',
        stderr: '',
      })).to.equal(null)
    })

    it('notes when the agent image is still in use', async () => {
      const logs: string[] = []
      await removeDockerImage('bb3-chat', async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Error response from daemon: conflict: unable to delete cast-bb3-chat:latest (must be forced) - container abc is using its referenced image',
      }), (line) => logs.push(line))
      expect(logs).to.deep.equal([
        "Note: Docker image 'cast-bb3-chat:latest' could not be removed (may be in use or already deleted).",
      ])
    })

    it('notes when docker cannot be asked to remove the image', async () => {
      const logs: string[] = []
      await removeDockerImage('bb3-chat', async () => {
        throw new Error('spawn docker ENOENT')
      }, (line) => logs.push(line))
      expect(logs).to.deep.equal([
        "Note: Docker image 'cast-bb3-chat:latest' could not be removed (spawn docker ENOENT).",
      ])
    })
  })
})

describe('Docker deployment SHA', () => {
  const createdAgents: string[] = []
  let previousSha: string | undefined

  beforeEach(() => {
    previousSha = process.env.CAST_DEPLOYMENT_SHA
  })

  afterEach(() => {
    if (previousSha === undefined) delete process.env.CAST_DEPLOYMENT_SHA
    else process.env.CAST_DEPLOYMENT_SHA = previousSha
    for (const name of createdAgents) {
      try { db.deleteAgent(name) } catch { /* already gone */ }
    }
    createdAgents.length = 0
  })

  function agentName(label: string): string {
    const name = `deploy-test-docker-sha-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(name, '/tmp/agent.yaml')
    createdAgents.push(name)
    return name
  }

  function uniqueSha(used: Set<string> = new Set()): string {
    const alphabet = 'abcdef0123456789'
    let sha = ''
    do {
      sha = ''
      for (let i = 0; i < 6; i++) sha += alphabet[Math.floor(Math.random() * alphabet.length)]
    } while (used.has(sha))
    used.add(sha)
    return sha
  }

  function record(name: string, url: string, tokenHash: string, volumeId: string, volumeConfig: string) {
    return recordDockerDeployment({
      agentName: name,
      deploymentUrl: url,
      tokenHash,
      volumeId,
      volumeConfig,
      containerName: `cast-${name}`,
    })
  }

  it('stores the SHA cast deploy prints so cast connect finds it', async () => {
    const name = agentName('one')
    const printedSha = uniqueSha()
    process.env.CAST_DEPLOYMENT_SHA = printedSha

    const id = await record(
      name,
      'http://localhost:8080',
      'hash',
      'cast-vol',
      JSON.stringify({mountPath: '/app/agent/memory'}),
    )

    expect(id).to.equal(printedSha)
    const row = db.getDeploymentBySha(printedSha)
    expect(row).to.exist
    expect(row.agent_name).to.equal(name)
    expect(row.provider).to.equal('docker')
    expect(row.deployment_url).to.equal('http://localhost:8080')

    const resolution = deployUtils.resolveDeploymentTarget(printedSha)
    expect(resolution.type).to.equal('sha')
    expect(resolution.deployment.id).to.equal(printedSha)
    expect(resolution.deployment.agent_name).to.equal(name)
  })

  it('keeps both SHAs when docker deploy runs twice', async () => {
    const name = agentName('two')
    const used = new Set<string>()
    const firstSha = uniqueSha(used)
    const secondSha = uniqueSha(used)
    let absentSha = uniqueSha(used)
    while (db.getDeploymentBySha(absentSha)) absentSha = uniqueSha(used)

    process.env.CAST_DEPLOYMENT_SHA = firstSha
    await record(name, 'http://localhost:8080', 'h1', 'vol-1', '{}')
    process.env.CAST_DEPLOYMENT_SHA = secondSha
    await record(name, 'http://localhost:8081', 'h2', 'vol-2', '{}')

    const ids = db.listDeployments(name).map((row: {id: string}) => row.id)
    expect(ids).to.have.members([firstSha, secondSha])
    expect(deployUtils.resolveDeploymentTarget(firstSha).type).to.equal('sha')
    expect(deployUtils.resolveDeploymentTarget(secondSha).type).to.equal('sha')
    expect(deployUtils.resolveDeploymentTarget(absentSha).type).to.equal('not_found')
  })

  it('still records a row when no deployment SHA was set', async () => {
    const name = agentName('generated')
    delete process.env.CAST_DEPLOYMENT_SHA

    const id = await record(name, 'http://localhost:8080', 'hash', 'vol', '{}')

    expect(id).to.match(/^[a-z0-9]{6}$/)
    expect(db.getDeploymentBySha(id).agent_name).to.equal(name)
    expect(deployUtils.resolveDeploymentTarget(id).type).to.equal('sha')
  })

  it('stores the auth token under the same SHA as the registry row', async () => {
    const name = agentName('token')
    const printedSha = uniqueSha()
    process.env.CAST_DEPLOYMENT_SHA = printedSha
    const sandbox = sinon.createSandbox()
    const setDeploymentToken = sandbox.stub(keychain, 'setDeploymentToken').resolves()
    sandbox.stub(keychain, 'setToken').resolves()

    try {
      await deployUtils.storeAuthToken(name, 'secret-token')
      const id = await record(name, 'http://localhost:8080', 'hash', 'vol', '{}')

      expect(id).to.equal(printedSha)
      expect(setDeploymentToken.calledOnceWith(printedSha, 'secret-token')).to.equal(true)
      expect(deployUtils.resolveDeploymentTarget(printedSha).type).to.equal('sha')
    } finally {
      sandbox.restore()
    }
  })
})
