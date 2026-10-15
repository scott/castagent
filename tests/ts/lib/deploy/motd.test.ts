import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import {buildHostMotd, buildProfileSnippet, writeHostMotdOverSsh} from '../../../../typescript/cast-cli/src/lib/deploy/motd'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {castKnownHostsPath, recordPinnedHostKey} from '../../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'

describe('buildHostMotd', () => {
  const baseCtx = {
    agentName: 'email-agent',
    dropletIp: '203.0.113.1',
    a2aUrl: 'http://203.0.113.1:8080',
  }

  it('includes cast-tui instructions when onHostTui is true', () => {
    const motd = buildHostMotd({...baseCtx, onHostTui: true})
    expect(motd).to.include('cast-tui')
    expect(motd).to.include('docker exec -it cast-agent bash')
    expect(motd).to.include('To chat with this agent:')
  })

  it('omits cast-tui when onHostTui is false', () => {
    const motd = buildHostMotd({...baseCtx, onHostTui: false})
    expect(motd).to.not.include('cast-tui')
    expect(motd).to.not.include('docker exec -it cast-agent bash')
    // The A2A URL is still advertised (it's the only way to talk to
    // the agent when the TUI is not bundled).
    expect(motd).to.include('A2A: http://203.0.113.1:8080')
    // And the user is pointed at the A2A API.
    expect(motd).to.include('Talk to this agent via the A2A API')
    expect(motd).to.include('curl http://203.0.113.1:8080/')
  })

  it('omits cast-tui when onHostTui is undefined (safe default)', () => {
    // The default must be "don't advertise" rather than "do advertise"
    // — we'd rather under-promise than tell users to run a command
    // that doesn't exist.
    const motd = buildHostMotd({...baseCtx})
    expect(motd).to.not.include('cast-tui')
    expect(motd).to.not.include('docker exec -it cast-agent bash')
  })

  it('still includes the version line when onHostTui is true', () => {
    const motd = buildHostMotd({...baseCtx, onHostTui: true, deployedVersion: '1.2.3'})
    expect(motd).to.include('v1.2.3')
    expect(motd).to.include('cast-tui')
  })

  it('still includes the version line when onHostTui is false', () => {
    const motd = buildHostMotd({...baseCtx, onHostTui: false, deployedVersion: '1.2.3'})
    expect(motd).to.include('v1.2.3')
    expect(motd).to.not.include('cast-tui')
  })

  it('always shows the log tail command regardless of TUI presence', () => {
    const withTui = buildHostMotd({...baseCtx, onHostTui: true})
    const withoutTui = buildHostMotd({...baseCtx, onHostTui: false})
    expect(withTui).to.include('docker logs -f cast-agent')
    expect(withoutTui).to.include('docker logs -f cast-agent')
  })
})

describe('buildProfileSnippet', () => {
  const baseCtx = {
    agentName: 'email-agent',
    dropletIp: '203.0.113.1',
    a2aUrl: 'http://203.0.113.1:8080',
  }

  it('includes the cast-tui hint when onHostTui is true', () => {
    const snippet = buildProfileSnippet({...baseCtx, onHostTui: true})
    expect(snippet).to.include('cast-tui')
    expect(snippet).to.include('docker exec -it cast-agent bash')
  })

  it('omits the cast-tui hint when onHostTui is false', () => {
    const snippet = buildProfileSnippet({...baseCtx, onHostTui: false})
    expect(snippet).to.not.include('cast-tui')
    // The agent name + A2A URL are still shown so users can connect.
    expect(snippet).to.include('A2A: http://203.0.113.1:8080')
    expect(snippet).to.include('email-agent')
  })

  it('omits the cast-tui hint when onHostTui is undefined (safe default)', () => {
    const snippet = buildProfileSnippet({...baseCtx})
    expect(snippet).to.not.include('cast-tui')
  })

  it('uses A2A API hint instead of docker-exec when TUI is absent', () => {
    const snippet = buildProfileSnippet({...baseCtx, onHostTui: false})
    // Should not tell users to run docker exec + cast-tui (cast-tui
    // doesn't exist). Instead, point them at the A2A URL.
    expect(snippet).to.include('A2A')
    expect(snippet).to.include('http://203.0.113.1:8080')
  })
})

describe('writeHostMotdOverSsh', () => {
  let sshDir = ''
  let pinnedPublicKey = ''

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-motd-pin-'))
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k'), '-C', 'test'])
      pinnedPublicKey = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  beforeEach(() => {
    sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-motd-ssh-'))
    process.env.CAST_SSH_DIR = sshDir
  })

  afterEach(() => {
    delete process.env.CAST_SSH_DIR
    fs.rmSync(sshDir, {recursive: true, force: true})
  })

  it('uses the pinned known_hosts file for both writes', async () => {
    recordPinnedHostKey('203.0.113.1', pinnedPublicKey)
    const execStub = sinon.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
    try {
      await writeHostMotdOverSsh('203.0.113.1', {
        agentName: 'email-agent',
        dropletIp: '203.0.113.1',
      })
      expect(execStub.callCount).to.equal(2)
      for (const call of execStub.getCalls()) {
        const args = call.args[1] as string[]
        expect(args).to.include('StrictHostKeyChecking=yes')
        expect(args).to.include(`UserKnownHostsFile=${castKnownHostsPath()}`)
        expect(args.join('\n')).to.not.include('StrictHostKeyChecking=no')
        expect(args.join('\n')).to.not.include('UserKnownHostsFile=/dev/null')
      }
    } finally {
      execStub.restore()
    }
  })

  it('does not ssh when the host key is not pinned', async () => {
    const execStub = sinon.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
    try {
      await writeHostMotdOverSsh('198.51.100.31', {
        agentName: 'email-agent',
        dropletIp: '198.51.100.31',
      })
      expect.fail('should have refused')
    } catch (err) {
      expect((err as Error).message).to.include('no pinned SSH host key')
    } finally {
      execStub.restore()
    }
    expect(execStub.called).to.equal(false)
  })
})
