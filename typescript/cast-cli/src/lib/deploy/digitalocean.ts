import {Args, Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import axios from 'axios'
import YAML from 'yaml'
import {
  generateAuthToken,
  ensureDockerfile,
  getAgentPath,
  saveDeployment,
  getOpenRouterApiKey,
  getProviderToken,
  execCommand,
} from './deploy-utils'

export default class DigitalOceanDeploy extends Command {
  static description = 'Deploy agent to DigitalOcean App Platform'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(DigitalOceanDeploy)
    const agentName = args.agent as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to DigitalOcean App Platform...`)

    // Check API token
    const apiToken = getProviderToken('digitalocean')
    if (!apiToken) {
      this.error(
        'DigitalOcean API token not found. Set DIGITALOCEAN_TOKEN environment variable or add providers.digitalocean.token to ~/.cast/config.yaml',
      )
    }

    // Check Docker
    try {
      await execCommand('docker', ['--version'], {silent: true})
    } catch {
      this.error('Docker is required for DigitalOcean deployment. Install from https://docs.docker.com/get-docker/')
    }

    // Ensure Docker packaging
    ensureDockerfile(agentPath)

    // Generate auth token
    const { authToken, tokenHash } = await generateAuthToken(agentName)

    // Get registry info
    const registry = await this.getRegistry(apiToken)
    if (!registry) {
      this.error('No DigitalOcean Container Registry found. Create one at https://cloud.digitalocean.com/registry')
    }

    const registryEndpoint = `registry.digitalocean.com/${registry.name}`
    const imageTag = `${registryEndpoint}/cast-${agentName}:latest`

    // Build Docker image
    this.log('Building Docker image...')
    const buildResult = await execCommand('docker', [
      'build',
      '-t', imageTag,
      '-f', path.join(agentPath, 'Dockerfile'),
      agentPath,
    ])
    if (buildResult.exitCode !== 0) {
      this.error(`Docker build failed: ${buildResult.stderr}`)
    }

    // Get DOCR credentials and login
    this.log('Authenticating with DigitalOcean Container Registry...')
    const credsResult = await axios.get('https://api.digitalocean.com/v2/registry/docker-credentials', {
      headers: {Authorization: `Bearer ${apiToken}`},
      params: {read_write: true, expiry_seconds: 3600},
    })

    const dockerConfig = credsResult.data
    const dockerConfigPath = path.join(agentPath, '.docker-config.json')
    fs.writeFileSync(dockerConfigPath, JSON.stringify(dockerConfig))

    const loginResult = await execCommand('docker', [
      'login', registryEndpoint,
      '--username', '_',
      '--password-stdin',
    ], {
      input: dockerConfig.auths?.[registryEndpoint]?.password || '',
      silent: true,
    })
    if (loginResult.exitCode !== 0) {
      this.warn(`Docker login warning: ${loginResult.stderr}`)
    }

    // Push image
    this.log('Pushing image to registry...')
    const pushResult = await execCommand('docker', ['push', imageTag])
    if (pushResult.exitCode !== 0) {
      this.error(`Docker push failed: ${pushResult.stderr}`)
    }

    // Generate app spec
    this.generateAppYaml(agentPath, agentName, authToken, imageTag)
    const appSpec = YAML.parse(fs.readFileSync(path.join(agentPath, 'app.yaml'), 'utf-8'))

    // Check if app already exists
    const existingApp = await this.findExistingApp(apiToken, `cast-${agentName}`)

    let deploymentUrl = ''

    if (existingApp) {
      this.log('Updating existing DigitalOcean app...')
      const updateResult = await axios.post(
        `https://api.digitalocean.com/v2/apps/${existingApp.id}/deployments`,
        {spec: appSpec},
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
        },
      )

      if (updateResult.status !== 200 && updateResult.status !== 201) {
        this.error(`Failed to update DigitalOcean app: ${updateResult.statusText}`)
      }

      deploymentUrl = `https://${existingApp.default_ingress}`
      this.log('Update initiated. Polling for deployment status...')
      await this.pollDeployment(apiToken, existingApp.id, updateResult.data.deployment?.id)
    } else {
      this.log('Creating new DigitalOcean app...')
      const createResult = await axios.post(
        'https://api.digitalocean.com/v2/apps',
        {spec: appSpec},
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
        },
      )

      if (createResult.status !== 200 && createResult.status !== 201) {
        this.error(`Failed to create DigitalOcean app: ${createResult.statusText}`)
      }

      const app = createResult.data.app
      deploymentUrl = `https://${app.default_ingress}`
      this.log('Create initiated. Polling for deployment status...')
      await this.pollDeployment(apiToken, app.id, createResult.data.deployment?.id)
    }

    // Cleanup temp docker config
    if (fs.existsSync(dockerConfigPath)) {
      fs.unlinkSync(dockerConfigPath)
    }

    // Save deployment
    saveDeployment(agentName, 'digitalocean', deploymentUrl, tokenHash)

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║         DigitalOcean Deployment Successful!                  ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Provider: digitalocean`)
    this.log('')
    this.log('To view logs:')
    this.log(`  Visit https://cloud.digitalocean.com/apps`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
  }

  private generateAppYaml(agentPath: string, agentName: string, authToken: string, imageTag: string): void {
    const openrouterKey = getOpenRouterApiKey()
    const envVars: any[] = [
      {key: 'CAST_AGENT_NAME', value: agentName, scope: 'RUN_AND_BUILD_TIME'},
      {key: 'AUTH_TOKEN', value: authToken, scope: 'RUN_TIME', type: 'SECRET'},
    ]
    if (openrouterKey) {
      envVars.push({key: 'OPENROUTER_API_KEY', value: openrouterKey, scope: 'RUN_TIME', type: 'SECRET'})
    }

    const appSpec = {
      name: `cast-${agentName}`,
      region: 'nyc',
      services: [
        {
          name: 'agent',
          image: {
            registry_type: 'DOCR',
            repository: imageTag.split('/').slice(1).join('/').replace(':latest', ''),
            tag: 'latest',
          },
          envs: envVars,
          instance_count: 1,
          instance_size_slug: 'basic-xxs',
          http_port: 8080,
          routes: [
            {
              path: '/',
            },
          ],
          health_check: {
            http_path: '/health',
          },
        },
      ],
    }

    fs.writeFileSync(path.join(agentPath, 'app.yaml'), YAML.stringify(appSpec))
  }

  private async getRegistry(apiToken: string): Promise<any | null> {
    try {
      const response = await axios.get('https://api.digitalocean.com/v2/registry', {
        headers: {Authorization: `Bearer ${apiToken}`},
      })
      return response.data.registry || null
    } catch (error: any) {
      this.warn(`Failed to get registry: ${error.message}`)
      return null
    }
  }

  private async findExistingApp(apiToken: string, appName: string): Promise<any | null> {
    try {
      const response = await axios.get('https://api.digitalocean.com/v2/apps', {
        headers: {Authorization: `Bearer ${apiToken}`},
      })

      const apps = response.data.apps || []
      return apps.find((app: any) => app.spec?.name === appName) || null
    } catch (error: any) {
      this.warn(`Failed to list apps: ${error.message}`)
      return null
    }
  }

  private async pollDeployment(
    apiToken: string,
    appId: string,
    deploymentId?: string,
  ): Promise<void> {
    if (!deploymentId) {
      this.warn('No deployment ID returned. Skipping status polling.')
      return
    }

    const maxAttempts = 30
    const delayMs = 10000

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response: any = await axios.get(
          `https://api.digitalocean.com/v2/apps/${appId}/deployments/${deploymentId}`,
          {
            headers: {Authorization: `Bearer ${apiToken}`},
          },
        )

        const deployment: any = response.data.deployment
        const phase = deployment?.phase
        this.log(`  Deployment status: ${phase || 'unknown'}`)

        if (phase === 'ACTIVE') {
          this.log('Deployment is live!')
          return
        }

        if (phase === 'ERROR' || phase === 'FAILED') {
          this.error(`Deployment failed: ${deployment?.progress?.error_steps?.join(', ') || 'Unknown error'}`)
        }
      } catch (error: any) {
        this.warn(`Failed to check deployment status: ${error.message}`)
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    this.warn('Deployment polling timed out. The app may still be deploying.')
  }
}
