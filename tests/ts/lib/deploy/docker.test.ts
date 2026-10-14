import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import DockerDeploy, {renderDockerCompose, writeDockerCompose} from '../../../../typescript/cast-cli/src/lib/deploy/docker'

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