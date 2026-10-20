import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import {loadAgentYaml} from '../lib/agent-yaml'
import {MISSING_AGENT_VERSION, readAgentYamlVersion, type AgentYamlVersion} from '../lib/agent-version'
import {checkCli, generateAuthToken, generateDeploymentSha} from '../lib/deploy/deploy-utils'
import {stagePythonRequirements} from '../lib/deploy/requirements'
import {
  deploymentProviderKeys,
  deploymentProviderLoadErrors,
  getDeploymentProvider,
  isBuiltinDeploymentProvider,
  listDeploymentProviders,
  resolveProviderAuthToken,
} from '../lib/deploy/registry'
import type {DeployContext, DeploymentProvider} from '../lib/deploy/types'
import {createAgentGit} from '../lib/git-identity'
import {missingAgentError} from '../lib/missing-agent'
import {db} from '../lib/sqlite'

const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-docker/'

function flagDescription(flag: {description?: unknown}): string {
  return typeof flag?.description === 'string' ? flag.description : ''
}

// Two providers can declare the same flag with different defaults. `--size`
// is a droplet slug for DigitalOcean and `cpu:memory` for MicroVMs. The
// shared command flag keeps both descriptions and no default. Each provider
// applies its own default when the user did not pass the flag.
function mergeProviderFlag(current: any, incoming: any): any {
  if (current?.type !== 'option' || incoming?.type !== 'option') return current
  if (current.default === incoming.default) return current
  const description = [flagDescription(current), flagDescription(incoming)].filter(part => part.length > 0).join(' ')
  return Flags.string({description})
}

function buildDeployFlags(): Record<string, any> {
  const flags: Record<string, any> = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip all interactive prompts (auto-commit uncommitted changes before deploying)',
      default: false,
    }),
    provider: Flags.string({
      description: 'Deployment provider',
      options: deploymentProviderKeys(),
    }),
    port: Flags.integer({
      description: 'Port for local deployment',
      default: 8080,
    }),
    version: Flags.string({
      description: 'Release version to deploy (defaults to latest/current state)',
      default: 'latest',
    }),
    'with-tui': Flags.boolean({
      description:
        'Bundle the on-host TUI (cast-tui command) into the image. ' +
        'Off by default to keep images small and streaming fast. ' +
        'Only the DigitalOcean Droplet provider currently supports the on-host TUI. MicroVMs reject this flag.',
      default: false,
    }),
  }

  const shared = new Set(Object.keys(flags))
  for (const provider of listDeploymentProviders()) {
    for (const [name, flag] of Object.entries(provider.flags || {})) {
      if (shared.has(name)) continue
      if (name in flags) {
        flags[name] = mergeProviderFlag(flags[name], flag)
        continue
      }
      flags[name] = flag
    }
  }

  return flags
}

/**
 * Top-level `version` in the agent directory's agent.yaml.
 * The runtime reads that field with the same YAML rule. An unreadable
 * file returns null, which deploy treats as no version.
 */
function readAgentDirReleaseVersion(agentPath: string): AgentYamlVersion | null {
  const yamlPath = path.join(agentPath, 'agent.yaml')
  let text: string
  try {
    text = fs.readFileSync(yamlPath, 'utf8')
  } catch {
    return null
  }
  return readAgentYamlVersion(text)
}

export default class Deploy extends Command {
  static description = 'Deploy agent to hosting provider'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> email-agent --provider railway',
    '<%= config.bin %> <%= command.id %> email-agent --provider fly',
    '<%= config.bin %> <%= command.id %> email-agent --provider digitalocean',
    '<%= config.bin %> <%= command.id %> email-agent --provider microvm',
    '<%= config.bin %> <%= command.id %> email-agent --provider docker',
    '<%= config.bin %> <%= command.id %> email-agent --provider local',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  // Typed here so callers see the merged flag map. The runtime property is
  // the enumerable getter below. oclif help copies enumerable statics with
  // object spread. A class getter is not enumerable, so `cast deploy --help`
  // would list no flags. The getter still runs on each read so external
  // providers stay in --provider.
  declare static flags: Record<string, any>

  static {
    Object.defineProperty(this, 'flags', {
      enumerable: true,
      configurable: true,
      get() {
        return buildDeployFlags()
      },
    })
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

    const providers = listDeploymentProviders()
    for (let i = 0; i < providers.length; i++) {
      const info = providers[i]
      this.log(`  ${i + 1}. ${info.name}`)
      this.log(`     ${info.description}`)
      this.log('')
    }

    const answer = await this.prompt('Enter number (1-' + providers.length + '): ')
    const index = parseInt(answer, 10) - 1

    if (isNaN(index) || index < 0 || index >= providers.length) {
      this.error('Invalid selection. Please run the command again and enter a valid number.')
    }

    return providers[index].key
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

  private async walkthroughProviderSetup(providerKey: string, force = false): Promise<void> {
    const provider = getDeploymentProvider(providerKey)
    if (!provider) return

    const cli = provider.cli
    if (cli?.command && cli.walkthrough !== 'skip') {
      let cliInstalled = false
      try {
        await checkCli(cli.command, cli.installUrl)
        cliInstalled = true
      } catch {
        cliInstalled = false
      }

      if (!cliInstalled) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log(`  ${provider.name} CLI is not installed`)
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log('To deploy to ' + provider.name + ', you need the ' + cli.command + ' CLI.')
        this.log('')
        this.log('Install it:')
        this.log('  ' + cli.installUrl)
        this.log('')
        this.log('Quick install commands:')
        for (const hint of cli.installHints || []) {
          this.log('  ' + hint)
        }
        this.log('')
        const ready = await this.confirm('Have you installed the CLI and are ready to continue?', force)
        if (!ready) {
          this.log('')
          this.log('Deployment cancelled. Run again when you are ready.')
          this.exit(0)
        }
      }

      if (provider.auth?.command) {
        this.log('')
        this.log('─────────────────────────────────────────────────────────────')
        this.log(`  Authenticate with ${provider.name}`)
        this.log('─────────────────────────────────────────────────────────────')
        this.log('')
        this.log('You need to be logged in to ' + provider.name + '.')
        this.log('')
        this.log('Run this command in another terminal:')
        this.log('  ' + provider.auth.command)
        this.log('')
        const ready = await this.confirm('Have you logged in and are ready to continue?', force)
        if (!ready) {
          this.log('')
          this.log('Deployment cancelled. Run again when you are authenticated.')
          this.exit(0)
        }
      }

      if (provider.auth?.tokenHelp) {
        const token = resolveProviderAuthToken(provider)
        if (!token) {
          for (const line of provider.auth.tokenHelp) {
            this.log(line)
          }
          const ready = await this.confirm(
            provider.auth.tokenConfirm || 'Have you configured the token and are ready to continue?',
            force,
          )
          if (!ready) {
            this.log('')
            this.log('Deployment cancelled. Run again when your token is configured.')
            this.exit(0)
          }
        }
      }

      if (cli.interactiveRecheckError) {
        try {
          await checkCli(cli.command, cli.installUrl)
        } catch {
          for (const line of cli.interactiveRecheckHelp || []) {
            this.log(line)
          }
          this.error(cli.interactiveRecheckError)
        }
      }
    }

    if (provider.requiresDocker) {
      await this.walkthroughDocker(provider, force)
    }
  }

  private async walkthroughDocker(provider: DeploymentProvider, force: boolean): Promise<void> {
    let dockerInstalled = false
    try {
      await checkCli('docker', DOCKER_INSTALL_URL)
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
      this.log('  ' + DOCKER_INSTALL_URL)
      this.log('')
      this.log('Quick install commands:')
      this.log('  # macOS:')
      this.log('  brew install --cask docker')
      this.log('  # Linux: install docker-ce from the apt repository in the docs above.')
      this.log('')
      const ready = await this.confirm('Have you installed Docker and are ready to continue?', force)
      if (!ready) {
        this.log('')
        this.log('Deployment cancelled. Run again when Docker is installed.')
        this.exit(0)
      }
    }

    if (provider.requiresDockerDaemon) {
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

  private async checkDockerRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('docker', ['info'], {stdio: 'ignore'})
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })
  }

  private async checkProviderTools(providerKey: string): Promise<void> {
    const provider = getDeploymentProvider(providerKey)
    if (!provider) return

    if (provider.toolChecks) {
      for (const check of provider.toolChecks) {
        try {
          await checkCli(check.command, check.installUrl)
        } catch {
          this.error(check.error)
        }
        if (check.requireDaemon) {
          const isRunning = await this.checkDockerRunning()
          if (!isRunning) {
            this.error('Docker daemon is not running. Start Docker Desktop or the Docker service.')
          }
        }
      }
      return
    }

    if (provider.cli?.command) {
      try {
        await checkCli(provider.cli.command, provider.cli.installUrl)
      } catch {
        this.error(`${provider.name} CLI is not installed.\nInstall it from: ${provider.cli.installUrl}`)
      }
    }

    if (provider.requiresDocker) {
      try {
        await checkCli('docker', DOCKER_INSTALL_URL)
      } catch {
        this.error(`Docker is required for ${provider.name} deployment.\nInstall it from: ${DOCKER_INSTALL_URL}`)
      }
      if (provider.requiresDockerDaemon) {
        const isRunning = await this.checkDockerRunning()
        if (!isRunning) {
          this.error('Docker daemon is not running. Start Docker Desktop or the Docker service.')
        }
      }
    }
  }

  private failProviderLoad(): void {
    const loadErrors = deploymentProviderLoadErrors()
    if (loadErrors.length > 0) {
      this.error(loadErrors.map(error => error.message).join('\n'))
    }
  }

  async run(): Promise<void> {
    this.failProviderLoad()
    const {args, flags} = await this.parse(Deploy)
    const agentName = args.agent
    let provider = flags.provider
    const version = flags.version ?? 'latest'
    const withTui = Boolean(flags['with-tui'])

    // Validate agent exists before reading provider-specific flags.
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(missingAgentError(agentName, agentPath))
    }

    // Prepare version for deploy (extract specific release tarball if needed)
    await this.prepareVersionForDeploy(agentName, agentPath, version)

    // Reject a broken agent.yaml before git, provider CLIs, or uploads.
    try {
      loadAgentYaml(agentPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(message)
    }

    // Check if agent is a git repo and prompt for commit
    const gitDir = path.join(agentPath, '.git')
    if (fs.existsSync(gitDir)) {
      const git = createAgentGit(agentPath)
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

    const registered = getDeploymentProvider(provider)
    if (!registered) {
      this.error(
        `Invalid provider '${provider}'.\n` +
        `Valid providers: ${deploymentProviderKeys().join(', ')}`
      )
    }

    this.log(`Deploying ${agentName} to ${provider}...`)

    // Generate deployment SHA upfront
    const deploymentSha = generateDeploymentSha(agentName)
    process.env.CAST_DEPLOYMENT_SHA = deploymentSha

    // Check provider CLI tools before attempting deployment
    await this.checkProviderTools(provider)

    if (withTui && registered.withTui === 'rejected') {
      this.error(registered.withTuiRejectMessage || 'On-host TUI is not available for this provider.')
    }

    try {
      let authToken = ''
      let tokenHash = ''
      if (!isBuiltinDeploymentProvider(provider)) {
        const generated = await generateAuthToken(agentName)
        authToken = generated.authToken
        tokenHash = generated.tokenHash
      }

      const ctx: DeployContext = {
        agentName,
        agentPath,
        force: Boolean(flags.force),
        token: resolveProviderAuthToken(registered),
        authToken,
        tokenHash,
        flags: flags as Record<string, unknown>,
        version,
        deploymentSha,
        port: flags.port ?? 8080,
        withTui,
        log: message => this.log(message),
        warn: message => this.warn(message),
        error: (message: string): never => this.error(message),
        confirm: message => this.confirm(message, flags.force),
      }

      // Every provider installs this file. Declared minimums come from pyproject.toml.
      stagePythonRequirements(agentPath)

      if (registered.prepare) {
        await registered.prepare(ctx)
      }
      await registered.deploy(ctx)

      // Store deployed version after successful deployment.
      // An explicit --version is that release. Otherwise record the
      // version in the agent directory. releases.json `current` can be
      // newer than the files left after a failed upgrade, so it is not
      // used here. With no version in the file, record the same `1.0`
      // the runtime reports.
      let versionToStore = version
      let missingYamlVersion = false
      if (version === 'latest') {
        const present = readAgentDirReleaseVersion(agentPath)
        if (present?.explicit) {
          versionToStore = present.version
        } else {
          missingYamlVersion = true
          versionToStore = MISSING_AGENT_VERSION
        }
      }
      db.updateDeployedVersion(agentName, versionToStore)
      // The warning names the value that was written, and it comes out
      // before the deploy result lines below.
      if (missingYamlVersion) {
        const recordedVersion = db.getDeployedVersion(agentName) ?? versionToStore
        this.log(`Warning: agent.yaml has no version. Recorded ${recordedVersion}. Add a version to agent.yaml or pass --version to choose.`)
      }

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
