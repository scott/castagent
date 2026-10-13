import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {db} from '../sqlite'
import {
  createDockerignore,
  execCommand,
  getProviderToken,
  inferenceEnv,
  resolveDeploymentAuthToken,
} from './deploy-utils'
import {writeHostMotdOverSsh} from './motd'

export interface UpgradeHost {
  log(message: string): void
  warn(message: string): void
  error(message: string): never
}

export function readUpgradeOpenRouterKey(): string | undefined {
  const configPath = path.join(os.homedir(), '.cast', 'config.yaml')
  if (fs.existsSync(configPath)) {
    try {
      const YAML = require('yaml')
      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8'))
      return config.providers?.openrouter?.api_key || process.env.OPENROUTER_API_KEY
    } catch {
      return process.env.OPENROUTER_API_KEY
    }
  }
  return process.env.OPENROUTER_API_KEY
}

/**
 * Detect whether the on-host TUI is bundled in the agent container
 * running on the given droplet. The TUI patch in deploy-utils
 * creates a symlink at /usr/local/bin/cast-tui as its last step, so
 * a successful `test -e` on that path is a reliable signal that
 * the TUI is present in the image.
 *
 * Returns false on any error (SSH failure, container not running,
 * `docker exec` unavailable) — false is the safe default because
 * it causes the MOTD to omit the TUI hint, which is preferable to
 * telling users to run a command that doesn't exist.
 */
export async function detectOnHostTui(dropletIp: string): Promise<boolean> {
  const sshKey = path.join(os.homedir(), '.ssh', 'cast_do_key')
  const sshArgs = [
    '-i', sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    `root@${dropletIp}`,
    'docker exec cast-agent test -e /usr/local/bin/cast-tui',
  ]
  try {
    const result = await execCommand('ssh', sshArgs, {silent: true, shell: false})
    return result.exitCode === 0
  } catch {
    return false
  }
}

function createDockerfile(agentPath: string): void {
  const dockerfile = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \\
    gcc \\
    git \\
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy cast runtime package
COPY .cast-runtime/cast /app/cast

# Copy agent files
COPY . /app/agent/

# Set environment variables
ENV CAST_AGENT_PATH=/app/agent
ENV PYTHONPATH=/app

# Expose A2A HTTP server port
EXPOSE 8080

# Run agent A2A server
CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]
`
  fs.writeFileSync(path.join(agentPath, 'Dockerfile'), dockerfile)
}

function createRequirementsTxt(projectRoot: string, agentPath: string): void {
  const {execSync} = require('child_process')
  const venvPath = path.join(projectRoot, 'python', '.venv')
  let requirements = ''

  if (fs.existsSync(venvPath)) {
    try {
      const pipPath = path.join(venvPath, 'bin', 'pip')
      if (fs.existsSync(pipPath)) {
        requirements = execSync(`"${pipPath}" freeze`, {encoding: 'utf8'})
      }
    } catch {
      // fall back to default list
    }
  }

  if (!requirements.trim()) {
    requirements = `anyio>=4.13.0
certifi>=2026.4.22
charset-normalizer>=3.4.7
distro>=1.9.0
httpx>=0.28.1
idna>=3.13
jiter>=0.14.0
jsonpatch>=1.33
jsonpointer>=3.1.1
langchain>=1.2.15
langchain-core>=1.3.2
langchain-openai>=1.2.1
langgraph>=1.1.10
langgraph-checkpoint>=4.0.3
langgraph-prebuilt>=1.0.12
langgraph-sdk>=0.3.13
openai>=2.33.0
orjson>=3.11.8
packaging>=26.2
pydantic>=2.13.3
pydantic_core>=2.46.3
python-dotenv>=1.2.2
PyYAML>=6.0.1
regex>=2026.4.4
requests>=2.33.1
requests-toolbelt>=1.0.0
sniffio>=1.3.1
starlette>=1.0.0
tenacity>=9.1.4
tiktoken>=0.12.0
tqdm>=4.67.3
typing-inspection>=0.4.2
urllib3>=2.6.3
uvicorn>=0.46.0
xxhash>=3.7.0
`
  }

  requirements = requirements
    .split('\n')
    .filter(line => {
      const trimmed = line.trim().toLowerCase()
      return !/^cast\b/.test(trimmed) && !trimmed.includes('castagent')
    })
    .join('\n')

  fs.writeFileSync(path.join(agentPath, 'requirements.txt'), requirements)
}

export async function upgradeDockerDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const deployment = db.getDeployment(agentName)
  const existingVolumeId = deployment?.volume_id

  let projectRoot = process.cwd()
  if (!fs.existsSync(path.join(projectRoot, 'python', 'cast'))) {
    projectRoot = path.resolve(__dirname, '../../..')
    if (!fs.existsSync(path.join(projectRoot, 'python', 'cast'))) {
      projectRoot = path.resolve(__dirname, '../../../..')
      if (!fs.existsSync(path.join(projectRoot, 'python', 'cast'))) {
        projectRoot = path.resolve(__dirname, '../../../../..')
      }
    }
  }

  const castPackageSource = path.join(projectRoot, 'python', 'cast')
  if (!fs.existsSync(castPackageSource)) {
    host.error(`Cast Python package not found at ${castPackageSource}`)
  }

  if (versionTarballPath && fs.existsSync(versionTarballPath)) {
    host.log(`Extracting version ${version} tarball...`)
    const tar = await import('tar')
    const agentFiles = fs.readdirSync(agentPath).filter(file =>
      !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile' && file !== 'docker-compose.yml' && file !== 'requirements.txt' && file !== '.dockerignore'
    )
    for (const file of agentFiles) {
      const filePath = path.join(agentPath, file)
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, {recursive: true})
      } else {
        fs.unlinkSync(filePath)
      }
    }
    await tar.extract({file: versionTarballPath, cwd: agentPath})
  }

  const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
  fs.mkdirSync(path.dirname(castRuntimeDir), {recursive: true})
  if (fs.existsSync(castRuntimeDir)) {
    fs.rmSync(castRuntimeDir, {recursive: true})
  }
  fs.cpSync(castPackageSource, castRuntimeDir, {recursive: true})

  const dockerfilePath = path.join(agentPath, 'Dockerfile')
  createDockerfile(agentPath)
  createDockerignore(agentPath)
  createRequirementsTxt(projectRoot, agentPath)

  host.log('Building Docker image...')
  const {spawn} = await import('child_process')

  const buildProc = spawn('docker', ['build', '--progress=plain', '--load', '-t', `cast-${agentName}:latest`, '-f', dockerfilePath, agentPath], {
    stdio: process.stdout.isTTY ? 'inherit' : 'pipe',
  })

  await new Promise<void>((resolve, reject) => {
    buildProc.on('error', reject)
    buildProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Docker build failed with code ${code}`))
    })
  })

  const containerName = `cast-${agentName}`
  try {
    const stopProc = spawn('docker', ['stop', containerName], {stdio: 'ignore'})
    await new Promise<void>((resolve) => {
      stopProc.on('exit', () => resolve())
    })
  } catch {
    // container may not exist
  }

  try {
    const rmProc = spawn('docker', ['rm', containerName], {stdio: 'ignore'})
    await new Promise<void>((resolve) => {
      rmProc.on('exit', () => resolve())
    })
  } catch {
    // container may not exist
  }

  host.log('Starting Docker container...')

  const authToken = deployment ? await resolveDeploymentAuthToken(deployment) : null

  const dockerRunArgs = [
    'run',
    '-d',
    '--name', containerName,
    '-p', '8080:8080',
    '-e', `CAST_AGENT_NAME=${agentName}`,
    '-e', `CAST_AGENT_PATH=/app/agent`,
    '-e', `AUTH_TOKEN=${authToken}`,
    '-e', `PYTHONPATH=/app`,
  ]

  if (existingVolumeId) {
    dockerRunArgs.push('-v', `${existingVolumeId}:/app/agent/memory`)
  }

  for (const [key, value] of Object.entries(inferenceEnv())) {
    dockerRunArgs.push('-e', `${key}=${value}`)
  }

  dockerRunArgs.push(`cast-${agentName}:latest`)

  const runProc = spawn('docker', dockerRunArgs)
  runProc.stdout?.pipe(process.stdout)
  runProc.stderr?.pipe(process.stderr)

  await new Promise<void>((resolve, reject) => {
    runProc.on('error', reject)
    runProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Docker run failed with code ${code}`))
    })
  })

  host.log('')
  host.log('╔══════════════════════════════════════════════════════════════╗')
  host.log('║              Upgrade Successful!                              ║')
  host.log('╚══════════════════════════════════════════════════════════════╝')
  host.log('')
  host.log(`Agent: ${agentName}`)
  host.log(`Version: ${version}`)
  host.log(`URL: http://localhost:8080`)
  host.log(`Volume: ${existingVolumeId || 'newly created'}`)
  host.log('')
}

export async function upgradeRailwayDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const deployment = db.getDeployment(agentName)
  const existingVolumeId = deployment?.volume_id

  if (versionTarballPath && fs.existsSync(versionTarballPath)) {
    host.log(`Extracting version ${version} tarball...`)
    const tar = await import('tar')
    const agentFiles = fs.readdirSync(agentPath).filter(file =>
      !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile'
    )
    for (const file of agentFiles) {
      const filePath = path.join(agentPath, file)
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, {recursive: true})
      } else {
        fs.unlinkSync(filePath)
      }
    }
    await tar.extract({file: versionTarballPath, cwd: agentPath})
  }

  host.log('Triggering Railway redeploy...')
  const {spawn} = await import('child_process')

  const deployProc = spawn('railway', ['up', '--detach'], {
    cwd: agentPath,
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    deployProc.on('error', reject)
    deployProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Railway deploy failed with code ${code}`))
    })
  })

  host.log('')
  host.log(`Upgraded to version ${version} on Railway.`)
  host.log(`Volume ${existingVolumeId || 'preserved'}.`)
  host.log('')
}

export async function upgradeFlyDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const deployment = db.getDeployment(agentName)
  const existingVolumeId = deployment?.volume_id

  if (versionTarballPath && fs.existsSync(versionTarballPath)) {
    host.log(`Extracting version ${version} tarball...`)
    const tar = await import('tar')
    const agentFiles = fs.readdirSync(agentPath).filter(file =>
      !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile' && file !== 'fly.toml'
    )
    for (const file of agentFiles) {
      const filePath = path.join(agentPath, file)
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, {recursive: true})
      } else {
        fs.unlinkSync(filePath)
      }
    }
    await tar.extract({file: versionTarballPath, cwd: agentPath})
  }

  host.log('Triggering Fly.io deploy...')
  const {spawn} = await import('child_process')

  const deployProc = spawn('flyctl', ['deploy', '--detach'], {
    cwd: agentPath,
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    deployProc.on('error', reject)
    deployProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Fly.io deploy failed with code ${code}`))
    })
  })

  host.log('')
  host.log(`Upgraded to version ${version} on Fly.io.`)
  host.log(`Volume ${existingVolumeId || 'preserved'}.`)
  host.log('')
}

export async function upgradeDigitalOceanDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const deployment = db.getDeployment(agentName)
  const existingVolumeId = deployment?.volume_id

  if (versionTarballPath && fs.existsSync(versionTarballPath)) {
    host.log(`Extracting version ${version} tarball...`)
    const tar = await import('tar')
    const agentFiles = fs.readdirSync(agentPath).filter(file =>
      !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile' && file !== 'docker-compose.yml' && file !== 'requirements.txt'
    )
    for (const file of agentFiles) {
      const filePath = path.join(agentPath, file)
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, {recursive: true})
      } else {
        fs.unlinkSync(filePath)
      }
    }
    await tar.extract({file: versionTarballPath, cwd: agentPath})
  }

  host.log('Building and pushing Docker image to DigitalOcean...')
  const {spawn} = await import('child_process')

  const token = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
  if (!token) {
    host.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN environment variable.')
  }

  const imageName = `registry.digitalocean.com/cast-${agentName}/agent:${version}`

  const buildProc = spawn('docker', ['build', '-t', imageName, '.'], {
    cwd: agentPath,
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    buildProc.on('error', reject)
    buildProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Docker build failed with code ${code}`))
    })
  })

  const pushProc = spawn('docker', ['push', imageName], {
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    pushProc.on('error', reject)
    pushProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Docker push failed with code ${code}`))
    })
  })

  host.log('Restarting droplet...')

  const deploymentUrl = deployment?.deployment_url
  const dropletIp = deploymentUrl ? new URL(deploymentUrl).hostname : null

  if (dropletIp) {
    host.log('Refreshing SSH login MOTD...')
    const onHostTui = await detectOnHostTui(dropletIp)
    const {motdStderr, profileStderr} = await writeHostMotdOverSsh(dropletIp, {
      agentName,
      dropletIp,
      a2aUrl: deploymentUrl ?? undefined,
      deployedVersion: version,
      onHostTui,
    })
    if (motdStderr) {
      host.warn(`Failed to refresh /etc/motd: ${motdStderr}`)
    }
    if (profileStderr) {
      host.warn(`Failed to refresh /etc/profile.d/cast.sh: ${profileStderr}`)
    }
  } else {
    host.warn('Could not determine droplet IP; skipping MOTD refresh')
  }

  host.log('')
  host.log(`Upgraded to version ${version} on DigitalOcean.`)
  host.log(`Deployment URL: ${deploymentUrl}`)
  host.log(`Volume ${existingVolumeId || 'preserved'}.`)
  host.log('')
}

export async function upgradeSpritesDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const deployment = db.getDeployment(agentName)
  const existingVolumeId = deployment?.volume_id

  if (versionTarballPath && fs.existsSync(versionTarballPath)) {
    host.log(`Extracting version ${version} tarball...`)
    const tar = await import('tar')
    const agentFiles = fs.readdirSync(agentPath).filter(file =>
      !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile' && file !== 'sprite.toml'
    )
    for (const file of agentFiles) {
      const filePath = path.join(agentPath, file)
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, {recursive: true})
      } else {
        fs.unlinkSync(filePath)
      }
    }
    await tar.extract({file: versionTarballPath, cwd: agentPath})
  }

  host.log('Triggering Sprites deploy...')
  const {spawn} = await import('child_process')

  const deployProc = spawn('sprite', ['deploy', agentName], {
    cwd: agentPath,
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    deployProc.on('error', reject)
    deployProc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Sprites deploy failed with code ${code}`))
    })
  })

  host.log('')
  host.log(`Upgraded to version ${version} on Sprites.`)
  host.log(`Volume ${existingVolumeId || 'preserved'}.`)
  host.log('')
}
