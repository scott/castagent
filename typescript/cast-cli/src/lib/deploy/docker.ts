import {Args, Command, Flags} from '@oclif/core'
import {execSync, spawn} from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {db} from '../sqlite'
import {execCommand, inferenceEnv, generateDeploymentId, getVolumeName, createMemoryVolume, deleteMemoryVolume, createDockerignore, storeAuthToken} from './deploy-utils'

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
    this.createDockerCompose(agentPath, agentName, flags.port, authToken, volumeId)

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
    // Try to generate requirements from the project's venv
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

    // Filter out the cast package since it's copied directly into the image
    requirements = requirements
      .split('\n')
      .filter(line => {
        const trimmed = line.trim().toLowerCase()
        // Remove exact 'cast' package (editable, VCS, or normal install) and castagent repo refs
        return !/^cast\b/.test(trimmed) && !trimmed.includes('castagent')
      })
      .join('\n')

    fs.writeFileSync(path.join(agentPath, 'requirements.txt'), requirements)
  }

  private createDockerCompose(
    agentPath: string,
    agentName: string,
    port: number,
    authToken: string,
    volumeId: string,
  ): void {
    const inferenceLines = Object.entries(inferenceEnv())
      .map(([key, value]) => `      - ${key}=${value}`)
      .join('\n')
    const compose = `version: '3.8'

services:
  ${agentName}:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: cast-${agentName}
    ports:
      - "${port}:8080"
    environment:
      - CAST_AGENT_NAME=${agentName}
      - CAST_AGENT_PATH=/app/agent
      - AUTH_TOKEN=${authToken}
      - PYTHONPATH=/app
${inferenceLines}
    volumes:
      - ${volumeId}:/app/agent/memory
    restart: unless-stopped

volumes:
  ${volumeId}:
`
    fs.writeFileSync(path.join(agentPath, 'docker-compose.yml'), compose)
  }
}
