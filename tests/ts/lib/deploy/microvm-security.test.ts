import {expect} from 'chai'
import axios from 'axios'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'

import MicrovmDeploy, {
  doctlChildEnv,
  removeFailedMicrovmArtifacts,
} from '../../../../typescript/cast-cli/src/lib/deploy/microvm'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'

const TOKEN = 'dop_v1_security_token_0123456789abcdef'
const PARENT_TOKEN = 'dop_v1_parent_token_should_not_leak_abcdef'
const TOKEN_ENV_VARS = [
  'DIGITALOCEAN_ACCESS_TOKEN',
  'DIGITALOCEAN_API_TOKEN',
  'DIGITALOCEAN_API_KEY',
  'DIGITALOCEAN_TOKEN',
]

interface SpawnedCommand {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

function expectTokenOffArgv(spawned: SpawnedCommand, token: string): void {
  expect(spawned.command).to.equal('doctl')
  expect(spawned.args).to.not.include('--access-token')
  expect(spawned.args.join('\0')).to.not.include(token)
  expect(spawned.args.join('\0')).to.not.include(PARENT_TOKEN)
  expect(spawned.env?.DIGITALOCEAN_ACCESS_TOKEN).to.equal(token)
}

function volumeConfig(): string {
  return JSON.stringify({
    microvmId: 'vm-1',
    region: 'mkc1',
    ociRef: 'registry.digitalocean.com/cast/cast-security-agent:abc123',
    authMode: 'dual',
    cpu: 1,
    memory: 2048,
    idleTimeout: '15m',
  })
}

describe('MicroVM doctl argv', () => {
  const sourceRoot = path.join(__dirname, '../../../../typescript/cast-cli/src')

  it('does not pass --access-token from deploy, fly, sprite, or ssh sources', () => {
    const files = [
      'lib/deploy/microvm.ts',
      'lib/deploy/digitalocean.ts',
      'lib/deploy/fly.ts',
      'lib/deploy/sprites.ts',
      'lib/deploy/sprites-service.ts',
      'lib/deploy/ssh-hostkey.ts',
      'lib/deploy/upgrades.ts',
      'lib/stop-agent.ts',
    ]
    for (const rel of files) {
      const source = fs.readFileSync(path.join(sourceRoot, rel), 'utf8')
      expect(source, rel).to.not.include('--access-token')
      expect(source, rel).to.not.include("['--token'")
    }
    const microvm = fs.readFileSync(path.join(sourceRoot, 'lib/deploy/microvm.ts'), 'utf8')
    expect(microvm).to.include('DIGITALOCEAN_ACCESS_TOKEN')
    expect(microvm).to.include('assertSecretsNotInArgv')
  })

  it('builds a child environment without mutating the parent', () => {
    const base: NodeJS.ProcessEnv = {PATH: '/usr/bin'}
    const env = doctlChildEnv(TOKEN, base)
    expect(env.DIGITALOCEAN_ACCESS_TOKEN).to.equal(TOKEN)
    expect(env.PATH).to.equal('/usr/bin')
    expect(base.DIGITALOCEAN_ACCESS_TOKEN).to.equal(undefined)
  })

  describe('spawned doctl argv', () => {
    let sandbox: sinon.SinonSandbox
    let previous: Record<string, string | undefined>
    const calls: SpawnedCommand[] = []

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      previous = {}
      for (const name of TOKEN_ENV_VARS) {
        previous[name] = process.env[name]
        delete process.env[name]
      }
      calls.length = 0
      sandbox.stub(console, 'log')
      sandbox.stub(console, 'warn')
      sandbox.stub(axios, 'get').resolves({status: 200, data: {microvms: []}})
      sandbox.stub(axios, 'delete').resolves({status: 204, data: ''})
      sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args: string[] = [], options?: {env?: NodeJS.ProcessEnv}) => {
        calls.push({command, args, env: options?.env})
        return {exitCode: 0, stdout: '', stderr: ''}
      })
    })

    afterEach(() => {
      sandbox.restore()
      for (const name of TOKEN_ENV_VARS) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
    })

    it('passes an explicit token through the child environment', async () => {
      process.env.DIGITALOCEAN_ACCESS_TOKEN = PARENT_TOKEN
      await removeFailedMicrovmArtifacts({
        token: TOKEN,
        ociRef: 'registry.digitalocean.com/cast/cast-security-agent:abc123',
        agentName: 'security-agent',
        removeTokens: false,
      })
      expect(calls).to.have.length(1)
      expectTokenOffArgv(calls[0], TOKEN)
      expect(calls[0].args).to.include.members([
        'registry', 'repository', 'delete-tag', 'cast-security-agent', 'abc123', '--force',
      ])
      expect(process.env.DIGITALOCEAN_ACCESS_TOKEN).to.equal(PARENT_TOKEN)
    })

    it('passes a doctl config token through the child environment on shutdown', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-doctl-env-'))
      const previousHome = process.env.HOME
      process.env.HOME = home
      fs.mkdirSync(path.join(home, '.config', 'doctl'), {recursive: true})
      fs.writeFileSync(path.join(home, '.config', 'doctl', 'config.yaml'), `access-token: ${TOKEN}\n`, {mode: 0o600})
      sandbox.stub(db, 'listDeployments').returns([{
        id: 'abc123',
        provider: 'microvm',
        volume_id: 'vm-1',
        volume_config: volumeConfig(),
      }])
      try {
        await MicrovmDeploy.destroy('security-agent')
      } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        fs.rmSync(home, {recursive: true, force: true})
      }
      expect(calls.length).to.be.at.least(2)
      for (const spawned of calls) expectTokenOffArgv(spawned, TOKEN)
      expect(calls.some(spawned => spawned.args.includes('vm-1') && spawned.args.includes('delete'))).to.equal(true)
      expect(calls.some(spawned => spawned.args.includes('delete-tag') && spawned.args.includes('abc123'))).to.equal(true)
      expect(process.env.DIGITALOCEAN_ACCESS_TOKEN).to.equal(undefined)
    })
  })
})
