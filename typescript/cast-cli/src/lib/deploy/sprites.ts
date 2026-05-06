import {Args, Command} from '@oclif/core'
import {execSync} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {
  checkCli,
  generateAuthToken,
  getAgentPath,
  execCommand,
  execCommandIgnoreError,
  saveDeployment,
  getOpenRouterApiKey,
} from './deploy-utils'

const AGENT_DIR = '/opt/cast-agent'

export default class SpritesDeploy extends Command {
  static description = 'Deploy agent to Sprites (Fly.io Firecracker VM)'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static async destroy(agentName: string): Promise<void> {
    await execCommandIgnoreError('sprite', ['delete', `cast-${agentName}`])
  }

  async run(): Promise<void> {
    const { args } = await this.parse(SpritesDeploy)
    const agentName = args.agent as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to Sprites...`)

    // Check CLI
    try {
      await checkCli('sprite', 'https://sprites.dev/install.sh')
    } catch (error: any) {
      this.error(error.message)
    }

    // Check auth
    const authCheck = await execCommand('sprite', ['list'], {silent: true})
    if (authCheck.exitCode !== 0 && !process.env.SPRITES_TOKEN) {
      this.error('Not authenticated with Sprites. Run "sprite login" or set SPRITES_TOKEN environment variable.')
    }

    // Generate auth token
    const { authToken, tokenHash } = await generateAuthToken(agentName)

    const spriteName = `cast-${agentName}`

    // Ensure sprite exists
    this.log(`Ensuring sprite '${spriteName}' exists...`)
    const createResult = await execCommand('sprite', ['create', spriteName], {silent: true})
    if (createResult.exitCode !== 0 && !createResult.stderr.includes('already exists')) {
      this.error(`Failed to create sprite: ${createResult.stderr}`)
    }

    // Ensure Python is installed
    this.log('Ensuring Python is installed...')
    await this.execOnSprite(spriteName, 'apt-get update && apt-get install -y python3 python3-pip')

    // Package and transfer agent files
    this.log('Transferring agent files...')
    await this.transferAgentFiles(agentPath, spriteName)

    // Install dependencies
    this.log('Installing dependencies...')
    await this.execOnSprite(spriteName, `pip3 install -r ${AGENT_DIR}/requirements.txt`)

    // Setup and start systemd service
    this.log('Starting agent service...')
    await this.setupSystemdService(spriteName, agentName, authToken)

    // Wait a moment for service to start
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Verify service is running
    const statusResult = await this.execOnSprite(spriteName, 'systemctl is-active cast-agent')
    if (statusResult.trim() !== 'active') {
      this.warn('Agent service may not be running. Check logs with: sprite exec -s ' + spriteName + ' -- journalctl -u cast-agent -n 50')
    }

    // Get URL
    const urlResult = await execCommand('sprite', ['url', '-s', spriteName], {silent: true})
    const deploymentUrl = urlResult.stdout.trim() || `https://${spriteName}.sprites.dev`

    // Save deployment
    saveDeployment(agentName, 'sprites', deploymentUrl, tokenHash)

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║              Sprites Deployment Successful!                  ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${deploymentUrl}`)
    this.log(`Sprite: ${spriteName}`)
    this.log(`Provider: sprites`)
    this.log('')
    this.log('To view logs:')
    this.log(`  sprite exec -s ${spriteName} -- journalctl -u cast-agent -f`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    this.log('To destroy:')
    this.log(`  cast shutdown ${agentName}`)
  }

  private async execOnSprite(spriteName: string, command: string): Promise<string> {
    const result = await execCommand('sprite', ['exec', '-s', spriteName, '--', 'bash', '-c', command], {
      silent: true,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Sprite command failed: ${result.stderr || result.stdout}`)
    }
    return result.stdout
  }

  private async transferAgentFiles(agentPath: string, spriteName: string): Promise<void> {
    // Create local tar
    const tarPath = path.join(os.tmpdir(), `cast-${path.basename(agentPath)}.tar.gz`)

    try {
      // Clean up old tar if exists
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath)
      }

      // Create tar of agent directory
      execSync(`tar czf "${tarPath}" -C "${agentPath}" .`, {
        encoding: 'utf8',
        stdio: 'pipe',
      })

      // Read and base64 encode
      const tarData = fs.readFileSync(tarPath)
      const base64Data = tarData.toString('base64')

      // Transfer to sprite via base64 decode pipe
      this.log('  Uploading tar to sprite...')
      execSync(`sprite exec -s ${spriteName} -- bash -c 'mkdir -p ${AGENT_DIR} && base64 -d > /tmp/agent.tar.gz'`, {
        input: base64Data,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Extract on sprite
      this.log('  Extracting files...')
      await this.execOnSprite(spriteName, `tar xzf /tmp/agent.tar.gz -C ${AGENT_DIR} && rm /tmp/agent.tar.gz`)
    } finally {
      // Clean up local tar
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath)
      }
    }
  }

  private async setupSystemdService(spriteName: string, agentName: string, authToken: string): Promise<void> {
    const openrouterKey = getOpenRouterApiKey()

    const serviceContent = `[Unit]
Description=Cast Agent ${agentName}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${AGENT_DIR}
Environment=PYTHONPATH=${AGENT_DIR}/.cast-runtime
Environment=CAST_AGENT_NAME=${agentName}
Environment=CAST_AGENT_PATH=${AGENT_DIR}
Environment=AUTH_TOKEN=${authToken}
${openrouterKey ? `Environment=OPENROUTER_API_KEY=${openrouterKey}` : ''}
ExecStart=/usr/bin/python3 -m cast.runtime --agent-path ${AGENT_DIR} --port 8080 --host 0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`

    // Write service file
    const writeResult = await execCommand('sprite', [
      'exec', '-s', spriteName, '--', 'bash', '-c',
      `cat > /etc/systemd/system/cast-agent.service << 'EOF'\n${serviceContent}EOF`,
    ], {silent: true})

    if (writeResult.exitCode !== 0) {
      throw new Error(`Failed to write systemd service: ${writeResult.stderr}`)
    }

    // Enable and start service
    await this.execOnSprite(spriteName, 'systemctl daemon-reload')
    await this.execOnSprite(spriteName, 'systemctl enable cast-agent')
    await this.execOnSprite(spriteName, 'systemctl restart cast-agent')
  }
}
