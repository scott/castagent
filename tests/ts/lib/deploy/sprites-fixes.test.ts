import {expect} from 'chai'
import {spawnSync} from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {gunzipSync} from 'zlib'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'
import {db} from '../../../../typescript/cast-cli/src/lib/sqlite'
import {type InferenceCatalogEntry} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {collectRuntimeLogs} from '../../../../typescript/cast-cli/src/lib/runtime-logs'
import SpritesDeploy, {
  cleanupRecordedSpriteMemory,
  deployToSprites,
  recordedHostMemoryPaths,
  spriteMemoryConfig,
} from '../../../../typescript/cast-cli/src/lib/deploy/sprites'
import {
  parseSpriteServiceProbe,
  redactSpriteSecrets,
  spriteCliEnv,
  SPRITE_SERVICE_LOG,
} from '../../../../typescript/cast-cli/src/lib/deploy/sprites-service'

const TOKEN = 'org-slug/org-id/token-id/not-a-real-sprites-token'
const MODEL_KEY = 'sk-test-openrouter'
const OTHER_KEY = 'sk-other-provider-key'
const OPENROUTER_CATALOG: InferenceCatalogEntry[] = [{
  key: 'openrouter',
  name: 'OpenRouter',
  default: true,
  prefixes: ['openrouter'],
  envVar: 'OPENROUTER_API_KEY',
  configKey: 'providers.openrouter.apiKey',
  baseUrl: 'https://openrouter.ai/api/v1',
  acceptsAnyModel: true,
}]

function writeMockSprite(dir: string): void {
  const sprite = path.join(dir, 'sprite')
  const source = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const command = String(args[args.length - 1] || '')
const waitStdin = command.includes('base64 -d') || command.includes('tee ')

function record(extra) {
  const log = process.env.SPRITE_MOCK_LOG
  if (!log) return
  fs.appendFileSync(log, JSON.stringify({
    argv: args,
    spriteToken: process.env.SPRITE_TOKEN || '',
    ...extra,
  }) + '\\n')
}

function respond(stdin) {
  const joined = args.join(' ')
  if (stdin && command.includes('base64 -d') && process.env.SPRITE_MOCK_TAR) {
    fs.writeFileSync(process.env.SPRITE_MOCK_TAR, stdin)
  }
  if (stdin && command.includes('tee ') && process.env.SPRITE_MOCK_SCRIPT) {
    fs.writeFileSync(process.env.SPRITE_MOCK_SCRIPT, stdin)
  }
  record({stdinBytes: stdin ? stdin.length : 0})

  if (args[0] === '--version' || args.includes('--version')) {
    process.stdout.write('sprite test\\n')
    process.exit(0)
  }
  if (args[0] === 'list') {
    if (!process.env.SPRITE_TOKEN) {
      process.stderr.write("Error: no organizations configured. Run 'sprite login' to authenticate\\n")
      process.exit(1)
    }
    process.stdout.write('ok\\n')
    process.exit(0)
  }
  if (args[0] === 'create') {
    if (process.env.SPRITE_MOCK_CREATE === 'fail') {
      process.stderr.write('Error: no organizations configured. Run \\'sprite login\\' to authenticate\\n')
      process.exit(1)
    }
    if (process.env.SPRITE_MOCK_CREATE === 'exists') {
      process.stderr.write('sprite already exists\\n')
      process.exit(1)
    }
    process.exit(0)
  }
  if (args[0] === 'destroy') {
    if (process.env.SPRITE_MOCK_DESTROY === 'fail') {
      process.stderr.write('destroy failed\\n')
      process.exit(1)
    }
    process.exit(0)
  }
  if (args[0] === 'url') {
    process.stdout.write('URL: https://cast-demo.sprites.app\\nAuth: sprite\\n')
    process.exit(0)
  }
  if (args[0] === 'exec') {
    if (args[args.length - 2] === 'echo' && args[args.length - 1] === 'ready') {
      process.stdout.write('ready\\n')
      process.exit(0)
    }
    if (command.includes('pip install') && process.env.SPRITE_MOCK_PIP === 'fail') {
      process.stderr.write('ERROR: Could not open requirements file: /opt/cast-agent/requirements.txt\\n')
      process.exit(1)
    }
    if (command.includes('---CAST-LOG---') || command.includes('services get cast-agent')) {
      const mode = process.env.SPRITE_MOCK_HEALTH || 'ready'
      if (mode === 'crash') {
        process.stdout.write('{"status":"running"}\\n---CAST-LOG---\\nModuleNotFoundError: No module named \\'cast\\'\\n')
      } else if (mode === 'down') {
        process.stdout.write('{"status":"stopped"}\\n---CAST-LOG---\\n')
      } else {
        process.stdout.write('{"status":"running"}\\n---CAST-LOG---\\nAgent ready on port 8080\\n')
      }
      process.exit(0)
    }
    if (args.includes('cat') && joined.includes('/.sprite/logs/services/cast-agent.log')) {
      process.stdout.write('Agent ready on port 8080\\n')
      process.exit(0)
    }
    process.exit(0)
  }
  process.stderr.write('unexpected sprite args\\n')
  process.exit(1)
}

if (!waitStdin) {
  respond('')
} else {
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk))
  process.stdin.on('end', () => respond(Buffer.concat(chunks).toString('utf8')))
  process.stdin.on('error', () => respond(''))
}
`
  fs.writeFileSync(sprite, source)
  fs.chmodSync(sprite, 0o755)
  const sudo = path.join(dir, 'sudo')
  fs.writeFileSync(sudo, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SUDO_CALLS"\nexit 99\n')
  fs.chmodSync(sudo, 0o755)
}

interface MockEnv {
  dir: string
  log: string
  tar: string
  script: string
  sudoLog: string
  home: string
  agentName: string
  sha: string
}

function readCalls(log: string): Array<{argv: string[]; spriteToken: string}> {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

function assertTokenStaysOffArgv(log: string): void {
  const calls = readCalls(log)
  expect(calls.length).to.be.greaterThan(0)
  for (const call of calls) {
    expect(call.argv.join('\n')).to.not.include(TOKEN)
    expect(call.argv).to.not.include('--token')
    expect(call.spriteToken).to.equal(TOKEN)
  }
}

describe('Sprites deploy fixes', () => {
  const saved = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SPRITES_TOKEN: process.env.SPRITES_TOKEN,
    SPRITE_TOKEN: process.env.SPRITE_TOKEN,
    CAST_DEPLOYMENT_SHA: process.env.CAST_DEPLOYMENT_SHA,
    SPRITE_MOCK_LOG: process.env.SPRITE_MOCK_LOG,
    SPRITE_MOCK_TAR: process.env.SPRITE_MOCK_TAR,
    SPRITE_MOCK_SCRIPT: process.env.SPRITE_MOCK_SCRIPT,
    SPRITE_MOCK_CREATE: process.env.SPRITE_MOCK_CREATE,
    SPRITE_MOCK_DESTROY: process.env.SPRITE_MOCK_DESTROY,
    SPRITE_MOCK_PIP: process.env.SPRITE_MOCK_PIP,
    SPRITE_MOCK_HEALTH: process.env.SPRITE_MOCK_HEALTH,
    SUDO_CALLS: process.env.SUDO_CALLS,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function setup(label: string): MockEnv {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cast-sprite-${label}-`))
    const home = path.join(dir, 'home')
    fs.mkdirSync(home, {recursive: true})
    writeMockSprite(dir)
    const env: MockEnv = {
      dir,
      log: path.join(dir, 'calls.ndjson'),
      tar: path.join(dir, 'upload.b64'),
      script: path.join(dir, 'start.sh'),
      sudoLog: path.join(dir, 'sudo.txt'),
      home,
      agentName: `spr${label}${crypto.randomBytes(2).toString('hex')}`.replace(/[^a-z0-9-]/g, '').slice(0, 24),
      sha: crypto.randomBytes(3).toString('hex'),
    }
    const agentDir = path.join(home, '.cast', 'agents', env.agentName)
    fs.mkdirSync(agentDir, {recursive: true})
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'description: sprite fix test\n')
    process.env.HOME = home
    process.env.PATH = `${dir}${path.delimiter}${saved.PATH || ''}`
    process.env.SPRITES_TOKEN = TOKEN
    delete process.env.SPRITE_TOKEN
    process.env.CAST_DEPLOYMENT_SHA = env.sha
    process.env.SPRITE_MOCK_LOG = env.log
    process.env.SPRITE_MOCK_TAR = env.tar
    process.env.SPRITE_MOCK_SCRIPT = env.script
    process.env.SUDO_CALLS = env.sudoLog
    delete process.env.SPRITE_MOCK_CREATE
    delete process.env.SPRITE_MOCK_DESTROY
    delete process.env.SPRITE_MOCK_PIP
    delete process.env.SPRITE_MOCK_HEALTH
    return env
  }

  function cleanup(env: MockEnv): void {
    try {
      db.removeDeploymentBySha(env.sha)
    } catch {
      // The row was not recorded.
    }
    fs.rmSync(env.dir, {recursive: true, force: true})
  }

  const deployOptions = {
    serviceEnv: () => ({OPENROUTER_API_KEY: MODEL_KEY, OTHER_PROVIDER_API_KEY: OTHER_KEY}),
    inferenceCatalog: OPENROUTER_CATALOG,
    healthTimeoutMs: 1_000,
    healthIntervalMs: 10,
    sleep: async () => {},
  }

  async function deploy(env: MockEnv): Promise<{logs: string[]; error?: string}> {
    const logs: string[] = []
    try {
      await deployToSprites(env.agentName, {
        log: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      }, deployOptions)
      return {logs}
    } catch (error) {
      return {logs, error: error instanceof Error ? error.message : String(error)}
    }
  }

  it('copies SPRITES_TOKEN onto SPRITE_TOKEN and redacts it', () => {
    const env = spriteCliEnv({SPRITES_TOKEN: TOKEN, PATH: '/usr/bin'})
    expect(env.SPRITE_TOKEN).to.equal(TOKEN)
    expect(spriteCliEnv({SPRITE_TOKEN: 'already-set', SPRITES_TOKEN: TOKEN}).SPRITE_TOKEN).to.equal('already-set')
    expect(redactSpriteSecrets(`failed ${TOKEN}`, {SPRITES_TOKEN: TOKEN})).to.equal('failed [redacted]')
    expect(parseSpriteServiceProbe('{"status":"running"}\n---CAST-LOG---\nAgent ready on port 8080\n')).to.deep.equal({
      status: 'running',
      logs: 'Agent ready on port 8080\n',
    })
  })

  it('authenticates the sprite CLI from SPRITES_TOKEN without putting the token on argv', async () => {
    const env = setup('auth')
    try {
      const result = await deploy(env)
      expect(result.error, result.logs.join('\n')).to.equal(undefined)
      assertTokenStaysOffArgv(env.log)
      expect(result.logs.join('\n')).to.not.include(TOKEN)
      expect(fs.existsSync(env.sudoLog)).to.equal(false)
      const script = fs.readFileSync(env.script, 'utf8')
      expect(script).to.include(`export OPENROUTER_API_KEY='${MODEL_KEY}'`)
      expect(script).to.not.include(OTHER_KEY)
      expect(script).to.include('export AUTH_TOKEN=')
      const joined = readCalls(env.log).map(call => call.argv.join('\n')).join('\n')
      expect(joined).to.not.include(MODEL_KEY)
      expect(joined).to.not.include(OTHER_KEY)
      expect(joined).to.not.include('AUTH_TOKEN=')
    } finally {
      cleanup(env)
    }
  })

  it('ships requirements.txt and the cast package, then prints the service log path', async () => {
    const env = setup('ship')
    try {
      const result = await deploy(env)
      expect(result.error, result.logs.join('\n')).to.equal(undefined)
      const agentDir = path.join(env.home, '.cast', 'agents', env.agentName)
      expect(fs.existsSync(path.join(agentDir, 'requirements.txt'))).to.equal(true)
      expect(fs.existsSync(path.join(agentDir, '.cast-runtime', 'cast', 'runtime.py'))).to.equal(true)
      const uploaded = gunzipSync(Buffer.from(fs.readFileSync(env.tar, 'utf8'), 'base64'))
      expect(uploaded.includes(Buffer.from('requirements.txt'))).to.equal(true)
      expect(uploaded.includes(Buffer.from('.cast-runtime/cast/runtime.py'))).to.equal(true)
      const commands = readCalls(env.log).map(call => call.argv.join(' '))
      expect(commands.some(command => command.includes('pip install -r /opt/cast-agent/requirements.txt'))).to.equal(true)
      expect(commands.some(command => command.includes('chmod 777'))).to.equal(false)
      expect(commands.some(command => command.includes('/mnt/cast-memory'))).to.equal(false)
      expect(commands.some(command => command.includes('apt-get install -y python3 python3-pip python3-venv git'))).to.equal(true)
      const text = result.logs.join('\n')
      expect(text).to.include('Sprites Deployment Successful!')
      expect(text).to.include(`cast connect ${env.agentName}`)
      expect(text).to.include('not a direct agent URL')
      expect(text).to.include('302')
      expect(text).to.include('https://cast-demo.sprites.app')
      expect(text).to.not.match(/^URL:/m)
      expect(text).to.include(`sprite exec -s cast-${env.agentName} -- cat ${SPRITE_SERVICE_LOG}`)
      expect(text).to.not.include('/opt/cast-agent/agent.log')
      const row = db.getDeploymentBySha(env.sha)
      expect(row.provider).to.equal('sprites')
      const volume = JSON.parse(row.volume_config)
      expect(volume.mountPath).to.equal('/opt/cast-agent/memory')
      expect(volume.hostPath).to.equal(undefined)
      expect(row.volume_id).to.equal(`cast-${env.agentName}-memory`)
      expect(spriteMemoryConfig(volume.deploymentId)).to.equal(row.volume_config)

      const logs = await collectRuntimeLogs(env.agentName)
      expect(logs.status).to.equal('ok')
      expect(logs.text).to.include('Agent ready on port 8080')
      const logCall = readCalls(env.log).find(call => call.argv.includes('cat'))
      expect(logCall?.argv).to.include(SPRITE_SERVICE_LOG)
    } finally {
      cleanup(env)
    }
  })

  it('removes the token file when sprite create fails and does not destroy a sprite', async () => {
    const env = setup('create')
    process.env.SPRITE_MOCK_CREATE = 'fail'
    try {
      const result = await deploy(env)
      expect(result.error || '').to.include('Failed to create sprite')
      expect(result.logs.join('\n')).to.not.include('Sprites Deployment Successful!')
      expect(readCalls(env.log).some(call => call.argv[0] === 'destroy')).to.equal(false)
      expect(await keychain.getDeploymentToken(env.sha)).to.equal(null)
      const tokenFile = path.join(env.home, '.cast', 'tokens', 'deployments', `${env.sha}.token`)
      expect(fs.existsSync(tokenFile)).to.equal(false)
      expect(db.getDeploymentBySha(env.sha)).to.equal(undefined)
    } finally {
      cleanup(env)
    }
  })

  it('destroys a sprite it created when a later step fails', async () => {
    const env = setup('pip')
    process.env.SPRITE_MOCK_PIP = 'fail'
    try {
      const result = await deploy(env)
      expect(result.error || '').to.include('requirements')
      expect(result.logs.join('\n')).to.include(`Removed sprite 'cast-${env.agentName}' after the deploy failed.`)
      expect(readCalls(env.log).some(call => call.argv[0] === 'destroy' && call.argv.includes(`cast-${env.agentName}`))).to.equal(true)
      expect(await keychain.getDeploymentToken(env.sha)).to.equal(null)
      expect(db.getDeploymentBySha(env.sha)).to.equal(undefined)
      expect(result.logs.join('\n')).to.not.include('Successful')
    } finally {
      cleanup(env)
    }
  })

  it('fails the deploy when the service never becomes ready', async () => {
    const env = setup('health')
    process.env.SPRITE_MOCK_HEALTH = 'crash'
    try {
      const result = await deploy(env)
      expect(result.error || '').to.include('failed before the runtime was ready')
      expect(result.error || '').to.include(SPRITE_SERVICE_LOG)
      expect(result.error || '').to.include('No module named')
      expect(result.logs.join('\n')).to.not.include('Sprites Deployment Successful!')
      expect(result.logs.join('\n')).to.include('Removed sprite')
      expect(db.getDeploymentBySha(env.sha)).to.equal(undefined)
      expect(await keychain.getDeploymentToken(env.sha)).to.equal(null)
    } finally {
      cleanup(env)
    }
  })

  it('records the sprite when rollback cannot delete it and keeps the token', async () => {
    const env = setup('keep')
    process.env.SPRITE_MOCK_PIP = 'fail'
    process.env.SPRITE_MOCK_DESTROY = 'fail'
    try {
      const result = await deploy(env)
      expect(result.error || '').to.include('requirements')
      expect(result.logs.join('\n')).to.include(`cast shutdown ${env.agentName}`)
      const row = db.getDeploymentBySha(env.sha)
      expect(row?.provider).to.equal('sprites')
      expect(await keychain.getDeploymentToken(env.sha)).to.be.a('string')
    } finally {
      await keychain.deleteDeploymentToken(env.sha)
      await keychain.deleteToken(env.agentName)
      cleanup(env)
    }
  })

  it('removes the recorded host memory path and does not invent a new one', async () => {
    const env = setup('mem')
    const root = path.join(env.dir, 'mnt')
    fs.mkdirSync(root)
    const right = path.posix.join(root, `cast-${env.agentName}-11111111-1111-1111-1111-111111111111-memory`)
    const wrong = path.posix.join(root, `cast-${env.agentName}-22222222-2222-2222-2222-222222222222-memory`)
    const blocked = path.posix.join(root, `cast-${env.agentName}-33333333-3333-3333-3333-333333333333-memory`)
    fs.mkdirSync(right)
    fs.mkdirSync(wrong)
    fs.mkdirSync(blocked)
    fs.writeFileSync(path.join(blocked, 'keep'), 'x')
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await SpritesDeploy.destroy(env.agentName, {
        volume_config: JSON.stringify({hostPath: right, mountPath: '/opt/cast-agent/memory'}),
      }, {hostMemoryRoot: root})
      cleanupRecordedSpriteMemory(env.agentName, [
        JSON.stringify({hostPath: blocked}),
        JSON.stringify({hostPath: path.posix.join(root, '..', 'escape-memory')}),
      ], (message) => logs.push(message), root)
      expect(fs.existsSync(right)).to.equal(false)
      expect(fs.existsSync(wrong)).to.equal(true)
      expect(fs.existsSync(blocked)).to.equal(true)
      const text = logs.join('\n')
      expect(text).to.include(`Host memory directory '${right}' has been removed.`)
      expect(text).to.include(`Host memory directory '${blocked}' could not be removed.`)
      expect(text).to.not.include(wrong)
      expect(text).to.not.include('escape-memory')
      expect(fs.existsSync(env.sudoLog)).to.equal(false)
      const outside = path.posix.join('/tmp', `cast-${env.agentName}-memory`)
      expect(recordedHostMemoryPaths(env.agentName, [JSON.stringify({hostPath: outside})], root)).to.deep.equal([])
    } finally {
      console.log = original
      cleanup(env)
    }
  })

  it('does not leave the sprites token in a child argv when the mock is invoked directly', () => {
    const env = setup('direct')
    try {
      const childEnv = spriteCliEnv(process.env)
      expect(childEnv.SPRITE_TOKEN).to.equal(TOKEN)
      const result = spawnSync(path.join(env.dir, 'sprite'), ['list'], {
        env: childEnv,
        encoding: 'utf8',
      })
      expect(result.status).to.equal(0)
      assertTokenStaysOffArgv(env.log)
    } finally {
      cleanup(env)
    }
  })
})
