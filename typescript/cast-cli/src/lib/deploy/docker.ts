import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {ensureDockerDeployArtifactsIgnored} from '../cast-ignore'
import {db} from '../sqlite'
import {containerHealthFailureMessage, probeDockerContainer, waitForContainerHealth} from './container-health'
import {execCommand, inferenceEnv, generateDeploymentId, getVolumeName, createMemoryVolume, deleteMemoryVolume, createDockerignore, storeAuthToken} from './deploy-utils'
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
    const volumeId = getVolumeName(agentName, deploymentId)

    // Store token in keychain. A second provider must not replace this token.
    await storeAuthToken(agentName, authToken)

    // Create memory volume
    this.log(`Creating memory volume: ${volumeId}`)
    await createMemoryVolume('docker', agentName, deploymentId)

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
    writeDockerCompose(agentPath, {agentName, port: flags.port, volumeId})

    const imageName = `cast-${agentName}:latest`
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
    db.setDeployment(agentName, 'docker', deploymentUrl, tokenHash, volumeId, volumeConfig)

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
    this.log(`  docker stop ${containerName}`)
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

    // Clean up memory volume
    const deployment = db.getDeployment(agentName)
    if (deployment?.volume_id) {
      try {
        await execCommand('docker', ['volume', 'rm', deployment.volume_id])
        console.log(`Memory volume '${deployment.volume_id}' has been removed.`)
      } catch {
        console.log(`Note: Memory volume '${deployment.volume_id}' could not be removed (may be in use or already deleted).`)
      }
    }
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
