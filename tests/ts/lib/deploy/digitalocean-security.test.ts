import {expect} from 'chai'
import {EventEmitter} from 'events'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'

import {
  DROPLET_CLOSE_PUBLIC_PORT,
  DROPLET_ENV_INSTALL_COMMAND,
  assertDropletDockerRunIsPrivate,
  buildDropletDockerRunCommand,
  buildDropletEnvFile,
  buildDropletTunnelArgs,
  dropletDeploymentUrl,
  dropletHostFromUrl,
  isLoopbackClientUrl,
  startDropletSshTunnel,
} from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import {digitaloceanProvider} from '../../../../typescript/cast-cli/src/lib/deploy/providers/digitalocean'
import * as droplet from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import {generateEd25519HostKeyPair, recordPinnedHostKey} from '../../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'

const SECRET = 'test-bearer-token'
const INFERENCE = 'test-inference-key'

describe('DigitalOcean droplet exposure', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/digitalocean.ts'),
    'utf8',
  )

  it('does not record a public http URL or publish port 8080', () => {
    const upgradeSource = fs.readFileSync(
      path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/upgrades.ts'),
      'utf8',
    )
    expect(upgradeSource).to.include('privateSsh: true')
    expect(dropletDeploymentUrl('203.0.113.10')).to.equal('https://203.0.113.10')
    expect(dropletDeploymentUrl('203.0.113.10')).to.not.include(':8080')
    expect(dropletDeploymentUrl('203.0.113.10').startsWith('https://')).to.equal(true)
    expect(source).to.not.include('http://${droplet.ip}:8080')
    expect(source).to.not.include('-p 8080:8080')
    expect(source).to.not.include('-e AUTH_TOKEN=')
    expect(source).to.not.include('ufw allow 8080/tcp')
  })

  it('closes a previous public allow and writes secrets only to a 0600 file', () => {
    expect(DROPLET_CLOSE_PUBLIC_PORT).to.include('delete allow 8080/tcp')
    expect(DROPLET_CLOSE_PUBLIC_PORT).to.not.match(/ufw allow 8080/)
    expect(DROPLET_ENV_INSTALL_COMMAND).to.include('umask 077')
    expect(DROPLET_ENV_INSTALL_COMMAND).to.include('chmod 0700')
    expect(DROPLET_ENV_INSTALL_COMMAND).to.include('chmod 0600')
    expect(DROPLET_ENV_INSTALL_COMMAND).to.include('/var/lib/cast/cast-agent.env')
    expect(DROPLET_ENV_INSTALL_COMMAND).to.not.include(SECRET)
    expect(DROPLET_ENV_INSTALL_COMMAND).to.not.include('AUTH_TOKEN')
  })

  it('puts the bearer token in the env file and not on the docker command', () => {
    const envFile = buildDropletEnvFile({
      CAST_AGENT_NAME: 'email-agent',
      AUTH_TOKEN: SECRET,
      OPENROUTER_API_KEY: INFERENCE,
      CAST_MOTD: 'Y2FzdA==',
    })
    expect(envFile).to.include(`AUTH_TOKEN=${SECRET}`)
    expect(envFile).to.include(`OPENROUTER_API_KEY=${INFERENCE}`)

    const command = buildDropletDockerRunCommand('cast-email-agent-memory', 'cast-email-agent:latest')
    expect(command).to.include('-p 127.0.0.1:8080:8080')
    expect(command).to.include('--env-file /var/lib/cast/cast-agent.env')
    expect(command).to.not.include(SECRET)
    expect(command).to.not.include(INFERENCE)
    expect(command).to.not.include('AUTH_TOKEN')
    expect(command).to.not.match(/(^|\s)-p\s+8080:8080(\s|$)/)
    assertDropletDockerRunIsPrivate(command, [SECRET, INFERENCE])
  })

  it('rejects the old public docker publish and a secret on the command line', () => {
    const leaked = 'docker run -d --name cast-agent -p 8080:8080 -e AUTH_TOKEN=test-bearer-token cast-email-agent:latest'
    expect(() => assertDropletDockerRunIsPrivate(leaked, [SECRET])).to.throw(/public port/)
    const loopbackButLeaked = 'docker run -d -p 127.0.0.1:8080:8080 -e AUTH_TOKEN=test-bearer-token img'
    expect(() => assertDropletDockerRunIsPrivate(loopbackButLeaked, [SECRET])).to.throw(/secret/)
  })

  it('refuses shell metacharacters in the remote docker command', () => {
    expect(() => buildDropletDockerRunCommand('vol;id', 'cast-email-agent:latest')).to.throw(/volume id/)
    expect(() => buildDropletEnvFile({AUTH_TOKEN: 'line1\nAUTH_TOKEN=other'})).to.throw(/newline/)
  })

  it('tunnels cast connect to droplet loopback and does not use the public URL', () => {
    expect(dropletHostFromUrl('http://203.0.113.10:8080')).to.equal('203.0.113.10')
    expect(dropletHostFromUrl('https://203.0.113.10')).to.equal('203.0.113.10')
    const args = buildDropletTunnelArgs('203.0.113.10', 18080)
    const forward = args[args.indexOf('-L') + 1]
    expect(forward).to.equal('127.0.0.1:18080:127.0.0.1:8080')
    expect(args).to.include('-N')
    expect(args).to.include('ExitOnForwardFailure=yes')
    expect(args).to.include('StrictHostKeyChecking=yes')
    expect(args).to.include('HostKeyAlgorithms=ssh-ed25519')
    expect(args).to.include('root@203.0.113.10')
    expect(args.join(' ')).to.not.include('StrictHostKeyChecking=no')
    expect(args.join(' ')).to.not.include('UserKnownHostsFile=/dev/null')
    expect(args.join(' ')).to.not.include(SECRET)
    expect(args.join(' ')).to.not.include('8080:8080')
    expect(args.join(' ')).to.not.include('http://203.0.113.10')
    expect(isLoopbackClientUrl('http://127.0.0.1:18080')).to.equal(true)
    expect(isLoopbackClientUrl('http://203.0.113.10:8080')).to.equal(false)
    expect(isLoopbackClientUrl('https://203.0.113.10')).to.equal(false)
  })

  describe('startDropletSshTunnel', () => {
    let sandbox: sinon.SinonSandbox
    let sshDir = ''
    let previousSshDir: string | undefined

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ssh-'))
      previousSshDir = process.env.CAST_SSH_DIR
      process.env.CAST_SSH_DIR = sshDir
    })

    afterEach(() => {
      sandbox.restore()
      if (previousSshDir === undefined) delete process.env.CAST_SSH_DIR
      else process.env.CAST_SSH_DIR = previousSshDir
      if (sshDir) fs.rmSync(sshDir, {recursive: true, force: true})
      sshDir = ''
    })

    it('spawns ssh to loopback and returns a loopback client URL', async () => {
      const pair = generateEd25519HostKeyPair()
      recordPinnedHostKey('203.0.113.10', pair.publicKey)
      const stderr = new EventEmitter()
      const kill = sandbox.stub()
      const servers: net.Server[] = []
      const spawnStub = sandbox.stub(require('child_process'), 'spawn').callsFake((...spawnArgs: unknown[]) => {
        const args = spawnArgs[1] as string[]
        const forward = args[args.indexOf('-L') + 1]
        const port = Number(forward.split(':')[1])
        const server = net.createServer()
        servers.push(server)
        server.listen(port, '127.0.0.1')
        return {
          stderr,
          stdout: new EventEmitter(),
          exitCode: null,
          killed: false,
          kill,
        }
      })

      try {
        const tunnel = await startDropletSshTunnel('203.0.113.10', () => {})
        expect(tunnel.url).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(tunnel.url).to.not.include('203.0.113.10')
        const sshCall = spawnStub.getCalls().find(call => call.args[0] === 'ssh')
        expect(sshCall, 'ssh should be spawned').to.exist
        const args = sshCall!.args[1] as string[]
        expect(args.join(' ')).to.include('127.0.0.1:')
        expect(args.join(' ')).to.include(':127.0.0.1:8080')
        expect(args).to.include('StrictHostKeyChecking=yes')
        expect(args.join(' ')).to.not.include('StrictHostKeyChecking=no')
        expect(args.join(' ')).to.not.include(SECRET)
        expect(args.join(' ')).to.not.include('http://')
        expect(sshCall!.args[2]).to.deep.include({stdio: ['ignore', 'pipe', 'pipe']})
        tunnel.process.kill()
      } finally {
        await Promise.all(servers.map(server => new Promise<void>(resolve => {
          server.close(() => resolve())
        })))
      }
    })

    it('refuses an unpinned host before spawning ssh', async () => {
      const spawnStub = sandbox.stub(require('child_process'), 'spawn')
      try {
        await startDropletSshTunnel('198.51.100.77', () => {})
        expect.fail('should have refused')
      } catch (error: any) {
        expect(error.message).to.include('no pinned SSH host key')
        expect(error.message).to.include('198.51.100.77')
      }
      expect(spawnStub.called).to.equal(false)
    })
  })

  describe('digitalocean provider connect', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
    })

    afterEach(() => {
      sandbox.restore()
    })

    function ctx(url: string, overrides?: {error?: (message: string) => never}) {
      return {
        agentName: 'email-agent',
        deployment: {
          id: 'abc123',
          agent_name: 'email-agent',
          provider: 'digitalocean',
          deployment_url: url,
        },
        url,
        token: SECRET,
        log: () => {},
        warn: () => {},
        error: overrides?.error ?? ((message: string): never => {
          throw new Error(message)
        }),
      }
    }

    it('returns the tunnel URL for a legacy public http deployment and does not pass the token', async () => {
      const kill = sandbox.stub()
      const stub = sandbox.stub(droplet, 'startDropletSshTunnel').resolves({
        url: 'http://127.0.0.1:18080',
        process: {kill} as any,
      })
      const result = await digitaloceanProvider.connect!(ctx('http://203.0.113.10:8080'))
      expect(result?.url).to.equal('http://127.0.0.1:18080')
      expect(stub.firstCall.args[0]).to.equal('203.0.113.10')
      expect(JSON.stringify(stub.firstCall.args)).to.not.include(SECRET)
      expect(result?.url).to.not.include('203.0.113.10')
    })

    it('does not fall back to the public URL when the tunnel fails', async () => {
      sandbox.stub(droplet, 'startDropletSshTunnel').rejects(new Error('ssh failed'))
      try {
        await digitaloceanProvider.connect!(ctx('https://203.0.113.10'))
        expect.fail('connect should have refused')
      } catch (error: any) {
        expect(error.message).to.include('SSH tunnel')
        expect(error.message).to.include('will not send the bearer token')
        expect(error.message).to.not.include(SECRET)
        expect(error.message).to.not.include('http://203.0.113.10:8080')
      }
    })

    it('refuses a tunnel result that is still a public URL', async () => {
      const kill = sandbox.stub()
      sandbox.stub(droplet, 'startDropletSshTunnel').resolves({
        url: 'http://203.0.113.10:8080',
        process: {kill} as any,
      })
      try {
        await digitaloceanProvider.connect!(ctx('https://203.0.113.10'))
        expect.fail('connect should have refused')
      } catch (error: any) {
        expect(error.message).to.include('public URL')
        expect(error.message).to.not.include(SECRET)
      }
      expect(kill.called).to.equal(true)
    })
  })
})
