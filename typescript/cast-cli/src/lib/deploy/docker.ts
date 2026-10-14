import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {ensureDockerDeployArtifactsIgnored} from '../cast-ignore'
import {db} from '../sqlite'
import {containerHealthFailureMessage, probeDockerContainer, waitForContainerHealth} from './container-health'
import {execCommand, inferenceEnv, generateDeploymentId, createDockerignore, storeAuthToken, saveDeployment} from './deploy-utils'
import {writeRequirementsTxt} from './requirements'

// Helper to run a shell command and return its exit code
function runCommand(command: string, args: string[], options?: {stdio?: any; cwd?: string; silent?: boolean}): Promise<number> {
  return new Promise((resolve, reject) => {
    // If not silent and stdout is a TTY, use inherit to show output in real-time
    // Otherwise use pipe so output can be captured (e.g., by TUI)
    const useInherit = !options?.silent && process.stdout.isTTY

    const proc = spawn(command, args, {
      stdio: options?.stdio ?? (useInherit ? 'inherit' : 'pipe'),
      cwd: options?.cwd,
    })

    // If using pipe, also output to console for visibility
    if (!useInherit && proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        process.stdout.write(data)
      })
    }
    if (!useInherit && proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        process.stderr.write(data)
      })
    }

    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => resolve(code ?? 0))
  })
}

export interface DockerCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type DockerRunner = (args: string[]) => Promise<DockerCommandResult>

const LEGACY_DOCKER_VOLUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Docker memory volume keyed by agent name (`cast-<name>`). */
export function dockerMemoryVolumeName(agentName: string): string {
  return `cast-${agentName}`
}

/** Pre-fix volumes were `cast-<agent>-<uuid>-memory`, one per deploy. */
export function isLegacyDockerMemoryVolume(volumeName: string, agentName: string): boolean {
  const prefix = `cast-${agentName}-`
  const suffix = '-memory'
  if (!volumeName.startsWith(prefix) || !volumeName.endsWith(suffix)) return false
  const deploymentId = volumeName.slice(prefix.length, volumeName.length - suffix.length)
  return LEGACY_DOCKER_VOLUME_ID.test(deploymentId)
}

export function isAgentDockerMemoryVolume(volumeName: string, agentName: string): boolean {
  return volumeName === dockerMemoryVolumeName(agentName) || isLegacyDockerMemoryVolume(volumeName, agentName)
}

export interface DockerMemoryPlan {
  volumeId: string
  action: 'create' | 'reuse'
  copyFrom?: string
}

/**
 * The documented Docker volume is `cast-<agent>`. A later deploy reuses it.
 * When the registry still points at a pre-fix volume and that volume exists,
 * its files are copied onto the documented name. If Docker cannot be listed,
 * the recorded volume is reused so this deploy does not allocate another one.
 */
export function planDockerMemoryVolume(
  agentName: string,
  recordedVolumeId: string | null | undefined,
  listedVolumeNames: string[] | null,
): DockerMemoryPlan {
  const canonical = dockerMemoryVolumeName(agentName)
  if (listedVolumeNames === null) {
    if (recordedVolumeId) return {volumeId: recordedVolumeId, action: 'reuse'}
    return {volumeId: canonical, action: 'create'}
  }
  if (listedVolumeNames.includes(canonical)) {
    return {volumeId: canonical, action: 'reuse'}
  }
  if (
    recordedVolumeId
    && recordedVolumeId !== canonical
    && listedVolumeNames.includes(recordedVolumeId)
  ) {
    return {volumeId: canonical, action: 'create', copyFrom: recordedVolumeId}
  }
  return {volumeId: canonical, action: 'create'}
}

export function dockerMemoryVolumesToRemove(
  agentName: string,
  recordedVolumeIds: Array<string | null | undefined>,
  listedVolumeNames: string[] | null,
): string[] {
  const names = new Set<string>()
  for (const id of recordedVolumeIds) {
    if (id) names.add(id)
  }
  if (listedVolumeNames) {
    for (const name of listedVolumeNames) {
      if (isAgentDockerMemoryVolume(name, agentName)) names.add(name)
    }
  } else {
    names.add(dockerMemoryVolumeName(agentName))
  }
  return [...names].sort()
}

export function dockerVolumeRemovalMessage(volumeId: string, result: DockerCommandResult): string | null {
  if (result.exitCode === 0) return `Memory volume '${volumeId}' has been removed.`
  const detail = `${result.stderr}\n${result.stdout}`
  if (/no such volume/i.test(detail)) return null
  return `Note: Memory volume '${volumeId}' could not be removed (may be in use or already deleted).`
}

/** Local image tag `cast deploy --provider docker` builds and runs. */
export function dockerImageName(agentName: string): string {
  return `cast-${agentName}:latest`
}

export function dockerImageRemovalMessage(imageName: string, result: DockerCommandResult): string | null {
  if (result.exitCode === 0) return `Docker image '${imageName}' has been removed.`
  const detail = `${result.stderr}\n${result.stdout}`
  if (/no such image/i.test(detail)) return null
  return `Note: Docker image '${imageName}' could not be removed (may be in use or already deleted).`
}

export async function removeDockerImage(
  agentName: string,
  run: DockerRunner,
  log: (message: string) => void = console.log,
): Promise<void> {
  const imageName = dockerImageName(agentName)
  let result: DockerCommandResult
  try {
    result = await run(['rmi', imageName])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`Note: Docker image '${imageName}' could not be removed (${message}).`)
    return
  }
  const line = dockerImageRemovalMessage(imageName, result)
  if (line) log(line)
}

async function readDockerVolumeNames(run: DockerRunner): Promise<string[] | null> {
  try {
    const result = await run(['volume', 'ls', '--format', '{{.Name}}'])
    if (result.exitCode !== 0) return null
    return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  } catch {
    return null
  }
}

export interface PreparedDockerMemoryVolume {
  volumeId: string
  message: string
  note?: string
  /** True when this deploy created volumeId. A reused volume is left in place if the registry write fails. */
  created: boolean
}

export async function prepareDockerMemoryVolume(
  agentName: string,
  recordedVolumeId: string | null | undefined,
  imageName: string,
  run: DockerRunner,
): Promise<PreparedDockerMemoryVolume> {
  const listed = await readDockerVolumeNames(run)
  const plan = planDockerMemoryVolume(agentName, recordedVolumeId, listed)
  if (plan.action === 'reuse') {
    return {volumeId: plan.volumeId, message: `Reusing memory volume: ${plan.volumeId}`, created: false}
  }

  const created = await run(['volume', 'create', plan.volumeId])
  if (created.exitCode !== 0) {
    const detail = (created.stderr || created.stdout).trim()
    throw new Error(`Failed to create memory volume '${plan.volumeId}': ${detail}`)
  }
  if (!plan.copyFrom) {
    return {volumeId: plan.volumeId, message: `Creating memory volume: ${plan.volumeId}`, created: true}
  }

  const copied = await run([
    'run', '--rm', '--entrypoint', 'sh',
    '-v', `${plan.copyFrom}:/from:ro`,
    '-v', `${plan.volumeId}:/to`,
    imageName,
    '-c', 'cp -a /from/. /to/',
  ])
  if (copied.exitCode === 0) {
    return {
      volumeId: plan.volumeId,
      message: `Creating memory volume: ${plan.volumeId}`,
      note: `Copied memory from ${plan.copyFrom}.`,
      created: true,
    }
  }

  const removed = await run(['volume', 'rm', plan.volumeId])
  const note = removed.exitCode === 0
    ? `Could not copy memory into '${plan.volumeId}', so the existing volume stays attached.`
    : `Could not copy memory into '${plan.volumeId}', so the existing volume stays attached. The empty volume '${plan.volumeId}' could not be removed.`
  return {
    volumeId: plan.copyFrom,
    message: `Reusing memory volume: ${plan.copyFrom}`,
    note,
    created: false,
  }
}

export async function removeDockerMemoryVolumes(
  agentName: string,
  recordedVolumeIds: Array<string | null | undefined>,
  run: DockerRunner,
  log: (message: string) => void = console.log,
): Promise<void> {
  const listed = await readDockerVolumeNames(run)
  const volumes = dockerMemoryVolumesToRemove(agentName, recordedVolumeIds, listed)
  for (const volumeId of volumes) {
    let result: DockerCommandResult
    try {
      result = await run(['volume', 'rm', volumeId])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Note: Memory volume '${volumeId}' could not be removed (${message}).`)
      continue
    }
    const line = dockerVolumeRemovalMessage(volumeId, result)
    if (line) log(line)
  }
}

function dockerRunner(): DockerRunner {
  return async (args) => {
    const result = await execCommand('docker', args, {silent: true, shell: false})
    return {exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr}
  }
}

function latestDockerVolumeId(agentName: string): string | null {
  const row = db.listDeployments(agentName).find((item: {provider?: string}) => item.provider === 'docker')
  const volumeId = row?.volume_id
  return typeof volumeId === 'string' && volumeId.length > 0 ? volumeId : null
}

export default class DockerDeploy extends Command {
  static description = 'Deploy agent locally with Docker'

  static flags = {
    'no-build': Flags.boolean({description: 'Skip Docker build', default: false}),
    port: Flags.integer({description: 'Port to expose', default: 8080}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DockerDeploy)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    // Record the parent row before the container starts. The deployment
    // insert below also ensures it, but a missing row used to fail only
    // after `docker run` had already left cast-<agent> running.
    db.ensureAgent(agentName, path.join(agentPath, 'agent.yaml'))

    this.log(`Deploying ${agentName} locally with Docker...`)

    // Resolve project root so we can locate python/cast
    // Starting from typescript/cast-cli/dist/lib/deploy, we need to go up 4 levels
    // to reach the project root where python/cast exists
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
      this.error(`Cast Python package not found at ${castPackageSource}. Make sure you're running from the project root.`)
    }

    // Generate auth token and deployment ID
    const authToken = crypto.randomBytes(32).toString('base64')
    const tokenHash = crypto.createHash('sha256').update(authToken).digest('hex')
    const deploymentId = generateDeploymentId()

    // Store token in keychain. A second provider must not replace this token.
    await storeAuthToken(agentName, authToken)

    // The memory volume is chosen after the image builds and the previous
    // container is stopped, so a redeploy can copy files off the volume
    // that container was using.

    // Copy cast runtime package into agent directory so it is inside the Docker build context
    const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
    this.log(`Copying cast runtime to ${castRuntimeDir}...`)
    fs.mkdirSync(path.dirname(castRuntimeDir), {recursive: true})
    if (fs.existsSync(castRuntimeDir)) {
      fs.rmSync(castRuntimeDir, {recursive: true})
    }

    fs.cpSync(castPackageSource, castRuntimeDir, {recursive: true})

    // Generate deployment files
    const dockerfilePath = path.join(agentPath, 'Dockerfile')
    if (!fs.existsSync(dockerfilePath) || !flags['no-build']) {
      this.createDockerfile(agentPath)
    }

    this.createDockerignore(agentPath)
    this.createRequirementsTxt(projectRoot, agentPath)

    const imageName = dockerImageName(agentName)
    const containerName = `cast-${agentName}`

    // Build Docker image
    this.log('Building Docker image...')
    // Use --progress=plain for cleaner output in non-TTY environments (like TUI)
    const buildCode = await runCommand('docker', ['build', '--progress=plain', '--load', '-t', imageName, '-f', dockerfilePath, agentPath])
    if (buildCode !== 0) {
      this.error(`Docker build failed with code ${buildCode}`)
    }

    // Stop existing container if running (ignore errors)
    this.log('Stopping existing container if running...')
    try {
      await runCommand('docker', ['stop', containerName], {stdio: 'ignore'})
    } catch {
      // container may not exist
    }

    // Remove existing container (ignore errors)
    try {
      await runCommand('docker', ['rm', containerName], {stdio: 'ignore'})
    } catch {
      // container may not exist
    }

    let memory: PreparedDockerMemoryVolume
    try {
      memory = await prepareDockerMemoryVolume(
        agentName,
        latestDockerVolumeId(agentName),
        imageName,
        dockerRunner(),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(message)
    }
    this.log(memory.message)
    if (memory.note) this.log(memory.note)
    const volumeId = memory.volumeId
    writeDockerCompose(agentPath, {agentName, port: flags.port, volumeId})

    // Run container
    this.log('Starting Docker container...')
    const dockerRunArgs = [
      'run',
      '-d',
      '--name', containerName,
      '-p', `${flags.port}:8080`,
      '-e', `CAST_AGENT_NAME=${agentName}`,
      '-e', `CAST_AGENT_PATH=/app/agent`,
      '-e', `AUTH_TOKEN=${authToken}`,
      '-e', `PYTHONPATH=/app`,
      '-v', `${volumeId}:/app/agent/memory`,
    ]

    for (const [key, value] of Object.entries(inferenceEnv())) {
      dockerRunArgs.push('-e', `${key}=${value}`)
    }

    dockerRunArgs.push(imageName)

    const runCode = await runCommand('docker', dockerRunArgs)
    if (runCode !== 0) {
      this.error(`Docker run failed with code ${runCode}`)
    }

    this.log('Waiting for the container to become ready...')
    const health = await waitForContainerHealth(() => probeDockerContainer(containerName))
    if (!health.ok) {
      this.error(containerHealthFailureMessage(containerName, health))
    }

    const deploymentUrl = `http://localhost:${flags.port}`
    const volumeConfig = JSON.stringify({ deploymentId, mountPath: '/app/agent/memory' })
    await recordDockerDeployment({
      agentName,
      deploymentUrl,
      tokenHash,
      volumeId,
      volumeConfig,
      containerName,
      removeVolumeOnFailure: memory.created,
    })

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║              Deployment Successful!                          ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Container: ${containerName}`)
    this.log(`Port: ${flags.port}`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    this.log('To view logs:')
    this.log(`  docker logs -f ${containerName}`)
    this.log('')
    this.log('To stop:')
    this.log(`  cast stop ${agentName}`)
  }

  static async destroy(agentName: string): Promise<void> {
    const containerName = `cast-${agentName}`
    // Stop the container (ignore errors if it doesn't exist)
    const stopResult = await execCommand('docker', ['stop', containerName])
    if (stopResult.exitCode !== 0 && !stopResult.stderr.includes('No such container')) {
      console.log(`Warning: Failed to stop container '${containerName}': ${stopResult.stderr}`)
    }
    // Remove the container (ignore errors if it doesn't exist)
    const rmResult = await execCommand('docker', ['rm', containerName])
    if (rmResult.exitCode !== 0 && !rmResult.stderr.includes('No such container')) {
      console.log(`Warning: Failed to remove container '${containerName}': ${rmResult.stderr}`)
    }
    console.log(`Docker container '${containerName}' has been destroyed.`)

    const recorded = db.listDeployments(agentName)
      .filter((row: {provider?: string}) => row.provider === 'docker')
      .map((row: {volume_id?: string | null}) => row.volume_id)
    await removeDockerMemoryVolumes(agentName, recorded, dockerRunner())
    await removeDockerImage(agentName, dockerRunner())
  }

  private createDockerfile(agentPath: string): void {
    const dockerfile = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    git \
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

  private createDockerignore(agentPath: string): void {
    createDockerignore(agentPath)
  }

  private createRequirementsTxt(projectRoot: string, agentPath: string): void {
    // The cast package is copied into the image, so it is filtered out.
    // pyproject.toml dependencies and agent.yaml runtime.requirements are kept.
    writeRequirementsTxt(projectRoot, agentPath)
  }
}

export interface DockerComposeOptions {
  agentName: string
  port: number
  volumeId?: string
}

/**
 * Compose file for a local Docker deploy.
 * The bearer token and provider API keys are passed to `docker run` and
 * are not written here. `cast git` ignores this file.
 */
export function renderDockerCompose(opts: DockerComposeOptions): string {
  const lines = [
    "version: '3.8'",
    '',
    'services:',
    `  ${opts.agentName}:`,
    '    build:',
    '      context: .',
    '      dockerfile: Dockerfile',
    `    container_name: cast-${opts.agentName}`,
    '    ports:',
    `      - "${opts.port}:8080"`,
    '    environment:',
    `      - CAST_AGENT_NAME=${opts.agentName}`,
    '      - CAST_AGENT_PATH=/app/agent',
    '      - PYTHONPATH=/app',
  ]
  if (opts.volumeId) {
    lines.push('    volumes:', `      - ${opts.volumeId}:/app/agent/memory`)
  }
  lines.push('    restart: unless-stopped')
  if (opts.volumeId) {
    lines.push('', 'volumes:', `  ${opts.volumeId}:`)
  }
  return `${lines.join('\n')}\n`
}

export function writeDockerCompose(agentPath: string, opts: DockerComposeOptions): void {
  fs.writeFileSync(path.join(agentPath, 'docker-compose.yml'), renderDockerCompose(opts))
  ensureDockerDeployArtifactsIgnored(agentPath)
}

export interface DockerDeploymentRecord {
  agentName: string
  deploymentUrl: string
  tokenHash: string
  volumeId: string
  volumeConfig: string
  containerName: string
  /** When false, a failed registry write leaves the memory volume in place. Defaults to removing it. */
  removeVolumeOnFailure?: boolean
}

// Persist the deployment under CAST_DEPLOYMENT_SHA when cast deploy set
// one, so the printed SHA is the row in the registry. If that write fails,
// stop and remove the container and volume that docker run already started.
export async function recordDockerDeployment(input: DockerDeploymentRecord): Promise<string> {
  try {
    return saveDeployment(
      input.agentName,
      'docker',
      input.deploymentUrl,
      input.tokenHash,
      input.volumeId,
      input.volumeConfig,
    )
  } catch (error) {
    const volumeToRemove = input.removeVolumeOnFailure === false ? '' : input.volumeId
    const cleanup = await removeStartedDockerResources(input.containerName, volumeToRemove)
    if (cleanup) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${message}. Failed to remove container '${input.containerName}': ${cleanup}`,
      )
    }
    throw error
  }
}

async function removeStartedDockerResources(containerName: string, volumeId: string): Promise<string | null> {
  const problems: string[] = []
  const stop = await runDocker(['stop', containerName])
  const removed = await runDocker(['rm', containerName])
  const volume = volumeId ? await runDocker(['volume', 'rm', volumeId]) : {exitCode: 0, stderr: ''}

  if (stop.exitCode !== 0 && !/No such container/i.test(stop.stderr)) {
    problems.push(stop.stderr.trim() || `docker stop exited ${stop.exitCode}`)
  }
  if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
    problems.push(removed.stderr.trim() || `docker rm exited ${removed.exitCode}`)
  }
  if (volume.exitCode !== 0 && !/No such volume/i.test(volume.stderr)) {
    problems.push(volume.stderr.trim() || `docker volume rm exited ${volume.exitCode}`)
  }
  return problems.length > 0 ? problems.join('; ') : null
}

async function runDocker(args: string[]): Promise<{exitCode: number; stderr: string}> {
  try {
    const result = await execCommand('docker', args)
    return {exitCode: result.exitCode, stderr: result.stderr || ''}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {exitCode: 1, stderr: message}
  }
}
