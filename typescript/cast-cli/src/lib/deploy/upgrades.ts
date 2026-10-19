import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {db} from '../sqlite'
import {containerHealthFailureMessage, probeDockerContainer, waitForContainerHealth} from './container-health'
import {
  createDockerignore,
  execCommand,
  filterInferenceEnv,
  getProviderToken,
  inferenceEnv,
  readAgentModel,
  resolveDeploymentAuthToken,
  stageCastRuntime,
} from './deploy-utils'
import {deployToSprites, type SpriteDeployOptions} from './sprites'
import {dockerContainerEnv, dockerContainerRunArgs, startDockerAgentContainer, writeDockerCompose} from './docker'
import {writeHostMotdOverSsh} from './motd'
import {writeRequirementsTxt} from './requirements'
import {
  digitalOceanMemoryVolumeName,
  ensureDropletContainerMemory,
} from './digitalocean'
import {execDigitalOceanSsh} from './ssh-hostkey'

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
  try {
    const result = await execDigitalOceanSsh(
      dropletIp,
      'docker exec cast-agent test -e /usr/local/bin/cast-tui',
      {silent: true},
    )
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
  writeRequirementsTxt(projectRoot, agentPath)
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
  writeDockerCompose(agentPath, {
    agentName,
    port: 8080,
    volumeId: existingVolumeId || undefined,
  })

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
  const containerEnv = dockerContainerEnv({
    agentName,
    authToken,
    inference: filterInferenceEnv(readAgentModel(agentPath), inferenceEnv()),
  })
  const dockerRunArgs = dockerContainerRunArgs({
    containerName,
    publish: '8080:8080',
    image: `cast-${agentName}:latest`,
    volumeId: existingVolumeId || undefined,
  })
  const runCode = await startDockerAgentContainer(dockerRunArgs, containerEnv)
  if (runCode !== 0) {
    throw new Error(`Docker run failed with code ${runCode}`)
  }

  host.log('Waiting for the container to become ready...')
  const health = await waitForContainerHealth(() => probeDockerContainer(containerName))
  if (!health.ok) {
    host.error(containerHealthFailureMessage(containerName, health))
  }

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

  stageCastRuntime(agentPath)
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

/**
 * Mount the droplet volume during an upgrade and restart the container
 * onto it. The API token, deployment auth token, and inference secret
 * are the values the remote commands must not carry.
 */
export async function mountUpgradedDropletMemory(
  dropletIp: string,
  agentPath: string,
  volumeName: string,
  apiToken: string,
  deployment: {agent_name: string; id?: string | null; auth_token_hash?: string | null} | null,
): Promise<void> {
  const authToken = deployment ? await resolveDeploymentAuthToken(deployment) : null
  const inference = filterInferenceEnv(readAgentModel(agentPath), inferenceEnv())
  const secrets = [apiToken, authToken ?? '', ...Object.values(inference)].filter(value => value.length > 0)
  await ensureDropletContainerMemory(dropletIp, volumeName, secrets)
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

  const volumeName = existingVolumeId || digitalOceanMemoryVolumeName(agentName)
  if (dropletIp) {
    host.log(`Mounting memory volume at /mnt/${volumeName}...`)
    await mountUpgradedDropletMemory(dropletIp, agentPath, volumeName, token, deployment ?? null)
    host.log(`Volume attached at /mnt/${volumeName}`)
    host.log('Refreshing SSH login MOTD...')
    const onHostTui = await detectOnHostTui(dropletIp)
    const {motdStderr, profileStderr} = await writeHostMotdOverSsh(dropletIp, {
      agentName,
      dropletIp,
      a2aUrl: deploymentUrl ?? undefined,
      deployedVersion: version,
      onHostTui,
      privateSsh: true,
    })
    if (motdStderr) {
      host.warn(`Failed to refresh /etc/motd: ${motdStderr}`)
    }
    if (profileStderr) {
      host.warn(`Failed to refresh /etc/profile.d/cast.sh: ${profileStderr}`)
    }
  } else {
    host.warn('Could not determine droplet IP; skipping memory volume mount and MOTD refresh')
  }

  host.log('')
  host.log(`Upgraded to version ${version} on DigitalOcean.`)
  host.log(`Deployment URL: ${deploymentUrl}`)
  if (!dropletIp) {
    host.log(`Volume ${existingVolumeId || 'preserved'}.`)
  }
  host.log('')
}

interface SpriteUpgradeOptions extends SpriteDeployOptions {
  deployment?: {
    id?: string | null
    agent_name: string
    auth_token_hash?: string | null
    volume_id?: string | null
  } | null
}

/** Copy the agent directory aside so a failed redeploy can put it back. */
function snapshotAgentDirectory(agentPath: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-sprites-upgrade-'))
  fs.cpSync(agentPath, path.join(root, 'agent'), {recursive: true})
  return root
}

function restoreAgentDirectory(agentPath: string, snapshotRoot: string): void {
  const snapshot = path.join(snapshotRoot, 'agent')
  const current = new Set(fs.readdirSync(agentPath))
  const saved = new Set(fs.readdirSync(snapshot))
  for (const name of current) {
    if (!saved.has(name)) {
      fs.rmSync(path.join(agentPath, name), {recursive: true, force: true})
    }
  }
  for (const name of saved) {
    const target = path.join(agentPath, name)
    fs.rmSync(target, {recursive: true, force: true})
    fs.cpSync(path.join(snapshot, name), target, {recursive: true})
  }
}

/**
 * PLACEHOLDER. Sol will replace this string. It is not final wording.
 * The remote may be on the broken release. The recovery command is
 * `cast upgrade <agent> <version>`, where `<version>` is the last known-good release.
 */
export const UPGRADE_FAILED_COPY =
  'PLACEHOLDER: the remote may be on the broken release. Recovery command: cast upgrade <agent> <version>'

/** Recorded on the deployment row when the remote version is no longer known. */
export const UPGRADE_FAILED_STATE = 'upgrade-failed'

export function formatUpgradeFailedCopy(agentName: string, knownGoodVersion: string | null | undefined): string {
  const version = knownGoodVersion && knownGoodVersion.length > 0 ? knownGoodVersion : '<version>'
  return UPGRADE_FAILED_COPY.replaceAll('<agent>', agentName).replaceAll('<version>', version)
}

/** True when `cast upgrade` should refuse because the remote is already on `version`. */
export function upgradeRefusedAsCurrent(
  deployment: {deployed_version?: string | null; remote_version_state?: string | null},
  version: string,
): boolean {
  if (deployment.remote_version_state === UPGRADE_FAILED_STATE) return false
  const currentVersion = deployment.deployed_version ?? null
  if (currentVersion === version) return true
  return version === 'latest' && currentVersion === 'latest'
}

/**
 * Redeploy an existing sprite with the same install path as `deployToSprites`.
 * The sprite name is `cast-<agent>`. The recorded deployment row is left in
 * place; `cast upgrade` writes the version after this returns. A failed
 * remote step restores the local agent directory to its pre-upgrade files.
 * If that step may have changed the sprite, the row is marked upgrade-failed
 * and `deployed_version` stays the last known-good release.
 */
export async function upgradeSpritesDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
  options: SpriteUpgradeOptions = {},
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const {deployment: deploymentOverride, ...spriteOptions} = options
  const deployment = deploymentOverride === undefined ? db.getDeployment(agentName) : deploymentOverride
  const existingVolumeId = deployment?.volume_id
  const authToken = deployment ? await resolveDeploymentAuthToken(deployment) : null
  if (!authToken) {
    host.error(
      `No auth token found for the Sprites deployment of '${agentName}'. Redeploy with: cast deploy ${agentName} --provider sprites`,
    )
  }

  const spriteName = `cast-${agentName}`
  const snapshotRoot = snapshotAgentDirectory(agentPath)
  let remoteAttempted = false
  try {
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

    host.log(`Redeploying ${agentName} to sprite ${spriteName}...`)
    remoteAttempted = true
    await deployToSprites(agentName, {
      log: (message) => host.log(message),
      warn: (message) => host.warn(message),
    }, {
      ...spriteOptions,
      authToken,
      recordDeployment: false,
    })
    if (deployment?.id) db.setRemoteVersionState(deployment.id, null)

    host.log('')
    host.log(`Upgraded to version ${version} on Sprites.`)
    host.log(`Sprite: ${spriteName}`)
    host.log(`Volume ${existingVolumeId || 'preserved'}.`)
    host.log('')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    let restoreFailure = ''
    try {
      restoreAgentDirectory(agentPath, snapshotRoot)
    } catch (restoreError) {
      const extra = restoreError instanceof Error ? restoreError.message : String(restoreError)
      restoreFailure = `\nFailed to restore local agent files: ${extra}`
    }
    if (remoteAttempted && deployment?.id) {
      db.setRemoteVersionState(deployment.id, UPGRADE_FAILED_STATE)
    }
    const copy = remoteAttempted
      ? `\n${formatUpgradeFailedCopy(agentName, deployment?.deployed_version)}`
      : ''
    if (!remoteAttempted && !restoreFailure) throw error
    throw new Error(`${message}${restoreFailure}${copy}`)
  } finally {
    fs.rmSync(snapshotRoot, {recursive: true, force: true})
  }
}
