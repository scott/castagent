import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import DockerDeploy from '../lib/deploy/docker'
import RailwayDeploy from '../lib/deploy/railway'
import FlyDeploy from '../lib/deploy/fly'
import DigitalOceanDeploy from '../lib/deploy/digitalocean'
import SpritesDeploy from '../lib/deploy/sprites'
import {checkCli, getProviderToken, generateDeploymentSha} from '../lib/deploy/deploy-utils'
import {getCurrentRelease} from '../lib/releases'
import {db} from '../lib/sqlite'

const VALID_PROVIDERS = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']

interface ProviderInfo {
  name: string
  description: string
  cliCommand: string
  cliInstallUrl: string
  authCommand?: string
  authEnvVar?: string
  authConfigKey?: string
}

const PROVIDERS: Record<string, ProviderInfo> = {
  railway: {
    name: 'Railway',
    description: 'Managed containers with automatic deployments',
    cliCommand: 'railway',
    cliInstallUrl: 'https://docs.railway.app/getting-started/installation',
    authCommand: 'railway login',
  },
  fly: {
    name: 'Fly.io',
    description: 'Distributed containers close to your users',
    cliCommand: 'flyctl',
    cliInstallUrl: 'https://fly.io/docs/hands-on/install-flyctl/',
    authCommand: 'flyctl auth login',
  },
  digitalocean: {
    name: 'DigitalOcean',
    description: 'Droplet with Docker container hosting',
    cliCommand: 'doctl',
    cliInstallUrl: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
    authCommand: 'doctl auth init',
    authEnvVar: 'DIGITALOCEAN_ACCESS_TOKEN',
    authConfigKey: 'providers.digitalocean.token',
  },
  sprites: {
    name: 'Sprites',
    description: 'Persistent Firecracker VMs on Fly.io (sprites.dev)',
    cliCommand: 'sprite',
    cliInstallUrl: 'https://sprites.dev/install.sh',
    authCommand: 'sprite login',
    authEnvVar: 'SPRITES_TOKEN',
  },
  docker: {
    name: 'Docker (local)',
    description: 'Self-hosted Docker container on this machine',
    cliCommand: 'docker',
    cliInstallUrl: 'https://docs.docker.com/get-docker/',
  },
  local: {
    name: 'Local (no container)',
    description: 'Run the agent directly on this machine without Docker',
    cliCommand: '',
    cliInstallUrl: '',
  },
}

export default class Deploy extends Command {
  static description = 'Deploy agent to hosting provider'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> email-agent --provider railway',
    '<%= config.bin %> <%= command.id %> email-agent --provider fly',
    '<%= config.bin %> <%= command.id %> email-agent --provider digitalocean',
    '<%= config.bin %> <%= command.id %> email-agent --provider docker',
    '<%= config.bin %> <%= command.id %> email-agent --provider local',
  ]

  static flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip all interactive prompts (auto-commit uncommitted changes before deploying)',
      default: false,
    }),
    provider: Flags.string({
      description: 'Deployment provider',
      options: VALID_PROVIDERS,
    }),
    port: Flags.integer({
      description: 'Port for local deployment',
      default: 8080,
    }),
    version: Flags.string({
      description: 'Release version to deploy (defaults to latest/current state)',
      default: 'latest',
    }),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private async prompt(question: string): Promise<string> {
    // Ensure stdin is in raw mode for proper input handling
    if (process.stdin.isTTY && !process.stdin.isRaw) {
      readline.emitKeypressEvents(process.stdin)
      ;(process.stdin as any).setRawMode?.(true)
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })

    return new Promise((resolve, reject) => {
      // Handle non-TTY environments gracefully
      if (!process.stdin.isTTY) {
        rl.close()
        reject(new Error('Cannot prompt in non-interactive mode. Use --force flag to skip prompts.'))
        return
      }

      rl.question(question, (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  private async confirm(message: string, force = false): Promise<boolean> {
    // Use --force flag in non-interactive mode
    if (force) {
      this.log(`${message} (y/N) - force flag set, assuming yes`)
      return true
    }

    try {
      const answer = await this.prompt(`${message} (y/N) `)
      return answer.toLowerCase() === 'y'
    } catch (error) {
      // If prompt fails (non-TTY), default to false
      this.log(`${message} - prompt failed, defaulting to no`)
      return false
    }
  }

  private async selectProvider(): Promise<string> {
    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║           Select a Deployment Provider                       ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')

    const providerEntries = Object.entries(PROVIDERS)
    for (let i = 0; i < providerEntries.length; i++) {
      const [key, info] = providerEntries[i]
      this.log(`  ${i + 1}. ${info.name}`)
      this.log(`     ${info.description}`)
      this.log('')
    }

    const answer = await this.prompt('Enter number (1-' + providerEntries.length + '): ')
    const index = parseInt(answer, 10) - 1

    if (isNaN(index) || index < 0 || index >= providerEntries.length) {
      this.error('Invalid selection. Please run the command again and enter a valid number.')
    }

    return providerEntries[index][0]
  }

  private async prepareVersionForDeploy(agentName: string, agentPath: string, version: string): Promise<void> {
    if (version === 'latest') {
      return // Use current working state
    }

    // Extract specific release tarball
    const {getRelease, extractRelease} = await import('../lib/releases')
    const release = await getRelease(agentName, version)
    if (!release) {
      this.error(`Release ${version} not found. Run 'cast release ${agentName} ${version}' first.`)
    }

    // Extract release to agent directory
    await extractRelease(agentName, version, agentPath)
    this.log(`Using release ${version} from ${release.tarball_path}`)
  }

  private async walkthroughProviderSetup(provider: string, force = false): Promise<void> {
    const info = PROVIDERS[provider]
    if (!info) return

    // Cloud provider CLI check
    if (info.cliCommand && provider !== 'docker' && provider !== 'local') {
      let cliInstalled = false
      try {
        await checkCli(info.cliCommand, info.cliInstallUrl)
        cliInstalled = true
      } catch {
        cliInstalled = false
      }

      if (!cliInstalled) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log(`  ${info.name} CLI is not installed`)
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log('To deploy to ' + info.name + ', you need the ' + info.cliCommand + ' CLI.')
        this.log('')
        this.log('Install it:')
        this.log('  ' + info.cliInstallUrl)
        this.log('')
        this.log('Quick install commands:')
        if (provider === 'railway') {
          this.log('  npm install -g @railway/cli')
          this.log('  # or')
          this.log('  brew install railway')
        } else if (provider === 'fly') {
          this.log('  curl -L https://fly.io/install.sh | sh')
          this.log('  # or')
          this.log('  brew install flyctl')
        }
        this.log('')
        const ready = await this.confirm('Have you installed the CLI and are ready to continue?', force)
        if (!ready) {
          this.log('')
          this.log('Deployment cancelled. Run again when you are ready.')
          this.exit(0)
        }
      }

      // Auth check for providers that use CLI login
      if (info.authCommand) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log(`  Authenticate with ${info.name}`)
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log('You need to be logged in to ' + info.name + '.')
        this.log('')
        this.log('Run this command in another terminal:')
        this.log('  ' + info.authCommand)
        this.log('')
        const ready = await this.confirm('Have you logged in and are ready to continue?', force)
        if (!ready) {
          this.log('')
          this.log('Deployment cancelled. Run again when you are authenticated.')
          this.exit(0)
        }
      }

      // API token check for DigitalOcean
      if (provider === 'digitalocean') {
        const token = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
        if (!token) {
          this.log('')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('  DigitalOcean API Token Required')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('')
          this.log('You need a DigitalOcean API token to deploy.')
          this.log('')
          this.log('Get your token:')
          this.log('  1. Visit https://cloud.digitalocean.com/account/api/tokens')
          this.log('  2. Click "Generate New Token"')
          this.log('  3. Give it a name (e.g., "cast-deploy")')
          this.log('  4. Copy the token')
          this.log('')
          this.log('Then set it via one of these methods:')
          this.log('  export DIGITALOCEAN_ACCESS_TOKEN=<your-token>')
          this.log('  # or add to ~/.cast/config.yaml:')
          this.log('  providers:')
          this.log('    digitalocean:')
          this.log('      token: ${DIGITALOCEAN_ACCESS_TOKEN}')
          this.log('')
          const ready = await this.confirm('Have you set your DigitalOcean API token and are ready to continue?', force)
          if (!ready) {
            this.log('')
            this.log('Deployment cancelled. Run again when your token is configured.')
            this.exit(0)
          }
        }

        // doctl check
        try {
          await checkCli('doctl', 'https://docs.digitalocean.com/reference/doctl/how-to/install/')
        } catch {
          this.log('')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('  doctl CLI Required')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('')
          this.log('You need the doctl CLI to deploy to DigitalOcean.')
          this.log('')
          this.log('Install it:')
          this.log('  brew install doctl')
          this.log('  # or visit: https://docs.digitalocean.com/reference/doctl/how-to/install/')
          this.log('')
          this.log('Then authenticate:')
          this.log('  doctl auth init')
          this.log('')
          this.error('doctl is required for DigitalOcean deployment.')
        }
      }

      // Auth check for Sprites
      if (provider === 'sprites') {
        try {
          await checkCli('sprite', 'https://sprites.dev/install.sh')
        } catch {
          this.log('')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('  Sprites CLI Required')
          this.log('─────────────────────────────────────────────────────────────')
          this.log('')
          this.log('You need the Sprites CLI to deploy.')
          this.log('')
          this.log('Install it:')
          this.log('  curl https://sprites.dev/install.sh | bash')
          this.log('')
          this.log('Then authenticate:')
          this.log('  sprite login')
          this.log('  # or set SPRITES_TOKEN environment variable')
          this.log('')
          this.error('Sprites CLI is required.')
        }
      }
    }

    // Docker check for docker and digitalocean providers
    if (provider === 'docker' || provider === 'digitalocean') {
      let dockerInstalled = false
      try {
        await checkCli('docker', 'https://docs.docker.com/get-docker/')
        dockerInstalled = true
      } catch {
        dockerInstalled = false
      }

      if (!dockerInstalled) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log('  Docker is not installed')
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log('Docker is required for this deployment option.')
        this.log('')
        this.log('Install it:')
        this.log('  https://docs.docker.com/get-docker/')
        this.log('')
        this.log('Quick install commands:')
        this.log('  # macOS:')
        this.log('  brew install --cask docker')
        this.log('  # Linux:')
        this.log('  curl -fsSL https://get.docker.com | sh')
        this.log('')
        const ready = await this.confirm('Have you installed Docker and are ready to continue?', force)
        if (!ready) {
          this.log('')
          this.log('Deployment cancelled. Run again when Docker is installed.')
          this.exit(0)
        }
      }

      if (provider === 'docker') {
        const isRunning = await this.checkDockerRunning()
        if (!isRunning) {
          this.log('')
          this.log('Docker daemon is not running.')
          this.log('')
          this.log('Start Docker:')
          this.log('  - macOS: Open Docker Desktop')
          this.log('  - Linux: sudo systemctl start docker')
          this.log('')
          const ready = await this.confirm('Is Docker running now?', force)
          if (!ready) {
            this.log('')
            this.log('Deployment cancelled. Start Docker and run again.')
            this.exit(0)
          }
        }
      }
    }
  }

  private async checkDockerRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('docker', ['info'], {stdio: 'ignore'})
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })
  }

  private async checkProviderTools(provider: string): Promise<void> {
    switch (provider) {
      case 'docker': {
        try {
          await checkCli('docker', 'https://docs.docker.com/get-docker/')
        } catch (error: any) {
          this.error(`Docker is not installed or not in PATH.\nInstall it from: https://docs.docker.com/get-docker/`)
        }

        const isRunning = await this.checkDockerRunning()
        if (!isRunning) {
          this.error('Docker daemon is not running. Start Docker Desktop or the Docker service.')
        }

        break
      }

      case 'railway': {
        try {
          await checkCli('railway', 'https://docs.railway.app/getting-started/installation')
        } catch (error: any) {
          this.error(`Railway CLI is not installed.\nInstall it from: https://docs.railway.app/getting-started/installation`)
        }

        break
      }

      case 'fly': {
        try {
          await checkCli('flyctl', 'https://fly.io/docs/hands-on/install-flyctl/')
        } catch (error: any) {
          this.error(`Fly.io CLI (flyctl) is not installed.\nInstall it from: https://fly.io/docs/hands-on/install-flyctl/`)
        }

        break
      }

      case 'digitalocean': {
        try {
          await checkCli('docker', 'https://docs.docker.com/get-docker/')
        } catch (error: any) {
          this.error(`Docker is required for DigitalOcean deployment.\nInstall it from: https://docs.docker.com/get-docker/`)
        }

        break
      }
    }
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Deploy)
    const agentName = args.agent
    let provider = flags.provider
    const version = flags.version

    // Validate agent exists
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(
        `Agent '${agentName}' not found at ${agentPath}.\n` +
        `Create the agent first with: cast dev ${agentName} --no-tui`
      )
    }

    // Prepare version for deploy (extract specific release tarball if needed)
    await this.prepareVersionForDeploy(agentName, agentPath, version)

    // Check if agent is a git repo and prompt for commit
    const gitDir = path.join(agentPath, '.git')
    if (fs.existsSync(gitDir)) {
      const simpleGit = await import('simple-git')
      const git = simpleGit.default(agentPath)
      const status = await git.status()

      if (!status.isClean()) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log('  Uncommitted Changes Detected')
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log(`'${agentName}' has uncommitted changes.`)
        this.log('')

        let commitNow = false
        if (flags.force) {
          commitNow = true
          this.log('Auto-committing (--force flag is set)...')
        } else {
          commitNow = await this.confirm('Commit changes before deploying?')
        }

        if (commitNow) {
          const timestamp = new Date().toISOString()
          await git.add('.')
          await git.commit(`Auto-commit before deployment: ${timestamp}`)
          this.log('Changes committed.')
        } else {
          this.log('Proceeding without committing.')
        }
      }
    }

    // Interactive provider selection if not specified
    if (!provider) {
      provider = await this.selectProvider()
      await this.walkthroughProviderSetup(provider, flags.force)
    }

    // Validate provider name
    if (!VALID_PROVIDERS.includes(provider)) {
      this.error(
        `Invalid provider '${provider}'.\n` +
        `Valid providers: ${VALID_PROVIDERS.join(', ')}`
      )
    }

    this.log(`Deploying ${agentName} to ${provider}...`)

    // Generate deployment SHA upfront
    const deploymentSha = generateDeploymentSha(agentName)
    process.env.CAST_DEPLOYMENT_SHA = deploymentSha

    // Check provider CLI tools before attempting deployment
    await this.checkProviderTools(provider)

    try {
      switch (provider) {
        case 'docker': {
          await DockerDeploy.run([agentName, '--port', flags.port.toString()])
          break
        }

        case 'local': {
          this.log('Local deployment: Spawning agent in production mode...')
          // TODO: Implement local production deployment
          this.log('Not yet implemented. Use --provider docker for now.')
          break
        }

        case 'railway': {
          await RailwayDeploy.run([agentName])
          break
        }

        case 'fly': {
          await FlyDeploy.run([agentName])
          break
        }

        case 'digitalocean': {
          await DigitalOceanDeploy.run([agentName])
          break
        }

        case 'sprites': {
          await SpritesDeploy.run([agentName])
          break
        }

        default: {
          this.error(`Unknown provider: ${provider}`)
        }
      }

      // Store deployed version after successful deployment
      // Now using semantic versions
      let versionToStore = version
      if (version === 'latest') {
        // Get the current release version or use 'latest' for working state
        const currentRelease = await getCurrentRelease(agentName)
        versionToStore = currentRelease || 'latest'
      }
      db.updateDeployedVersion(agentName, versionToStore)

      this.log('')
      this.log(`Deployed ${agentName} with deployment SHA: ${deploymentSha}`)
      this.log(`Connect with: cast connect ${deploymentSha}`)
    } catch (error: any) {
      if (error.oclif && error.oclif.exit !== undefined) {
        // Re-throw oclif errors (already formatted)
        throw error
      }

      this.error(
        `Deployment to ${provider} failed.\n\n` +
        `Error: ${error.message || error}\n\n` +
        `Troubleshooting:\n` +
        `  - Ensure the provider CLI is properly authenticated\n` +
        `  - Check your network connection\n` +
        `  - Review the logs above for more details`
      )
    }
  }
}
