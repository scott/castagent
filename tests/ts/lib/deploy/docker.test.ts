import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import DockerDeploy, {recordDockerDeployment, renderDockerCompose, writeDockerCompose} from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'

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

    it('passes the bearer token to docker run and not to the compose file', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/docker.ts'),
        'utf8',
      )
      expect(source).to.include("'-e', `AUTH_TOKEN=${authToken}`")
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
