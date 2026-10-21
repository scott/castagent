import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'

import {importFlySecrets} from '../../../../typescript/cast-cli/src/lib/deploy/fly'
import {
  dockerContainerEnv,
  dockerContainerRunArgs,
} from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import {microvmCreatePayload} from '../../../../typescript/cast-cli/src/lib/deploy/microvm'
import {spriteAgentLaunchScript, spriteInstallExecArgs} from '../../../../typescript/cast-cli/src/lib/deploy/sprites-service'
import {
  assertSecretsNotInArgv,
  execCommand,
  filterInferenceEnv,
  flySecretsImportArgs,
  formatEnvAssignments,
  formatFlySecretsImport,
  inferenceEnvForAgent,
  railwaySecretSetArgs,
  readAgentModel,
  type InferenceCatalogEntry,
} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

const TOKEN = 'bearer-token-value-0123456789abcdef'
const OPENROUTER = 'sk-or-v1-secret-openrouter-key'
const DIGITALOCEAN = 'do-model-secret-key-0123456789'

const CATALOG: InferenceCatalogEntry[] = [
  {
    key: 'openrouter',
    name: 'OpenRouter',
    default: true,
    prefixes: ['openrouter/'],
    envVar: 'OPENROUTER_API_KEY',
    configKey: 'providers.openrouter.api_key',
    baseUrl: 'https://openrouter.ai/api/v1',
    acceptsAnyModel: false,
  },
  {
    key: 'digitalocean',
    name: 'DigitalOcean',
    default: false,
    prefixes: ['digitalocean/'],
    envVar: 'DIGITALOCEAN_MODEL_ACCESS_KEY',
    configKey: 'providers.digitalocean_inference.api_key',
    baseUrl: 'https://inference.do-ai.run/v1',
    acceptsAnyModel: true,
  },
  {
    key: 'example',
    name: 'Example',
    default: false,
    prefixes: ['example/'],
    envVar: 'EXAMPLE_API_KEY',
    configKey: 'providers.example.api_key',
    baseUrl: 'https://example.invalid/v1',
    acceptsAnyModel: true,
  },
]

const BOTH = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  EXAMPLE_API_KEY: 'example-secret-key-0123456789',
}

async function spawnedArgv(args: string[], input: string): Promise<{argv: string[]; stdin: string}> {
  // Python prints the argv it received. Node treats `--env-file` as its own
  // option, so it cannot stand in for the docker CLI in this check.
  const script = 'import json,sys; json.dump({"argv":sys.argv,"stdin":sys.stdin.read()}, sys.stdout)'
  const result = await execCommand('python3', ['-c', script, ...args], {
    input,
    silent: true,
    shell: false,
  })
  expect(result.exitCode, result.stderr).to.equal(0)
  return JSON.parse(result.stdout) as {argv: string[]; stdin: string}
}

function expectSecretsOffArgv(argv: readonly string[], stdin: string, secrets: string[]): void {
  const joined = argv.join('\0')
  for (const secret of secrets) {
    expect(joined).to.not.include(secret)
    expect(stdin).to.include(secret)
  }
}

describe('deployment secret handling', () => {
  describe('filterInferenceEnv', () => {
    it('keeps the openrouter key for an openrouter model', () => {
      const env = filterInferenceEnv('openrouter/minimax/minimax-m2.5', BOTH, CATALOG)
      expect(env).to.deep.equal({OPENROUTER_API_KEY: OPENROUTER})
    })

    it('keeps the digitalocean key for a digitalocean model', () => {
      const env = filterInferenceEnv('digitalocean/llama3.3-70b-instruct', BOTH, CATALOG)
      expect(env).to.deep.equal({DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN})
    })

    it('uses the default provider when the model has no prefix', () => {
      const env = filterInferenceEnv('minimax/minimax-m2.5', BOTH, CATALOG)
      expect(env).to.deep.equal({OPENROUTER_API_KEY: OPENROUTER})
    })

    it('keeps an external provider key and drops the built-in keys', () => {
      const env = filterInferenceEnv('example/my-model', BOTH, CATALOG)
      expect(env).to.deep.equal({EXAMPLE_API_KEY: 'example-secret-key-0123456789'})
    })

    it('returns nothing when the selected key is unset', () => {
      const env = filterInferenceEnv('digitalocean/llama3.3-70b-instruct', {
        OPENROUTER_API_KEY: OPENROUTER,
      }, CATALOG)
      expect(env).to.deep.equal({})
    })

    it('drops a custom base URL even when the resolved map contains one', () => {
      const catalog = CATALOG.map(entry => {
        if (entry.key === 'digitalocean') return {...entry, baseUrlEnv: 'DIGITALOCEAN_INFERENCE_BASE_URL'}
        if (entry.key === 'openrouter') return {...entry, baseUrlEnv: 'OPENROUTER_BASE_URL'}
        return entry
      })
      const env = filterInferenceEnv('digitalocean/llama3.3-70b-instruct', {
        ...BOTH,
        DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
        OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
      }, catalog)
      expect(env).to.deep.equal({DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN})
      expect(JSON.stringify(env)).to.not.include('BASE_URL')
      expect(JSON.stringify(env)).to.not.include('https://inference.example/v1')
    })

    it('reads brain.model and forwards only that provider key', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-secret-agent-'))
      const previousHome = process.env.HOME
      const previousOpenRouter = process.env.OPENROUTER_API_KEY
      const previousDigitalOcean = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      process.env.HOME = home
      process.env.OPENROUTER_API_KEY = OPENROUTER
      process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = DIGITALOCEAN
      const agent = path.join(home, '.cast', 'agents', 'demo')
      fs.mkdirSync(agent, {recursive: true})
      fs.writeFileSync(path.join(agent, 'agent.yaml'), 'brain:\n  model: digitalocean/llama3.3-70b-instruct\n')
      try {
        expect(readAgentModel(agent)).to.equal('digitalocean/llama3.3-70b-instruct')
        const env = await inferenceEnvForAgent(agent, {})
        expect(env).to.deep.equal({DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN})
        expect(JSON.stringify(env)).to.not.include(OPENROUTER)
      } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY
        else process.env.OPENROUTER_API_KEY = previousOpenRouter
        if (previousDigitalOcean === undefined) delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
        else process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = previousDigitalOcean
        fs.rmSync(home, {recursive: true, force: true})
      }
    })
  })

  describe('subprocess argv', () => {
    const secrets = {
      CAST_AGENT_NAME: 'demo',
      AUTH_TOKEN: TOKEN,
      OPENROUTER_API_KEY: OPENROUTER,
    }

    it('refuses to place a secret on argv', () => {
      expect(() => assertSecretsNotInArgv('flyctl', ['secrets', 'set', `AUTH_TOKEN=${TOKEN}`], [TOKEN]))
        .to.throw(/command line/)
    })

    it('sends Fly secrets on stdin of flyctl secrets import', async () => {
      const sandbox = sinon.createSandbox()
      const exec = sandbox.stub(deployUtils, 'execCommand').resolves({stdout: '', stderr: '', exitCode: 0})
      try {
        await importFlySecrets('/tmp/agent', 'cast-demo', secrets)
      } finally {
        sandbox.restore()
      }
      expect(exec.calledOnce).to.equal(true)
      const [command, args, options] = exec.firstCall.args
      expect(command).to.equal('flyctl')
      expect(args).to.deep.equal(['secrets', 'import', '--app', 'cast-demo', '--stage'])
      const input = (options as {input?: string}).input || ''
      expectSecretsOffArgv(args as string[], input, [TOKEN, OPENROUTER])
      expect(input).to.include('CAST_AGENT_NAME=demo')
      expect(input).to.not.include('DIGITALOCEAN_MODEL_ACCESS_KEY')
      expect(input).to.not.include(DIGITALOCEAN)

      const spawned = await spawnedArgv(flySecretsImportArgs('cast-demo'), formatFlySecretsImport(secrets))
      expectSecretsOffArgv(spawned.argv, spawned.stdin, [TOKEN, OPENROUTER])
    })

    it('quotes a Fly secret that contains a hash', () => {
      const text = formatFlySecretsImport({AUTH_TOKEN: 'sek#ret-token-value'})
      expect(text).to.equal('AUTH_TOKEN="""sek#ret-token-value"""\n')
    })

    it('sends Docker env on stdin and keeps secrets out of docker run argv', async () => {
      const env = dockerContainerEnv({
        agentName: 'demo',
        authToken: TOKEN,
        inference: {OPENROUTER_API_KEY: OPENROUTER},
      })
      const args = dockerContainerRunArgs({
        containerName: 'cast-demo',
        publish: '8080:8080',
        image: 'cast-demo:latest',
        volumeId: 'cast-demo',
      })
      const input = formatEnvAssignments(env)
      expect(args).to.include('--env-file')
      expect(args).to.include('/dev/stdin')
      expectSecretsOffArgv(args, input, [TOKEN, OPENROUTER])
      expect(input).to.not.include(DIGITALOCEAN)
      const spawned = await spawnedArgv(args, input)
      expectSecretsOffArgv(spawned.argv, spawned.stdin, [TOKEN, OPENROUTER])
    })

    it('sends each Railway variable on stdin', async () => {
      for (const [key, value] of Object.entries({AUTH_TOKEN: TOKEN, OPENROUTER_API_KEY: OPENROUTER})) {
        const args = railwaySecretSetArgs(key)
        expect(args).to.deep.equal(['variables', 'set', key, '--stdin'])
        const spawned = await spawnedArgv(args, value)
        expect(spawned.argv.join('\0')).to.not.include(value)
        expect(spawned.stdin).to.equal(value)
      }
    })

    it('sends the sprite launch script on stdin', async () => {
      const script = spriteAgentLaunchScript('demo', TOKEN, {OPENROUTER_API_KEY: OPENROUTER})
      const args = spriteInstallExecArgs('cast-demo')
      expectSecretsOffArgv(args, script, [TOKEN, OPENROUTER])
      expect(script).to.not.include(DIGITALOCEAN)
      const spawned = await spawnedArgv(args, script)
      expectSecretsOffArgv(spawned.argv, spawned.stdin, [TOKEN, OPENROUTER])
    })

    it('puts MicroVM environment in the create body', () => {
      const payload = microvmCreatePayload({
        name: 'cast-demo',
        ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
        cpu: 1,
        memory: 2048,
        idleTimeout: '15m',
        agentName: 'demo',
        env: {
          CAST_AGENT_NAME: 'demo',
          AUTH_TOKEN: TOKEN,
          OPENROUTER_API_KEY: OPENROUTER,
        },
      })
      const environment = payload.environment as Record<string, string>
      expect(environment.AUTH_TOKEN).to.equal(TOKEN)
      expect(environment.OPENROUTER_API_KEY).to.equal(OPENROUTER)
      expect(environment.DIGITALOCEAN_MODEL_ACCESS_KEY).to.equal(undefined)
      const source = fs.readFileSync(
        path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/microvm.ts'),
        'utf8',
      )
      expect(source).to.not.include("push('--env'")
      expect(source).to.not.include("['--access-token'")
      expect(source).to.not.include('--access-token')
      expect(source).to.include('DIGITALOCEAN_ACCESS_TOKEN')
      expect(source).to.not.include('secrets\', \'set\'')
    })

    it('Fly, Railway, Sprites, and DigitalOcean forward inference through the model filter', () => {
      for (const file of ['fly.ts', 'railway.ts', 'sprites.ts', 'digitalocean.ts']) {
        const source = fs.readFileSync(
          path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy', file),
          'utf8',
        )
        expect(source, file).to.include('filterInferenceEnv')
        expect(source, file).to.not.include('XAI_API_KEY')
        expect(source, file).to.not.include('XAI_BASE_URL')
        expect(source, file).to.not.include('OPENROUTER_API_KEY')
      }
    })

    it('imports Fly secrets from stdin in the deploy source', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/fly.ts'),
        'utf8',
      )
      expect(source).to.include('importFlySecrets')
      expect(source).to.include('filterInferenceEnv')
      expect(source).to.not.include("['secrets', 'set'")
    })
  })
})
