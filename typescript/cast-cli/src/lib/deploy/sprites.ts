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

    // Ensure Python and venv are installed
    this.log('Ensuring Python is installed...')
    await this.execOnSprite(spriteName, 'apt-get update && apt-get install -y python3 python3-pip python3-venv')

    // Package and transfer agent files
    this.log('Transferring agent files...')
    await this.transferAgentFiles(agentPath, spriteName)

    // Create virtual environment and install dependencies
    this.log('Setting up Python environment...')
    await this.execOnSprite(spriteName, `python3 -m venv ${AGENT_DIR}/venv`)
    this.log('Installing dependencies...')
    await this.execOnSprite(spriteName, `${AGENT_DIR}/venv/bin/pip install -r ${AGENT_DIR}/requirements.txt`)

    // Setup and start background service
    this.log('Starting agent service...')
    await this.setupBackgroundService(spriteName, agentName, authToken)

    // Wait a moment for service to start
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Verify service is running
    const pidResult = await this.execOnSprite(spriteName, `cat ${AGENT_DIR}/agent.pid 2>/dev/null || echo 'no-pid'`)
    const pid = pidResult.trim()
    if (pid === 'no-pid' || !pid) {
      this.warn('Agent service may not be running. Check logs with: sprite exec -s ' + spriteName + ` -- cat ${AGENT_DIR}/agent.log`)
    } else {
      const psResult = await this.execOnSprite(spriteName, `ps -p ${pid} > /dev/null 2>&1 && echo 'running' || echo 'not-running'`)
      if (psResult.trim() !== 'running') {
        this.warn('Agent service is not running. Check logs with: sprite exec -s ' + spriteName + ` -- cat ${AGENT_DIR}/agent.log`)
      }
    }

    // Get URL
    const urlResult = await execCommand('sprite', ['url', '-s', spriteName], {silent: true})
    // sprite url may output multiple lines (URL + Auth info); extract only the first line
    const firstLine = urlResult.stdout.split(/\r?\n/)[0] || ''
    const deploymentUrl = firstLine
      .replace(/^URL:\s*/i, '')
      .trim()

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
    this.log(`  sprite exec -s ${spriteName} -- cat ${AGENT_DIR}/agent.log`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    this.log('To destroy:')
    this.log(`  cast shutdown ${agentName}`)
  }

  private async execOnSprite(spriteName: string, command: string, timeout?: number): Promise<string> {
    // Use execSync directly to avoid shell=true mangling && and other operators
    // All commands run via sudo since sprite exec runs as the 'sprite' user
    try {
      const stdout = execSync(
        `sprite exec -s "${spriteName}" -- bash -c 'sudo bash -c "${command.replace(/"/g, '\\"')}"'`,
        {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeout || 120000},
      )
      return stdout
    } catch (e: any) {
      throw new Error(`Sprite command failed: ${e.stderr || e.message}`)
    }
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
      execSync(`sprite exec -s ${spriteName} -- bash -c 'sudo mkdir -p ${AGENT_DIR} && base64 -d > /tmp/agent.tar.gz'`, {
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

  private async setupBackgroundService(spriteName: string, agentName: string, authToken: string): Promise<void> {
    const openrouterKey = getOpenRouterApiKey()

    // Kill any existing agent process
    this.log('  Stopping any existing agent process...')
    await this.execOnSprite(spriteName, `if [ -f ${AGENT_DIR}/agent.pid ]; then kill $(cat ${AGENT_DIR}/agent.pid) 2>/dev/null; rm -f ${AGENT_DIR}/agent.pid; fi`)

    // Create startup script that backgrounds itself and exits immediately
    this.log('  Creating startup script...')
    const startScript = `#!/bin/bash
cd ${AGENT_DIR}
export PYTHONPATH=${AGENT_DIR}/.cast-runtime
export CAST_AGENT_NAME=${agentName}
export CAST_AGENT_PATH=${AGENT_DIR}
export AUTH_TOKEN=${authToken}
${openrouterKey ? `export OPENROUTER_API_KEY=${openrouterKey}` : ''}
# Start agent in background, redirect all output, write PID, then exit
nohup ${AGENT_DIR}/venv/bin/python -m cast.runtime --agent-path ${AGENT_DIR} --port 8080 --host 0.0.0.0 > ${AGENT_DIR}/agent.log 2>&1 &
echo $! > ${AGENT_DIR}/agent.pid
`

    await this.execOnSprite(spriteName, `cat > ${AGENT_DIR}/start.sh << 'EOF'\n${startScript}EOF`)
    await this.execOnSprite(spriteName, `chmod +x ${AGENT_DIR}/start.sh`)

    // Run the start script using execCommand (spawn) instead of execSync
    // This avoids blocking on background processes that inherit stdio pipes
    this.log('  Starting agent process...')
    const startResult = await execCommand('sprite', ['exec', '-s', spriteName, '--', 'bash', '-c', `sudo bash ${AGENT_DIR}/start.sh`], {silent: true})
    if (startResult.exitCode !== 0) {
      this.warn(`Start script returned exit code ${startResult.exitCode}: ${startResult.stderr}`)
    }
  }
}
