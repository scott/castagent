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
  getOpenRouterApiKey,
  getProviderToken,
} from './deploy-utils'

export default class RailwayDeploy extends Command {
  static description = 'Deploy agent to Railway'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(RailwayDeploy)
    const agentName = args.agent as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to Railway...`)

    // Check CLI
    try {
      await checkCli('railway', 'https://docs.railway.app/getting-started/installation')
    } catch (error: any) {
      this.error(error.message)
    }

    // Ensure Docker packaging
    ensureDockerfile(agentPath)

    // Generate auth token
    const { authToken, tokenHash } = await generateAuthToken(agentName)

    // Initialize Railway project if needed
    const railwayDir = path.join(agentPath, '.railway')
    if (!fs.existsSync(railwayDir)) {
      fs.mkdirSync(railwayDir, { recursive: true })
    }

    this.log('Initializing Railway project...')
    const initResult = await execCommand('railway', ['init', '--name', `cast-${agentName}`, '--environment', 'production'], {
      cwd: agentPath,
      silent: true,
    })

    if (initResult.exitCode !== 0 && !initResult.stderr.includes('already exists')) {
      // Try linking instead
      this.log('Project may already exist, attempting to link...')
      const linkResult = await execCommand('railway', ['link', '--name', `cast-${agentName}`], {
        cwd: agentPath,
        silent: true,
      })
      if (linkResult.exitCode !== 0) {
        this.error(`Failed to initialize Railway project: ${initResult.stderr || initResult.stdout}`)
      }
    }

    // Set environment variables
    this.log('Setting environment variables...')
    const openrouterKey = getOpenRouterApiKey()
    const envVars: Record<string, string> = {
      CAST_AGENT_NAME: agentName,
      AUTH_TOKEN: authToken,
    }
    if (openrouterKey) {
      envVars.OPENROUTER_API_KEY = openrouterKey
    }

    for (const [key, value] of Object.entries(envVars)) {
      const setResult = await execCommand('railway', ['variables', 'set', `${key}=${value}`], {
        cwd: agentPath,
        silent: true,
      })
      if (setResult.exitCode !== 0) {
        this.warn(`Failed to set variable ${key}: ${setResult.stderr}`)
      }
    }

    // Deploy
    this.log('Deploying to Railway...')
    const deployResult = await execCommand('railway', ['up', '--detach'], {
      cwd: agentPath,
    })

    if (deployResult.exitCode !== 0) {
      this.error(`Railway deployment failed: ${deployResult.stderr || deployResult.stdout}`)
    }

    // Get deployment URL
    this.log('Fetching deployment URL...')
    const domainResult = await execCommand('railway', ['domain'], {
      cwd: agentPath,
      silent: true,
    })

    let deploymentUrl = ''
    const domainMatch = domainResult.stdout.match(/(https?:\/\/[^\s]+)/)
    if (domainMatch) {
      deploymentUrl = domainMatch[1]
    } else {
      // Fallback: construct from project name
      deploymentUrl = `https://cast-${agentName}.up.railway.app`
      this.warn(`Could not retrieve exact domain. App may be available at ${deploymentUrl}`)
    }

    // Save deployment
    saveDeployment(agentName, 'railway', deploymentUrl, tokenHash)

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║              Railway Deployment Successful!                  ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Provider: railway`)
    this.log('')
    this.log('To view logs:')
    this.log(`  railway logs`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
  }
}
