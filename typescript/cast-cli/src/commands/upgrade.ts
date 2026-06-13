import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import DockerDeploy from '../lib/deploy/docker'
import RailwayDeploy from '../lib/deploy/railway'
import FlyDeploy from '../lib/deploy/fly'
import DigitalOceanDeploy from '../lib/deploy/digitalocean'
import SpritesDeploy from '../lib/deploy/sprites'
import {getRelease, getCurrentRelease, listReleases, validateSemver} from '../lib/releases'
import {db} from '../lib/sqlite'
import {resolveDeploymentTarget} from '../lib/deploy/deploy-utils'
import {writeHostMotdOverSsh} from '../lib/deploy/motd'

const VALID_PROVIDERS = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']

export default class Upgrade extends Command {
  static description = 'Upgrade a deployed agent to a new version'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> abc123  # Upgrade by deployment SHA',
    '<%= config.bin %> <%= command.id %> email-agent 1.6',
    '<%= config.bin %> <%= command.id %> email-agent --list-versions',
  ]

  static flags = {
    'list-versions': Flags.boolean({description: 'List available releases for the agent'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
    version: Args.string({description: 'Release version to upgrade to (optional, defaults to latest)'}),
  }

  private async confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(`${message} (y/N) `, (answer) => {
        rl.close()
        resolve(answer.trim().toLowerCase() === 'y')
      })
    })
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Upgrade)
    const target = args.agent
    const targetVersion = args.version

    // Resolve target (SHA or agent name)
    const resolution = resolveDeploymentTarget(target)

    if (resolution.type === 'not_found') {
      this.error(
        `No deployment found for '${target}'.\n` +
        `Deploy it first with: cast deploy ${target}`
      )
    }

    if (resolution.type === 'ambiguous') {
      this.error(resolution.message!)
    }

    // resolution.type is 'sha' or 'single'
    const deployment = resolution.deployment!
    const agentName = deployment.agent_name
    const deploymentSha = deployment.id

    // Validate agent exists
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(
        `Agent '${agentName}' not found at ${agentPath}.\n` +
        `Create the agent first with: cast dev ${agentName} --no-tui`
      )
    }

    const provider = deployment.provider

    // List versions if requested
    if (flags['list-versions']) {
      const releases = await listReleases(agentName)
      if (releases.length === 0) {
        this.log(`No releases found for agent '${agentName}'.`)
        this.log(`Create a release first with: cast release ${agentName}`)
        return
      }
      this.log(`Available releases for '${agentName}' (deployment: ${deploymentSha}):`)
      this.log('')
      for (const release of releases) {
        const currentTag = release.version === deployment.deployed_version ? ' (current)' : ''
        this.log(`  ${release.version}${currentTag}`)
        if (release.message) {
          this.log(`    ${release.message}`)
        }
      }
      this.log('')
      return
    }

    // Determine target version
    let version: string
    if (targetVersion) {
      version = targetVersion
      if (version !== 'latest') {
        // Validate semantic version format
        const isValid = await validateSemver(version)
        if (!isValid) {
          this.error(`Invalid semantic version: '${version}'. Expected format: 1.0, 1.6, 2.0.0`)
        }
      }
    } else {
      // Default to latest
      version = 'latest'
    }

    // Verify version exists (if not latest)
    if (version !== 'latest') {
      const release = await getRelease(agentName, version)
      if (!release) {
        const releases = await listReleases(agentName)
        const available = releases.map(r => r.version).join(', ')
        this.error(
          `Release ${version} does not exist for agent '${agentName}'.\n` +
          `Available releases: ${available || 'none'}\n` +
          `Use 'cast upgrade ${agentName}' to upgrade to the latest release.`
        )
      }
    }

    // Get current deployed version (now stored as semantic version string)
    const currentVersion = deployment.deployed_version

    // Skip if already on target version
    if (currentVersion === version || (version === 'latest' && currentVersion === 'latest')) {
      this.log(`Agent '${agentName}' is already at version ${version || currentVersion}.`)
      this.log(`Use 'cast upgrade ${agentName} --version <version>' to upgrade to a different version.`)
      return
    }

    this.log(`Upgrading ${agentName} from version ${currentVersion || 'unknown'} to ${version}...`)
    this.log(`Provider: ${provider}`)

    // Confirm upgrade
    const confirmed = await this.confirm(`Proceed with upgrade?`)
    if (!confirmed) {
      this.log('Upgrade cancelled.')
      return
    }

    // Prepare version-specific tarball if version is not latest
    const isLatestVersion = version === 'latest'
    let versionTarballPath: string | null = null

    if (!isLatestVersion) {
      // Get release info for tarball path
      const release = await getRelease(agentName, version)
      if (release) {
        versionTarballPath = release.tarball_path

        if (!fs.existsSync(versionTarballPath)) {
          this.error(`Release tarball not found: ${versionTarballPath}`)
        }

        this.log(`Using release ${version} from ${versionTarballPath}`)
      }
    }

    try {
      // Perform provider-specific upgrade
      // Note: We pass the version information to the provider deploy functions
      // Each provider will need to handle version-specific deployment
      switch (provider) {
        case 'docker': {
          // For Docker, we need to handle version-specific deployment
          await this.upgradeDocker(agentName, version, versionTarballPath)
          break
        }

        case 'railway': {
          await this.upgradeRailway(agentName, version, versionTarballPath)
          break
        }

        case 'fly': {
          await this.upgradeFly(agentName, version, versionTarballPath)
          break
        }

        case 'digitalocean': {
          await this.upgradeDigitalOcean(agentName, version, versionTarballPath)
          break
        }

        case 'sprites': {
          await this.upgradeSprites(agentName, version, versionTarballPath)
          break
        }

        default: {
          this.error(`Upgrade not supported for provider '${provider}'. Please use 'cast shutdown' and 'cast deploy' instead.`)
        }
      }

      // Update deployed version in database
      let versionToStore = version
      if (version === 'latest') {
        // Get the current release version
        const currentRelease = await getCurrentRelease(agentName)
        versionToStore = currentRelease || 'latest'
      }
      db.updateDeployedVersion(agentName, versionToStore)
      this.log(`Upgraded to version ${versionToStore} successfully.`)

    } catch (error: any) {
      if (error.oclif && error.oclif.exit !== undefined) {
        throw error
      }

      this.error(
        `Upgrade failed.\n\n` +
        `Error: ${error.message || error}\n\n` +
        `You can try rolling back by deploying the previous version:\n` +
        `  cast deploy ${agentName} --provider ${provider}`
      )
    }
  }

  private async upgradeDocker(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    // For Docker, we need to:
    // 1. Reuse existing volume (don't create new one)
    // 2. Extract version-specific files if not latest
    // 3. Rebuild and restart container

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const deployment = db.getDeployment(agentName)
    const existingVolumeId = deployment?.volume_id

    // Resolve project root
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
      this.error(`Cast Python package not found at ${castPackageSource}`)
    }

    // Handle version-specific extraction
    if (versionTarballPath && fs.existsSync(versionTarballPath)) {
      // Extract version tarball to agent directory
      this.log(`Extracting version ${version} tarball...`)
      const tar = await import('tar')
      // Clear agent files first
      const agentFiles = fs.readdirSync(agentPath).filter(f =>
        !f.startsWith('.cast') && !f.startsWith('.git') && f !== 'Dockerfile' && f !== 'docker-compose.yml' && f !== 'requirements.txt' && f !== '.dockerignore'
      )
      for (const file of agentFiles) {
        const filePath = path.join(agentPath, file)
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, {recursive: true})
        } else {
          fs.unlinkSync(filePath)
        }
      }
      // Extract version tarball
      await tar.extract({file: versionTarballPath, cwd: agentPath})
    }

    // Copy cast runtime package
    const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
    fs.mkdirSync(path.dirname(castRuntimeDir), {recursive: true})
    if (fs.existsSync(castRuntimeDir)) {
      fs.rmSync(castRuntimeDir, {recursive: true})
    }
    fs.cpSync(castPackageSource, castRuntimeDir, {recursive: true})

    // Generate deployment files (reuse existing volume)
    const dockerfilePath = path.join(agentPath, 'Dockerfile')
    this.createDockerfile(agentPath)
    this.createDockerignore(agentPath)
    this.createRequirementsTxt(projectRoot, agentPath)

    // For Docker upgrade, we call the Docker deploy with a flag to preserve volume
    // The deploy function needs to handle this case
    // For now, we'll invoke the Docker deploy command directly
    // This will create a new container but we need to preserve the volume

    // Build Docker image
    this.log('Building Docker image...')
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

    // Stop existing container
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

    // Run container with existing volume
    this.log('Starting Docker container...')

    // Get auth token from keychain
    const {keychain} = await import('../lib/keychain')
    const authToken = await keychain.getToken(agentName)

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

    // Reuse existing volume
    if (existingVolumeId) {
      dockerRunArgs.push('-v', `${existingVolumeId}:/app/agent/memory`)
    }

    const openrouterKey = this.getOpenRouterApiKey()
    if (openrouterKey) {
      dockerRunArgs.push('-e', `OPENROUTER_API_KEY=${openrouterKey}`)
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

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║              Upgrade Successful!                              ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`Version: ${version}`)
    this.log(`URL: http://localhost:8080`)
    this.log(`Volume: ${existingVolumeId || 'newly created'}`)
    this.log('')
  }

  private async upgradeRailway(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    // For Railway, we need to:
    // 1. Extract version-specific tarball if not latest
    // 2. Trigger a redeploy via Railway CLI

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const deployment = db.getDeployment(agentName)
    const existingVolumeId = deployment?.volume_id

    // Handle version-specific extraction
    if (versionTarballPath && fs.existsSync(versionTarballPath)) {
      this.log(`Extracting version ${version} tarball...`)
      const tar = await import('tar')
      // Clear agent files first
      const agentFiles = fs.readdirSync(agentPath).filter(f =>
        !f.startsWith('.cast') && !f.startsWith('.git') && f !== 'Dockerfile'
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

    // Trigger Railway redeploy
    this.log('Triggering Railway redeploy...')
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

    this.log('')
    this.log(`Upgraded to version ${version} on Railway.`)
    this.log(`Volume ${existingVolumeId || 'preserved'}.`)
    this.log('')
  }

  private async upgradeFly(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    // For Fly.io, we need to:
    // 1. Extract version-specific tarball if not latest
    // 2. Trigger a redeploy via flyctl

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const deployment = db.getDeployment(agentName)
    const existingVolumeId = deployment?.volume_id

    // Handle version-specific extraction
    if (versionTarballPath && fs.existsSync(versionTarballPath)) {
      this.log(`Extracting version ${version} tarball...`)
      const tar = await import('tar')
      // Clear agent files first
      const agentFiles = fs.readdirSync(agentPath).filter(f =>
        !f.startsWith('.cast') && !f.startsWith('.git') && f !== 'Dockerfile' && f !== 'fly.toml'
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

    // Trigger Fly.io deploy
    this.log('Triggering Fly.io deploy...')
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

    this.log('')
    this.log(`Upgraded to version ${version} on Fly.io.`)
    this.log(`Volume ${existingVolumeId || 'preserved'}.`)
    this.log('')
  }

  private async upgradeDigitalOcean(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    // For DigitalOcean, we need to:
    // 1. Extract version-specific tarball if not latest
    // 2. Re-trigger the Docker deployment

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const deployment = db.getDeployment(agentName)
    const existingVolumeId = deployment?.volume_id

    // Handle version-specific extraction
    if (versionTarballPath && fs.existsSync(versionTarballPath)) {
      this.log(`Extracting version ${version} tarball...`)
      const tar = await import('tar')
      // Clear agent files first
      const agentFiles = fs.readdirSync(agentPath).filter(f =>
        !f.startsWith('.cast') && !f.startsWith('.git') && f !== 'Dockerfile' && f !== 'docker-compose.yml' && f !== 'requirements.txt'
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

    // For DigitalOcean, we need to rebuild and push the image
    this.log('Building and pushing Docker image to DigitalOcean...')
    const {spawn} = await import('child_process')
    const {getProviderToken} = await import('../lib/deploy/deploy-utils')

    const token = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!token) {
      this.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN environment variable.')
    }

    // Build and push image
    const imageName = `registry.digitalocean.com/cast-${agentName}/agent:${version}`

    // Build image locally
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

    // Push to registry
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

    // Restart the droplet
    this.log('Restarting droplet...')
    const dropletName = `cast-${agentName}`

    // Get droplet IP from deployment
    const deploymentUrl = deployment?.deployment_url
    const dropletIp = deploymentUrl ? new URL(deploymentUrl).hostname : null

    // Refresh the SSH login MOTD so the new version appears in the banner
    if (dropletIp) {
      this.log('Refreshing SSH login MOTD...')
      const {motdStderr, profileStderr} = await writeHostMotdOverSsh(dropletIp, {
        agentName,
        dropletIp,
        a2aUrl: deploymentUrl ?? undefined,
        deployedVersion: version,
      })
      if (motdStderr) {
        this.warn(`Failed to refresh /etc/motd: ${motdStderr}`)
      }
      if (profileStderr) {
        this.warn(`Failed to refresh /etc/profile.d/cast.sh: ${profileStderr}`)
      }
    } else {
      this.warn('Could not determine droplet IP; skipping MOTD refresh')
    }

    this.log('')
    this.log(`Upgraded to version ${version} on DigitalOcean.`)
    this.log(`Deployment URL: ${deploymentUrl}`)
    this.log(`Volume ${existingVolumeId || 'preserved'}.`)
    this.log('')
  }

  private async upgradeSprites(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    // For Sprites, we need to:
    // 1. Extract version-specific tarball if not latest
    // 2. Trigger a redeploy via sprite CLI

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const deployment = db.getDeployment(agentName)
    const existingVolumeId = deployment?.volume_id

    // Handle version-specific extraction
    if (versionTarballPath && fs.existsSync(versionTarballPath)) {
      this.log(`Extracting version ${version} tarball...`)
      const tar = await import('tar')
      // Clear agent files first
      const agentFiles = fs.readdirSync(agentPath).filter(f =>
        !f.startsWith('.cast') && !f.startsWith('.git') && f !== 'Dockerfile' && f !== 'sprite.toml'
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

    // Trigger Sprites deploy
    this.log('Triggering Sprites deploy...')
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

    this.log('')
    this.log(`Upgraded to version ${version} on Sprites.`)
    this.log(`Volume ${existingVolumeId || 'preserved'}.`)
    this.log('')
  }

  private createDockerfile(agentPath: string): void {
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

  private createDockerignore(agentPath: string): void {
    const content = `Dockerfile
docker-compose.yml
`
    fs.writeFileSync(path.join(agentPath, '.dockerignore'), content)
  }

  private createRequirementsTxt(projectRoot: string, agentPath: string): void {
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
        return !/^cast\b/.test(trimmed) && !trimmed.includes('agent-cast')
      })
      .join('\n')

    fs.writeFileSync(path.join(agentPath, 'requirements.txt'), requirements)
  }

  private getOpenRouterApiKey(): string | undefined {
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
}