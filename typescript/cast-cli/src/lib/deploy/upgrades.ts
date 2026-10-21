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
  ensureCastRuntimeDockerfile,
  appendCompilerHint,
} from './deploy-utils'
import {deployToSprites, type SpriteDeployOptions} from './sprites'
import {SPRITE_SERVICE_LOG} from './sprites-service'
import {dockerContainerEnv, dockerContainerRunArgs, startDockerAgentContainer, writeDockerCompose} from './docker'
import {ollamaLinuxDockerHint, ollamaUpgradeDecision, prepareOllamaDocker} from './ollama'
import {writeHostMotdOverSsh} from './motd'
import {stagePythonRequirements, writeRequirementsTxt} from './requirements'
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
  const dockerDecision = await ollamaUpgradeDecision('docker', agentPath, versionTarballPath)
  if (dockerDecision.refusal) host.error(dockerDecision.refusal)
  if (dockerDecision.model.startsWith('ollama/')) {
    const hint = ollamaLinuxDockerHint()
    if (hint) host.log(hint)
  }
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
  ensureCastRuntimeDockerfile(agentPath)
  createDockerignore(agentPath)
  createRequirementsTxt(projectRoot, agentPath)
  writeDockerCompose(agentPath, {
    agentName,
    port: 8080,
    volumeId: existingVolumeId || undefined,
  })

  host.log('Building Docker image...')
  const {spawn} = await import('child_process')

  const built = await execCommand('docker', ['build', '--progress=plain', '--load', '-t', `cast-${agentName}:latest`, '-f', dockerfilePath, agentPath])
  if (built.exitCode !== 0) {
    throw new Error(appendCompilerHint(
      `Docker build failed with code ${built.exitCode}`,
      `${built.stdout}\n${built.stderr}`,
    ))
  }

  const containerName = `cast-${agentName}`
  try {
    const stopProc = spawn('docker', ['stop', containerName], {stdio: 'ignore'})
    await new Promise<void>((resolve) => {
      stopProc.on('error', () => resolve())
      stopProc.on('exit', () => resolve())
    })
  } catch {
    // container may not exist
  }

  try {
    const rmProc = spawn('docker', ['rm', containerName], {stdio: 'ignore'})
    await new Promise<void>((resolve) => {
      rmProc.on('error', () => resolve())
      rmProc.on('exit', () => resolve())
    })
  } catch {
    // container may not exist
  }

  host.log('Starting Docker container...')

  const authToken = deployment ? await resolveDeploymentAuthToken(deployment) : null
  const upgradedModel = readAgentModel(agentPath)
  const ollama = prepareOllamaDocker(upgradedModel, filterInferenceEnv(upgradedModel, await inferenceEnv()))
  if (ollama.hostGateway) {
    host.log(`Ollama base URL for this container: ${ollama.inference.OLLAMA_BASE_URL}`)
  }
  const containerEnv = dockerContainerEnv({
    agentName,
    authToken,
    inference: ollama.inference,
  })
  const dockerRunArgs = dockerContainerRunArgs({
    containerName,
    publish: '8080:8080',
    image: `cast-${agentName}:latest`,
    volumeId: existingVolumeId || undefined,
    hostGateway: ollama.hostGateway,
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
  const railwayDecision = await ollamaUpgradeDecision('railway', agentPath, versionTarballPath)
  if (railwayDecision.refusal) host.error(railwayDecision.refusal)
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

  stagePythonRequirements(agentPath)

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
  const flyDecision = await ollamaUpgradeDecision('fly', agentPath, versionTarballPath)
  if (flyDecision.refusal) host.error(flyDecision.refusal)
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
  const inference = filterInferenceEnv(readAgentModel(agentPath), await inferenceEnv())
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
  const dropletDecision = await ollamaUpgradeDecision('digitalocean', agentPath, versionTarballPath)
  if (dropletDecision.refusal) host.error(dropletDecision.refusal)
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

  stageCastRuntime(agentPath)
  host.log('Building and pushing Docker image to DigitalOcean...')
  const {spawn} = await import('child_process')

  const token = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
  if (!token) {
    host.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN environment variable.')
  }

  const imageName = `registry.digitalocean.com/cast-${agentName}/agent:${version}`

  const built = await execCommand('docker', ['build', '-t', imageName, '.'], {cwd: agentPath})
  if (built.exitCode !== 0) {
    throw new Error(appendCompilerHint(
      `Docker build failed with code ${built.exitCode}`,
      `${built.stdout}\n${built.stderr}`,
    ))
  }

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

/** Recorded on the deployment row when the remote version is no longer known. */
export const REMOTE_STATE_UNKNOWN = 'remote-state-unknown'

export function remoteStateUnknownValue(target: string): string {
  return `${REMOTE_STATE_UNKNOWN}:${target}`
}

export function isRemoteStateUnknown(state: string | null | undefined): boolean {
  return !!state && (state === REMOTE_STATE_UNKNOWN || state.startsWith(`${REMOTE_STATE_UNKNOWN}:`))
}

export function failedUpgradeTarget(state: string | null | undefined): string | null {
  if (!state?.startsWith(`${REMOTE_STATE_UNKNOWN}:`)) return null
  const target = state.slice(REMOTE_STATE_UNKNOWN.length + 1)
  return target.length > 0 ? target : null
}

/** Drop a trailing newline so the following blank line stays a single gap. */
function failureText(text: string): string {
  return text.replace(/[ \t\r\n]+$/g, '')
}

function isSpriteLogsHint(line: string): boolean {
  return line.startsWith('Logs: sprite exec -s ') && line.endsWith(` -- cat ${SPRITE_SERVICE_LOG}`)
}

/** The service-log hint is one line, after the restore result. */
function moveSpriteLogsHintLast(message: string): string {
  const lines = message.split('\n')
  let hint: string | null = null
  const body: string[] = []
  for (const line of lines) {
    if (isSpriteLogsHint(line)) {
      if (!hint) hint = line
      continue
    }
    body.push(line)
  }
  if (!hint) return message
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return `${body.join('\n')}\n\n${hint}`
}

export function upgradeRolledBackMessage(agent: string, oldVersion: string, target: string, upgradeError: string): string {
  return moveSpriteLogsHintLast(
    `Upgrade to ${target} failed. ${agent} is back on ${oldVersion}.\n\nReason: ${failureText(upgradeError)}\n\nTo try again: cast upgrade ${agent} ${target}`,
  )
}

export function upgradeRestoreFailedMessage(
  agent: string,
  oldVersion: string,
  target: string,
  upgradeError: string,
  restoreError: string,
  localFilesRestored = true,
  versionRecorded = true,
): string {
  const localFiles = localFilesRestored
    ? `Your local files are back on ${oldVersion}.`
    : `Your local files could not be restored to ${oldVersion}. See Restore error above.`
  const recovery = versionRecorded
    ? [`To restore ${oldVersion} on the remote, run:`, `  cast upgrade ${agent} ${oldVersion}`]
    : [
      'To restore it, find the last good release and upgrade to it:',
      `  cast upgrade ${agent} --list-versions`,
    ]
  return moveSpriteLogsHintLast([
    `Upgrade to ${target} failed, and restoring ${oldVersion} on the remote also failed.`,
    '',
    `Upgrade error: ${failureText(upgradeError)}`,
    `Restore error: ${failureText(restoreError)}`,
    '',
    `${agent} may be running the broken ${target} release. ${localFiles}`,
    ...recovery,
  ].join('\n'))
}

/** State C: restoring the recorded version failed again, and the failed target stays put. */
export function restoreFailedAgainMessage(
  agent: string,
  oldVersion: string,
  brokenTarget: string,
  error: string,
): string {
  return moveSpriteLogsHintLast([
    `Restoring ${oldVersion} on the remote failed again.`,
    '',
    `Error: ${failureText(error)}`,
    '',
    `${agent} may still be running the broken ${brokenTarget} release. Your local files are on ${oldVersion}.`,
    `To try again: cast upgrade ${agent} ${oldVersion}`,
  ].join('\n'))
}

export function unfinishedUpgradeLine(agent: string, target: string): string {
  return `The last upgrade of ${agent} to ${target} did not finish. The remote may be on ${target}.`
}

export function restoringLine(oldVersion: string): string {
  return `Restoring ${oldVersion} on the remote...`
}

export function restoredLine(agent: string, oldVersion: string): string {
  return `Restored ${agent} to ${oldVersion}.`
}

export class SpritesUpgradeFailure extends Error {
  readonly outcome: 'rolled-back' | 'remote-state-unknown'

  constructor(message: string, outcome: 'rolled-back' | 'remote-state-unknown') {
    super(message)
    this.name = 'SpritesUpgradeFailure'
    this.outcome = outcome
  }
}

function withoutSecrets(message: string, secrets: Array<string | null | undefined>): string {
  let text = message
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]')
  }
  return text
}

/** True when `cast upgrade` should refuse because the remote is already on `version`. */
export function upgradeRefusedAsCurrent(
  deployment: {deployed_version?: string | null; remote_version_state?: string | null},
  version: string,
): boolean {
  if (isRemoteStateUnknown(deployment.remote_version_state)) return false
  const currentVersion = deployment.deployed_version ?? null
  if (currentVersion === version) return true
  return version === 'latest' && currentVersion === 'latest'
}

/**
 * Redeploy an existing sprite with the same install path as `deployToSprites`.
 * The sprite name is `cast-<agent>`. The recorded deployment row is left in
 * place; `cast upgrade` writes the version after this returns. A failed
 * remote step restores the local agent directory, then redeploys that
 * previous release through the same path. If the rollback succeeds, the
 * recorded version stays put. If it fails, the row is marked
 * `remote-state-unknown` and `deployed_version` stays the last known-good release.
 */
export async function upgradeSpritesDeployment(
  host: UpgradeHost,
  agentName: string,
  version: string,
  versionTarballPath: string | null,
  options: SpriteUpgradeOptions = {},
): Promise<void> {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const spriteDecision = await ollamaUpgradeDecision('sprites', agentPath, versionTarballPath)
  if (spriteDecision.refusal) host.error(spriteDecision.refusal)
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
  const recordedVersion = typeof deployment?.deployed_version === 'string' && deployment.deployed_version.length > 0
    ? deployment.deployed_version
    : null
  const priorFailedTarget = failedUpgradeTarget(deployment?.remote_version_state)
  const restoring = priorFailedTarget !== null && recordedVersion !== null && version === recordedVersion
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

    // An unsatisfiable pin fails here, before the sprite is touched.
    // The catch restores the local directory and does not redeploy.
    stagePythonRequirements(agentPath)

    host.log(`Redeploying ${agentName} to sprite ${spriteName}...`)
    remoteAttempted = true
    await deployToSprites(agentName, {
      log: (message) => host.log(message),
      warn: (message) => host.warn(message),
    }, {
      ...spriteOptions,
      authToken,
      recordDeployment: false,
      announceSuccess: !restoring,
    })
    if (deployment?.id) db.setRemoteVersionState(deployment.id, null)

    if (!restoring) {
      host.log('')
      host.log(`Upgraded to version ${version} on Sprites.`)
      host.log(`Sprite: ${spriteName}`)
      host.log(`Volume ${existingVolumeId || 'preserved'}.`)
      host.log('')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    let restoreFailure = ''
    const restoreLocal = (): void => {
      try {
        restoreAgentDirectory(agentPath, snapshotRoot)
      } catch (restoreError) {
        const extra = restoreError instanceof Error ? restoreError.message : String(restoreError)
        restoreFailure += `\nFailed to restore local agent files: ${extra}`
      }
    }
    restoreLocal()
    if (!remoteAttempted) {
      if (restoreFailure) throw new Error(`${message}${restoreFailure}`)
      throw error
    }
    const knownGood = recordedVersion || 'the previous release'
    const secrets = [authToken, process.env.SPRITES_TOKEN, process.env.SPRITE_TOKEN]
    const upgradeError = withoutSecrets(message, secrets)
    const markUnknown = (): void => {
      if (restoring) return
      if (deployment?.id) db.setRemoteVersionState(deployment.id, remoteStateUnknownValue(version))
    }
    const throwRestoreFailure = (restoreError: string): never => {
      if (restoring && priorFailedTarget) {
        throw new SpritesUpgradeFailure(
          restoreFailedAgainMessage(agentName, knownGood, priorFailedTarget, upgradeError),
          'remote-state-unknown',
        )
      }
      markUnknown()
      throw new SpritesUpgradeFailure(
        upgradeRestoreFailedMessage(
          agentName,
          knownGood,
          version,
          upgradeError,
          restoreError,
          restoreFailure.length === 0,
          Boolean(recordedVersion),
        ),
        'remote-state-unknown',
      )
    }
    if (restoreFailure) {
      throwRestoreFailure(withoutSecrets(restoreFailure.trim(), secrets))
    }

    // This call is already the restore of the recorded release. Another
    // deploy would repeat it and print the install progress twice.
    if (restoring) {
      throwRestoreFailure(upgradeError)
    }

    host.log(`Restoring ${knownGood} on the remote...`)
    try {
      await deployToSprites(agentName, {
        log: () => {},
        warn: () => {},
      }, {
        ...spriteOptions,
        authToken,
        recordDeployment: false,
        announceSuccess: false,
      })
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      restoreLocal()
      const restoreError = withoutSecrets(`${rollbackMessage}${restoreFailure}`.trim(), secrets)
      throwRestoreFailure(restoreError)
    }

    restoreLocal()
    if (deployment?.id) db.setRemoteVersionState(deployment.id, null)
    throw new SpritesUpgradeFailure(
      upgradeRolledBackMessage(agentName, knownGood, version, upgradeError),
      'rolled-back',
    )
  } finally {
    fs.rmSync(snapshotRoot, {recursive: true, force: true})
  }
}
