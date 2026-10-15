import {expect} from 'chai'
import {execFileSync, spawn, type ChildProcess} from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'

import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {
  castKnownHostsPath,
  digitalOceanHostKeyOptions,
  digitalOceanSshBaseOptions,
  execDigitalOceanSsh,
  forgetDropletHostKey,
  generateEd25519HostKeyPair,
  hasPinnedHostKey,
  recordPinnedHostKey,
  SshHostKeyError,
  syncDropletAddress,
} from '../../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DEPLOY_SOURCES = [
  'typescript/cast-cli/src/lib/deploy/digitalocean.ts',
  'typescript/cast-cli/src/lib/deploy/motd.ts',
  'typescript/cast-cli/src/lib/deploy/upgrades.ts',
  'typescript/cast-cli/src/lib/deploy/ssh-hostkey.ts',
]

function makeKey(dir: string, name: string): {privatePath: string; publicKey: string} {
  const privatePath = path.join(dir, name)
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privatePath, '-C', name])
  const publicKey = fs.readFileSync(`${privatePath}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
  return {privatePath, publicKey}
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to reserve a local port'))
        return
      }
      const {port} = address
      server.close(() => resolve(port))
    })
  })
}

describe('DigitalOcean SSH host key pin', () => {
  let sshDir = ''
  const previous = process.env.CAST_SSH_DIR

  beforeEach(() => {
    sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ssh-hostkey-'))
    process.env.CAST_SSH_DIR = sshDir
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.CAST_SSH_DIR
    else process.env.CAST_SSH_DIR = previous
    fs.rmSync(sshDir, {recursive: true, force: true})
  })

  it('keeps host key checking enabled in every DigitalOcean SSH option list', () => {
    const args = digitalOceanSshBaseOptions()
    const joined = args.join('\n')
    expect(args).to.include('StrictHostKeyChecking=yes')
    expect(args).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
    expect(args).to.include('GlobalKnownHostsFile=/dev/null')
    expect(args).to.include('HostKeyAlgorithms=ssh-ed25519')
    expect(args).to.include('UpdateHostKeys=no')
    expect(joined).to.not.include('StrictHostKeyChecking=no')
    expect(joined).to.not.include('UserKnownHostsFile=/dev/null')
    expect(digitalOceanHostKeyOptions().join('\n')).to.not.include('StrictHostKeyChecking=no')
  })

  it('does not disable host key checking in the DigitalOcean deploy sources', () => {
    for (const rel of DEPLOY_SOURCES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
      expect(text, rel).to.not.include('StrictHostKeyChecking=no')
      expect(text, rel).to.not.include('UserKnownHostsFile=/dev/null')
    }
  })

  it('records one ed25519 line and replaces it when the address is reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-keys-'))
    try {
      const first = makeKey(dir, 'a')
      const second = makeKey(dir, 'b')
      recordPinnedHostKey('203.0.113.10', first.publicKey, '111')
      recordPinnedHostKey('203.0.113.10', second.publicKey, '222')
      const lines = fs.readFileSync(castKnownHostsPath(), 'utf8').trim().split('\n')
      expect(lines).to.deep.equal([`203.0.113.10 ${second.publicKey}`])
      expect(hasPinnedHostKey('203.0.113.10')).to.equal(true)
      const mode = fs.statSync(castKnownHostsPath()).mode & 0o777
      expect(mode).to.equal(0o600)
      const store = JSON.parse(fs.readFileSync(path.join(sshDir, 'droplet-hostkeys.json'), 'utf8'))
      expect(store.droplets['111']).to.equal(undefined)
      expect(store.droplets['222'].publicKey).to.equal(second.publicKey)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('moves the pin when a known droplet gets a new address', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-keys-'))
    try {
      const key = makeKey(dir, 'host')
      recordPinnedHostKey('203.0.113.10', key.publicKey, '42')
      syncDropletAddress('42', '203.0.113.11')
      const text = fs.readFileSync(castKnownHostsPath(), 'utf8')
      expect(text).to.include(`203.0.113.11 ${key.publicKey}`)
      expect(text).to.not.include('203.0.113.10')
      expect(hasPinnedHostKey('203.0.113.11')).to.equal(true)
      expect(hasPinnedHostKey('203.0.113.10')).to.equal(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('forgets the pin when the droplet is destroyed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-keys-'))
    try {
      const key = makeKey(dir, 'host')
      recordPinnedHostKey('203.0.113.12', key.publicKey, '77')
      forgetDropletHostKey('77', '203.0.113.12')
      expect(hasPinnedHostKey('203.0.113.12')).to.equal(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('refuses to record a hostname or a non-ed25519 key', () => {
    expect(() => recordPinnedHostKey('droplet.example', 'ssh-ed25519 AAAA')).to.throw(/non-IPv4/)
    expect(() => recordPinnedHostKey('203.0.113.10', 'ssh-rsa AAAA')).to.throw(/ssh-ed25519/)
    expect(() => recordPinnedHostKey('203.0.113.10\n203.0.113.11 ssh-ed25519 A', 'ssh-ed25519 AAAA')).to.throw(/non-IPv4/)
  })

  it('does not spawn ssh when the host key is not pinned', async () => {
    const execStub = sinon.stub(deployUtils, 'execCommand')
    try {
      await execDigitalOceanSsh('198.51.100.40', 'echo should-not-run')
      expect.fail('should have refused')
    } catch (err) {
      expect(err).to.be.instanceOf(SshHostKeyError)
      expect((err as Error).message).to.include('no pinned SSH host key')
      expect((err as Error).message).to.not.include('StrictHostKeyChecking=no')
    } finally {
      execStub.restore()
    }
    expect(execStub.called).to.equal(false)
  })

  it('reuses the same known_hosts file for a later connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-keys-'))
    const execStub = sinon.stub(deployUtils, 'execCommand').resolves({stdout: 'ok', stderr: '', exitCode: 0})
    try {
      const key = makeKey(dir, 'host')
      recordPinnedHostKey('203.0.113.15', key.publicKey, '9')
      await execDigitalOceanSsh('203.0.113.15', 'echo ok')
      await execDigitalOceanSsh('203.0.113.15', 'echo ok')
      for (const call of execStub.getCalls()) {
        const args = call.args[1] as string[]
        expect(args).to.include('StrictHostKeyChecking=yes')
        expect(args).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
        expect(args.join('\n')).to.not.include('UserKnownHostsFile=/dev/null')
      }
      expect(execStub.callCount).to.equal(2)
    } finally {
      execStub.restore()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('generates a host key pair whose public half can be pinned', () => {
    const pair = generateEd25519HostKeyPair()
    expect(pair.publicKey).to.match(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/)
    expect(pair.privateKey).to.include('BEGIN OPENSSH PRIVATE KEY')
    recordPinnedHostKey('203.0.113.16', pair.publicKey, '5')
    const known = fs.readFileSync(castKnownHostsPath(), 'utf8')
    expect(known).to.include(pair.publicKey)
    expect(known).to.not.include('PRIVATE KEY')
    expect(fs.existsSync(path.join(os.tmpdir(), 'ssh_host_ed25519_key'))).to.equal(false)
  })

  describe('OpenSSH rejects a server that does not present the pin', () => {
    let work = ''
    let sshd: ChildProcess | undefined

    afterEach(() => {
      if (sshd && sshd.exitCode === null && !sshd.killed) {
        sshd.kill('SIGKILL')
      }
      sshd = undefined
      if (work) fs.rmSync(work, {recursive: true, force: true})
      work = ''
    })

    async function startSshd(hostKeyPath: string, userKeyPub: string, port: number): Promise<void> {
      const configPath = path.join(work, 'sshd_config')
      fs.writeFileSync(configPath, [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${hostKeyPath}`,
        `PidFile ${path.join(work, 'sshd.pid')}`,
        `AuthorizedKeysFile ${userKeyPub}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'ChallengeResponseAuthentication no',
        'UsePAM no',
        'PermitRootLogin yes',
        'PubkeyAuthentication yes',
        'StrictModes no',
        '',
      ].join('\n'))
      sshd = spawn('/usr/sbin/sshd', ['-f', configPath, '-D', '-e'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      sshd.stdout?.on('data', (chunk) => { log += chunk.toString() })
      sshd.stderr?.on('data', (chunk) => { log += chunk.toString() })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`sshd did not listen: ${log}`)), 5000)
        const poll = setInterval(() => {
          if (log.includes('Server listening')) {
            clearTimeout(timer)
            clearInterval(poll)
            resolve()
          }
        }, 20)
        sshd!.once('exit', (code) => {
          clearTimeout(timer)
          clearInterval(poll)
          reject(new Error(`sshd exited ${code}: ${log}`))
        })
      })
    }

    function runSsh(port: number, userKey: string, options: string[]): Promise<{stdout: string; stderr: string; code: number}> {
      return new Promise((resolve) => {
        const child = spawn('ssh', [
          '-i', userKey,
          '-o', 'IdentitiesOnly=yes',
          '-p', String(port),
          ...options,
          `${os.userInfo().username}@127.0.0.1`,
          'echo cast-ssh-ok',
        ], {stdio: ['ignore', 'pipe', 'pipe']})
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
        child.on('close', (code) => resolve({stdout, stderr, code: code ?? 1}))
      })
    }

    it('accepts the pinned key and refuses a different key', async function () {
      if (!fs.existsSync('/usr/sbin/sshd')) {
        throw new Error('openssh-server is required to prove host key checking')
      }
      this.timeout(20000)
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-sshd-'))
      const real = makeKey(work, 'real')
      const attacker = makeKey(work, 'attacker')
      const user = makeKey(work, 'user')
      const port = await freePort()
      await startSshd(real.privatePath, `${user.privatePath}.pub`, port)

      recordPinnedHostKey('127.0.0.1', attacker.publicKey, '1')
      const rejected = await runSsh(port, user.privatePath, [
        ...digitalOceanHostKeyOptions(),
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
        '-o', 'ConnectTimeout=5',
      ])
      expect(rejected.code).to.not.equal(0)
      expect(rejected.stderr).to.include('Host key verification failed')
      expect(rejected.stdout).to.not.include('cast-ssh-ok')

      recordPinnedHostKey('127.0.0.1', real.publicKey, '1')
      const accepted = await runSsh(port, user.privatePath, [
        ...digitalOceanHostKeyOptions(),
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
        '-o', 'ConnectTimeout=5',
      ])
      expect(accepted.stderr).to.equal('')
      expect(accepted.stdout).to.include('cast-ssh-ok')
      expect(accepted.code).to.equal(0)
      expect(digitalOceanSshBaseOptions().join('\n')).to.include(castKnownHostsPath())
    })
  })
})
