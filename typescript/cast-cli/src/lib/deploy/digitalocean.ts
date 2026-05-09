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

// Helper to get SSH base options that prevent interactive prompts
function getSshBaseOptions(): string[] {
  return [
    '-i', SSH_KEY_PATH,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'LogLevel=ERROR',
  ]
}

// Helper to build full SSH command args for a given IP and remote command
function buildSshArgs(ip: string, remoteCmd: string): string[] {
  return [...getSshBaseOptions(), `root@${ip}`, remoteCmd]
}

// Execute SSH command with shell: false to prevent shell from interfering with options
async function execSsh(ip: string, remoteCmd: string, silent = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execCommand } = await import('./deploy-utils')
  return execCommand('ssh', buildSshArgs(ip, remoteCmd), { silent, shell: false })
}

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
        await execSsh(dropletIp, 'docker stop cast-agent && docker rm cast-agent', true)
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
    const droplet = await this.getOrCreateDroplet(agentName, agentPath, apiToken)

    this.log(`Droplet IP: ${droplet.ip}`)
    this.log('Waiting for SSH to be available...')
    await this.waitForSsh(droplet.ip)

    // Build Docker image locally for AMD64 target (DO droplets are x86_64)
    const imageTag = `cast-${agentName}:latest`
    this.log('Building Docker image for linux/amd64...')
    const buildResult = await execCommand('docker', [
      'buildx', 'build',
      '--platform', 'linux/amd64',
      '--load',
      '-t', imageTag,
      '-f', path.join(agentPath, 'Dockerfile'),
      agentPath,
    ])
    if (buildResult.exitCode !== 0) {
      this.error(`Docker build failed: ${buildResult.stderr}`)
    }

    // Save image to tar
    const tarPath = path.join(agentPath, `${agentName}.tar`)
    this.log('Saving Docker image...')
    const saveResult = await execCommand('docker', ['save', '-o', tarPath, imageTag])
    if (saveResult.exitCode !== 0) {
      this.error(`Failed to save Docker image: ${saveResult.stderr}`)
    }

    // Copy image to droplet
    this.log('Copying image to droplet...')
    const scpResult = await execCommand('scp', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      tarPath,
      `root@${droplet.ip}:/tmp/${agentName}.tar`,
    ], {silent: true, shell: false})
    if (scpResult.exitCode !== 0) {
      this.error(`Failed to copy image to droplet: ${scpResult.stderr}`)
    }

    // Deploy on droplet
    this.log('Deploying on droplet...')
    await this.deployOnDroplet(droplet.ip, agentName, authToken, imageTag, tarPath)

    // Clean up local tar file after transfer
    this.log('Cleaning up local artifacts...')
    if (fs.existsSync(tarPath)) {
      fs.unlinkSync(tarPath)
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

  private async getOrCreateDroplet(agentName: string, agentPath: string, apiToken?: string): Promise<{id: string; name: string; ip: string}> {
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

    // Create droplet with cloud-init
    this.log(`Creating droplet '${dropletName}'...`)

    // Get SSH key fingerprint (MD5 format required by DO API)
    const keyResult = await execCommand('ssh-keygen', ['-l', '-E', 'md5', '-f', `${SSH_KEY_PATH}.pub`], {silent: true})
    const fingerprint = keyResult.stdout.trim().split(/\s+/)[1].replace(/^MD5:/, '')

    // Write cloud-init to install Docker
    const cloudInitPath = path.join(agentPath, '.cloud-init.yml')
    const cloudInit = `#cloud-config
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable docker
  - systemctl start docker
`
    fs.writeFileSync(cloudInitPath, cloudInit)

    const createResult = await execCommand('doctl', [
      'compute', 'droplet', 'create',
      dropletName,
      '--region', 'nyc3',
      '--size', 's-1vcpu-1gb',
      '--image', 'ubuntu-24-04-x64',
      '--ssh-keys', fingerprint,
      '--user-data-file', cloudInitPath,
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
        const result = await execSsh(ip, 'echo ok', true)
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

  private async deployOnDroplet(
    ip: string,
    agentName: string,
    authToken: string,
    imageTag: string,
    tarPath: string,
  ): Promise<void> {
    // Load image on droplet
    const loadResult = await execSsh(ip, `docker load -i /tmp/${path.basename(tarPath)}`, true)

    if (loadResult.exitCode !== 0) {
      throw new Error(`Failed to load image on droplet: ${loadResult.stderr}`)
    }

    // Stop old container
    await execSsh(ip, 'docker stop cast-agent && docker rm cast-agent', true)

    // Open UFW port
    await execSsh(ip, 'ufw allow 8080/tcp || true', true)

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
    const runResult = await execSsh(ip, `docker run -d --name cast-agent --restart unless-stopped -p 8080:8080 ${envArgs.join(' ')} ${imageTag}`, true)

    if (runResult.exitCode !== 0) {
      throw new Error(`Failed to start container on droplet: ${runResult.stderr}`)
    }

    // Clean up remote tar file after loading
    await execSsh(ip, `rm -f /tmp/${path.basename(tarPath)}`, true)
  }

}
