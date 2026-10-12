import {Args, Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import {
  checkCli,
  generateAuthToken,
  ensureDockerfile,
  getAgentPath,
  execCommand,
  saveDeployment,
  inferenceEnv,
  generateDeploymentId,
  getVolumeName,
} from './deploy-utils'

export default class FlyDeploy extends Command {
  static description = 'Deploy agent to Fly.io'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(FlyDeploy)
    const agentName = args.agent as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to Fly.io...`)

    // Check CLI
    try {
      await checkCli('flyctl', 'https://fly.io/docs/hands-on/install-flyctl/')
    } catch (error: any) {
      this.error(error.message)
    }

    // Ensure Docker packaging
    ensureDockerfile(agentPath)

    // Generate auth token and deployment ID
    const { authToken, tokenHash } = await generateAuthToken(agentName)
    const deploymentId = generateDeploymentId()
    const volumeId = getVolumeName(agentName, deploymentId)

    // Generate fly.toml if missing
    const flyTomlPath = path.join(agentPath, 'fly.toml')
    if (!fs.existsSync(flyTomlPath)) {
      this.generateFlyToml(agentPath, agentName, volumeId)
    }

    // Create memory volume
    this.log(`Creating memory volume: ${volumeId}`)
    const volumeResult = await execCommand('flyctl', ['volumes', 'create', volumeId, '--size', '1', '--app', `cast-${agentName}`], {
      cwd: agentPath,
      silent: true,
    })
    if (volumeResult.exitCode !== 0 && !volumeResult.stderr.includes('already exists')) {
      this.warn(`Failed to create volume: ${volumeResult.stderr}`)
    }

    // Launch app if not already launched
    const launchResult = await execCommand('flyctl', ['status', '--app', `cast-${agentName}`], {
      cwd: agentPath,
      silent: true,
    })

    if (launchResult.exitCode !== 0) {
      this.log('Launching new Fly.io app...')
      const createResult = await execCommand(
        'flyctl',
        ['launch', '--name', `cast-${agentName}`, '--region', 'iad', '--dockerfile', 'Dockerfile', '--no-deploy', '--yes'],
        {
          cwd: agentPath,
        },
      )
      if (createResult.exitCode !== 0) {
        this.error(`Failed to launch Fly.io app: ${createResult.stderr || createResult.stdout}`)
      }
    }

    // Set secrets
    this.log('Setting secrets...')
    const secrets: Record<string, string> = {
      CAST_AGENT_NAME: agentName,
      AUTH_TOKEN: authToken,
      ...inferenceEnv(),
    }

    const secretPairs = Object.entries(secrets).map(([k, v]) => `${k}=${v}`)
    const secretResult = await execCommand('flyctl', ['secrets', 'set', '--app', `cast-${agentName}`, ...secretPairs], {
      cwd: agentPath,
      silent: true,
    })
    if (secretResult.exitCode !== 0) {
      this.warn(`Failed to set secrets: ${secretResult.stderr}`)
    }

    // Deploy
    this.log('Deploying to Fly.io...')
    const deployResult = await execCommand('flyctl', ['deploy', '--app', `cast-${agentName}`], {
      cwd: agentPath,
    })

    if (deployResult.exitCode !== 0) {
      this.error(`Fly.io deployment failed: ${deployResult.stderr || deployResult.stdout}`)
    }

    // Get deployment URL
    const deploymentUrl = `https://cast-${agentName}.fly.dev`

    // Save deployment
    const volumeConfig = JSON.stringify({ deploymentId, mountPath: '/app/agent/memory' })
    saveDeployment(agentName, 'fly', deploymentUrl, tokenHash, volumeId, volumeConfig)

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║              Fly.io Deployment Successful!                   ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Provider: fly`)
    this.log('')
    this.log('To view logs:')
    this.log(`  flyctl logs --app cast-${agentName}`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
  }

  static async destroy(agentName: string): Promise<void> {
    const appName = `cast-${agentName}`
    const result = await execCommand('flyctl', ['apps', 'destroy', appName, '--yes'])
    if (result.exitCode !== 0) {
      // Check if it's a "not found" error - that's actually okay, the app is already gone
      if (result.stderr.includes('not found') || result.stderr.includes('does not exist') || result.stderr.toLowerCase().includes('error')) {
        // For fly, the error message might be different - let's check stdout too
        if (result.stdout.includes('not found') || result.stdout.includes('does not exist')) {
          console.log(`App '${appName}' does not exist (already deleted or never created).`)
          return
        }
        throw new Error(`Failed to destroy Fly app '${appName}': ${result.stderr || result.stdout}`)
      }
    }
    console.log(`Fly app '${appName}' has been destroyed.`)

    // Clean up memory volume
    try {
      await execCommand('flyctl', ['volumes', 'delete', `cast-${agentName}-memory`, '--app', appName, '--yes'], {silent: true})
      console.log(`Memory volume for '${appName}' has been removed.`)
    } catch {
      // Volume may have been deleted with the app or not exist
    }
  }

  private generateFlyToml(agentPath: string, agentName: string, volumeId: string): void {
    const flyToml = `app = "cast-${agentName}"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[mounts]
  source = "${volumeId}"
  destination = "/app/agent/memory"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`
    fs.writeFileSync(path.join(agentPath, 'fly.toml'), flyToml)
  }
}
