import {Args, Command} from '@oclif/core'
import {execSync} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import axios from 'axios'
import {
  generateAuthToken,
  ensureDockerfile,
  getAgentPath,
  saveDeployment,
  getOpenRouterApiKey,
  getProviderToken,
  execCommand,
  execCommandIgnoreError,
} from './deploy-utils'

const SSH_KEY_NAME = 'cast-do-key'
const SSH_KEY_PATH = path.join(os.homedir(), '.ssh', 'cast_do_key')

export default class DigitalOceanDeploy extends Command {
  static description = 'Deploy agent to DigitalOcean Droplet with Docker'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static async destroy(agentName: string): Promise<void> {
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      throw new Error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Check doctl
    try {
      await execCommand('doctl', ['account', 'get'], {silent: true})
    } catch {
      throw new Error('doctl is not installed or not authenticated. Install from https://docs.digitalocean.com/reference/doctl/how-to/install/')
    }

    const dropletName = `cast-${agentName}`

    // Find droplet by name
    const dropletsResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = dropletsResult.stdout.trim().split('\n')
    let dropletId = ''
    let dropletIp = ''

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2 && parts[1] === dropletName) {
        dropletId = parts[0]
        dropletIp = parts[2] || ''
        break
      }
    }

    if (!dropletId) {
      console.log(`Droplet '${dropletName}' not found.`)
      return
    }

    // Stop container first
    if (dropletIp) {
      try {
        await execCommand('ssh', [
          '-i', SSH_KEY_PATH,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          `root@${dropletIp}`,
          'docker stop cast-agent && docker rm cast-agent',
        ], {silent: true})
      } catch {
        // ignore
      }
    }

    // Delete droplet
    const deleteResult = await execCommand('doctl', ['compute', 'droplet', 'delete', dropletId, '--force'], {silent: true})
    if (deleteResult.exitCode !== 0) {
      throw new Error(`Failed to delete droplet: ${deleteResult.stderr}`)
    }
    console.log(`Droplet '${dropletName}' deleted.`)
  }

  async run(): Promise<void> {
    const { args } = await this.parse(DigitalOceanDeploy)
    const agentName = args.agent as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to DigitalOcean Droplet...`)

    // Check doctl
    try {
      await execCommand('doctl', ['account', 'get'], {silent: true})
    } catch {
      this.error('doctl is not installed or not authenticated. Install from https://docs.digitalocean.com/reference/doctl/how-to/install/')
    }

    // Check Docker locally
    try {
      await execCommand('docker', ['--version'], {silent: true})
    } catch {
      this.error('Docker is required for DigitalOcean deployment. Install from https://docs.docker.com/get-docker/')
    }

    // Ensure Docker packaging
    ensureDockerfile(agentPath)

    // Generate auth token
    const { authToken, tokenHash } = await generateAuthToken(agentName)

    // Get DO token
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      this.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Setup SSH key
    await this.ensureSshKey()

    // Get or create droplet
    const droplet = await this.getOrCreateDroplet(agentName, apiToken)

    this.log(`Droplet IP: ${droplet.ip}`)
    this.log('Waiting for SSH to be available...')
    await this.waitForSsh(droplet.ip)

    // Setup Docker on droplet
    this.log('Setting up Docker on droplet...')
    await this.setupDockerOnDroplet(droplet.ip)

    // Get registry info and push image
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

    // Get DOCR credentials and login locally
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

    // Deploy on droplet
    this.log('Deploying on droplet...')
    await this.deployOnDroplet(droplet.ip, agentName, authToken, imageTag, registryEndpoint, dockerConfig)

    // Cleanup
    if (fs.existsSync(dockerConfigPath)) {
      fs.unlinkSync(dockerConfigPath)
    }

    const deploymentUrl = `http://${droplet.ip}:8080`

    // Save deployment
    saveDeployment(agentName, 'digitalocean', deploymentUrl, tokenHash)

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║         DigitalOcean Droplet Deployment Successful!          ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Droplet: ${droplet.name}`)
    this.log(`Provider: digitalocean`)
    this.log('')
    this.log('To view logs:')
    this.log(`  ssh -i ~/.ssh/cast_do_key root@${droplet.ip} "docker logs -f cast-agent"`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    this.log('To destroy:')
    this.log(`  cast shutdown ${agentName}`)
  }

  private async ensureSshKey(): Promise<void> {
    if (fs.existsSync(SSH_KEY_PATH)) {
      return
    }

    fs.mkdirSync(path.dirname(SSH_KEY_PATH), {recursive: true, mode: 0o700})

    // Generate SSH key (use execSync directly to handle empty passphrase properly)
    try {
      execSync(`ssh-keygen -t ed25519 -f "${SSH_KEY_PATH}" -N "" -C "cast@digitalocean"`, {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e: any) {
      throw new Error(`Failed to generate SSH key: ${e.stderr || e.message}`)
    }

    // Upload to DigitalOcean
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      throw new Error('DigitalOcean API token not found')
    }

    const pubKeyPath = `${SSH_KEY_PATH}.pub`
    const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim()

    // Check if key already exists
    try {
      const keysResult = await axios.get('https://api.digitalocean.com/v2/account/keys', {
        headers: {Authorization: `Bearer ${apiToken}`},
      })
      const existingKey = keysResult.data.ssh_keys?.find((k: any) => k.name === SSH_KEY_NAME)
      if (existingKey) {
        return
      }
    } catch {
      // ignore, will try to create
    }

    await axios.post('https://api.digitalocean.com/v2/account/keys', {
      name: SSH_KEY_NAME,
      public_key: pubKey,
    }, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    })
  }

  private async getOrCreateDroplet(agentName: string, apiToken?: string): Promise<{id: string; name: string; ip: string}> {
    const dropletName = `cast-${agentName}`

    // Check if droplet exists
    const listResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = listResult.stdout.trim().split('\n')

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3 && parts[1] === dropletName) {
        return {id: parts[0], name: dropletName, ip: parts[2]}
      }
    }

    // Create droplet
    this.log(`Creating droplet '${dropletName}'...`)

    // Get SSH key fingerprint
    const keyResult = await execCommand('ssh-keygen', ['-lf', `${SSH_KEY_PATH}.pub`], {silent: true})
    const fingerprint = keyResult.stdout.trim().split(/\s+/)[1]

    const createResult = await execCommand('doctl', [
      'compute', 'droplet', 'create',
      dropletName,
      '--region', 'nyc3',
      '--size', 's-1vcpu-1gb',
      '--image', 'docker-20-04',
      '--ssh-keys', fingerprint,
      '--wait',
    ], {silent: true})

    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to create droplet: ${createResult.stderr}`)
    }

    // Get IP
    const infoResult = await execCommand('doctl', ['compute', 'droplet', 'get', dropletName, '--format', 'ID,PublicIPv4', '--no-header'], {silent: true})
    const parts = infoResult.stdout.trim().split(/\s+/)

    return {id: parts[0], name: dropletName, ip: parts[1]}
  }

  private async waitForSsh(ip: string): Promise<void> {
    const maxAttempts = 30
    const delayMs = 5000

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await execCommand('ssh', [
          '-i', SSH_KEY_PATH,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ConnectTimeout=5',
          `root@${ip}`,
          'echo ok',
        ], {silent: true})
        if (result.exitCode === 0) {
          return
        }
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error('Timed out waiting for SSH on droplet')
  }

  private async setupDockerOnDroplet(ip: string): Promise<void> {
    // Check if Docker is installed
    const checkResult = await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      'docker --version',
    ], {silent: true})

    if (checkResult.exitCode === 0) {
      // Docker already installed
      return
    }

    // Install Docker
    const installResult = await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      'curl -fsSL https://get.docker.com | sh',
    ], {silent: true})

    if (installResult.exitCode !== 0) {
      throw new Error(`Failed to install Docker on droplet: ${installResult.stderr}`)
    }
  }

  private async deployOnDroplet(
    ip: string,
    agentName: string,
    authToken: string,
    imageTag: string,
    registryEndpoint: string,
    dockerConfig: any,
  ): Promise<void> {
    const password = dockerConfig.auths?.[registryEndpoint]?.password || ''

    // Login to DOCR on droplet
    const loginResult = await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      `echo '${password}' | docker login ${registryEndpoint} --username '_' --password-stdin`,
    ], {silent: true})

    if (loginResult.exitCode !== 0) {
      this.warn(`Docker login on droplet warning: ${loginResult.stderr}`)
    }

    // Pull image
    const pullResult = await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      `docker pull ${imageTag}`,
    ], {silent: true})

    if (pullResult.exitCode !== 0) {
      throw new Error(`Failed to pull image on droplet: ${pullResult.stderr}`)
    }

    // Stop old container
    await execCommandIgnoreError('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      'docker stop cast-agent && docker rm cast-agent',
    ])

    // Open UFW port
    await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      'ufw allow 8080/tcp || true',
    ], {silent: true})

    // Build env vars
    const envArgs = [
      `-e CAST_AGENT_NAME=${agentName}`,
      `-e CAST_AGENT_PATH=/app/agent`,
      `-e AUTH_TOKEN=${authToken}`,
      `-e PYTHONPATH=/app`,
    ]

    const openrouterKey = getOpenRouterApiKey()
    if (openrouterKey) {
      envArgs.push(`-e OPENROUTER_API_KEY=${openrouterKey}`)
    }

    // Run container
    const runResult = await execCommand('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      `root@${ip}`,
      `docker run -d --name cast-agent --restart unless-stopped -p 8080:8080 ${envArgs.join(' ')} ${imageTag}`,
    ], {silent: true})

    if (runResult.exitCode !== 0) {
      throw new Error(`Failed to start container on droplet: ${runResult.stderr}`)
    }
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
}
