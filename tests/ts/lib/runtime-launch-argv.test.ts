import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {runtimeDockerfileCmd, runtimeProcessArgs} from '../../../typescript/cast-cli/src/lib/runtime-args'
import {devRuntimeArgs} from '../../../typescript/cast-cli/src/lib/session-resume'
import {
  dockerContainerEnv,
  dockerContainerRunArgs,
} from '../../../typescript/cast-cli/src/lib/deploy/docker'
import {buildDropletEnvFile, remoteDockerRunCommand} from '../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import {flyDeployArgs} from '../../../typescript/cast-cli/src/lib/deploy/fly'
import {deploymentEnv, microvmCreatePayload} from '../../../typescript/cast-cli/src/lib/deploy/microvm'
import {
  spriteAgentLaunchScript,
  spriteInstallExecArgs,
} from '../../../typescript/cast-cli/src/lib/deploy/sprites-service'
import {
  castRuntimeDockerfile,
  ensureDockerfile,
  flySecretsImportArgs,
  railwaySecretSetArgs,
} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

const TOKEN = 'sentinel-bearer-token-value'
const ROOT = path.join(__dirname, '../../..')

function assertRuntimeArgv(label: string, argv: string): void {
  expect(argv, label).to.include('cast.runtime')
  expect(argv, label).to.not.include(TOKEN)
  expect(argv, label).to.not.include('--auth-token')
  expect(argv, label).to.not.include('AUTH_TOKEN')
  expect(argv, label).to.not.include('$AUTH_TOKEN')
}

function assertSecretOffArgv(label: string, argv: string): void {
  expect(argv, label).to.not.include(TOKEN)
  expect(argv, label).to.not.include('--auth-token')
  expect(argv, label).to.not.include(`AUTH_TOKEN=${TOKEN}`)
  expect(argv, label).to.not.include('$AUTH_TOKEN')
  expect(argv, label).to.not.include('${AUTH_TOKEN}')
}

function execLine(script: string): string {
  const line = script.split('\n').find(entry => entry.startsWith('exec '))
  expect(line, 'sprite exec line').to.be.a('string')
  return line as string
}

function cmdLine(dockerfile: string): string {
  const line = dockerfile.split('\n').find(entry => entry.startsWith('CMD '))
  expect(line, 'dockerfile CMD').to.be.a('string')
  return line as string
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__pycache__') continue
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, acc)
    else if (name.endsWith('.ts') || name.endsWith('.py')) acc.push(full)
  }
  return acc
}

describe('runtime launch argv', () => {
  const imageCmd = runtimeDockerfileCmd()

  it('builds a runtime command with no token slot', () => {
    expect(runtimeProcessArgs({agentPath: '/tmp/demo', port: 0})).to.deep.equal([
      '-m', 'cast.runtime',
      '--agent-path', '/tmp/demo',
      '--port', '0',
    ])
    expect(imageCmd).to.equal(
      'CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]',
    )
    assertRuntimeArgv('image', imageCmd)
  })

  it('keeps the bearer token out of every provider launch argv', () => {
    const local = devRuntimeArgs('/home/box/.cast/agents/demo', 0).join('\0')
    assertRuntimeArgv('local dev and session resume', local)
    expect(local).to.equal(runtimeProcessArgs({
      agentPath: '/home/box/.cast/agents/demo',
      port: 0,
    }).join('\0'))

    const dockerArgs = dockerContainerRunArgs({
      containerName: 'cast-demo',
      publish: '8080:8080',
      image: 'cast-demo:latest',
      volumeId: 'cast-demo',
    }).join('\0')
    const dockerEnv = dockerContainerEnv({
      agentName: 'demo',
      authToken: TOKEN,
      inference: {OPENROUTER_API_KEY: 'sk-or-test-value'},
    })
    assertSecretOffArgv('docker run', dockerArgs)
    expect(dockerEnv.AUTH_TOKEN).to.equal(TOKEN)

    const dropletArgs = remoteDockerRunCommand({
      volumeId: 'cast-demo',
      imageTag: 'cast-demo:latest',
    })
    const dropletEnv = buildDropletEnvFile({AUTH_TOKEN: TOKEN, CAST_AGENT_NAME: 'demo'})
    assertSecretOffArgv('digitalocean droplet', dropletArgs)
    expect(dropletEnv).to.include(`AUTH_TOKEN=${TOKEN}`)

    const railwayArgs = railwaySecretSetArgs('AUTH_TOKEN').join('\0')
    assertSecretOffArgv('railway', railwayArgs)
    expect(railwayArgs).to.not.include(TOKEN)

    const flyImport = flySecretsImportArgs('cast-demo').join('\0')
    const flyDeploy = flyDeployArgs('cast-demo').join('\0')
    assertSecretOffArgv('fly secrets import', flyImport)
    assertSecretOffArgv('fly deploy', flyDeploy)

    const spriteArgs = spriteInstallExecArgs('cast-demo').join('\0')
    const spriteScript = spriteAgentLaunchScript('demo', TOKEN, {OPENROUTER_API_KEY: 'sk-or-test-value'})
    const spriteRuntime = execLine(spriteScript)
    assertSecretOffArgv('sprite exec', spriteArgs)
    assertRuntimeArgv('sprites runtime', spriteRuntime)
    expect(spriteScript).to.include(`export AUTH_TOKEN=`)
    expect(spriteRuntime).to.equal(
      'exec /opt/cast-agent/venv/bin/python -m cast.runtime --agent-path /opt/cast-agent --port 8080 --host 0.0.0.0',
    )

    const microvmEnv = deploymentEnv({
      agentName: 'demo',
      authToken: TOKEN,
      edgeAuthOnly: false,
    })
    const microvmBody = JSON.stringify(microvmCreatePayload({
      name: 'cast-demo',
      ociRef: 'registry.digitalocean.com/cast/cast-demo:abc',
      cpu: 1,
      memory: 2048,
      idleTimeout: '15m',
      agentName: 'demo',
      env: microvmEnv,
    }))
    expect(microvmEnv.AUTH_TOKEN).to.equal(TOKEN)
    expect(microvmBody).to.include(TOKEN)
    assertRuntimeArgv('microvm image', imageCmd)

    const railwayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-runtime-argv-'))
    try {
      ensureDockerfile(railwayDir)
      const railwayImage = cmdLine(fs.readFileSync(path.join(railwayDir, 'Dockerfile'), 'utf8'))
      assertRuntimeArgv('railway image', railwayImage)
      expect(railwayImage).to.equal(imageCmd)
    } finally {
      fs.rmSync(railwayDir, {recursive: true, force: true})
    }

    const sharedImage = cmdLine(castRuntimeDockerfile())
    assertRuntimeArgv('fly droplet and microvm image', sharedImage)
    expect(sharedImage).to.equal(imageCmd)
  })

  it('does not pass the token flag from any runtime or launcher source', () => {
    const roots = [
      path.join(ROOT, 'typescript/cast-cli/src'),
      path.join(ROOT, 'typescript/cast-tui/src'),
      path.join(ROOT, 'python/cast'),
    ]
    const hits: string[] = []
    for (const root of roots) {
      for (const file of walk(root)) {
        const text = fs.readFileSync(file, 'utf8')
        if (text.includes('--auth-token')) hits.push(path.relative(ROOT, file))
      }
    }
    expect(hits).to.deep.equal([])

    const docker = fs.readFileSync(path.join(ROOT, 'typescript/cast-cli/src/lib/deploy/docker.ts'), 'utf8')
    const upgrades = fs.readFileSync(path.join(ROOT, 'typescript/cast-cli/src/lib/deploy/upgrades.ts'), 'utf8')
    const dev = fs.readFileSync(path.join(ROOT, 'typescript/cast-cli/src/commands/dev.ts'), 'utf8')
    expect(docker).to.include('runtimeDockerfileCmd()')
    expect(upgrades).to.include('runtimeDockerfileCmd()')
    expect(dev).to.include('runtimeProcessArgs(')
  })
})
