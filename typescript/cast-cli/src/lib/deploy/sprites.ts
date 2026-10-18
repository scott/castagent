import {Args, Command} from '@oclif/core'
import {execFileSync, spawn} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {
  checkCli,
  generateAuthToken,
  getAgentPath,
  execCommand,
  saveDeployment,
  inferenceEnv,
  filterInferenceEnv,
  readAgentModel,
  secretValues,
  assertSecretsNotInArgv,
  generateDeploymentId,
  getVolumeName,
} from './deploy-utils'
import {
  SPRITE_SERVICE_NAME,
  spriteAgentLaunchScript,
  spriteInstallExecArgs,
  spriteServiceStatusArgs,
} from './sprites-service'

const AGENT_DIR = '/opt/cast-agent'
const HOST_MOUNT_BASE = '/mnt/cast-memory'

/** argv for `sprite exec` with no local shell. The remote command is one argument. */
export function spriteExecArgv(spriteName: string, command: string): string[] {
  return ['exec', '-s', spriteName, '--', 'sudo', 'bash', '-c', command]
}

export function spriteReadyArgv(spriteName: string): string[] {
  return ['exec', '-s', spriteName, '--', 'echo', 'ready']
}

export function runSpriteExec(spriteName: string, command: string, timeout = 120000): string {
  try {
    return execFileSync('sprite', spriteExecArgv(spriteName, command), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    })
  } catch (e: any) {
    const errorMsg = e?.message || ''
    const stderr = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString?.() || ''
    if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timed out')) {
      throw new Error(`Sprite command timed out after ${timeout / 1000}s: ${command.substring(0, 50)}...`)
    }
    throw new Error(`Sprite command failed: ${stderr || errorMsg}`)
  }
}

export default class SpritesDeploy extends Command {
  static description = 'Deploy agent to Sprites (Fly.io Firecracker VM)'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static async destroy(agentName: string): Promise<void> {
    const spriteName = `cast-${agentName}`
    const result = await execCommand('sprite', ['destroy', spriteName, '--force'])
    if (result.exitCode !== 0) {
      // Check if it's a "not found" error - that's actually okay, the sprite is already gone
      if (result.stderr.includes('not found') || result.stderr.includes('does not exist') || result.stderr.includes('No such sprite')) {
        console.log(`Sprite '${spriteName}' does not exist (already deleted or never created).`)
        return
      }
      throw new Error(`Failed to destroy sprite '${spriteName}': ${result.stderr || result.stdout}`)
    }
    console.log(`Sprite '${spriteName}' has been destroyed.`)

    // Clean up host memory directory
    const volumeId = getVolumeName(agentName, generateDeploymentId())
    const hostMemoryPath = `${HOST_MOUNT_BASE}/${volumeId}`
    try {
      // Try to remove the specific path (will only work if directory is empty)
      await execCommand('sudo', ['rmdir', hostMemoryPath], {silent: true})
      console.log(`Host memory directory '${hostMemoryPath}' has been removed.`)
    } catch {
      // Directory may not exist or not be empty (other deployments using it)
    }
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

    // Generate auth token and deployment ID
    const { authToken, tokenHash } = await generateAuthToken(agentName)
    const deploymentId = generateDeploymentId()
    const volumeId = getVolumeName(agentName, deploymentId)
    const hostMemoryPath = `${HOST_MOUNT_BASE}/${volumeId}`

    const spriteName = `cast-${agentName}`

    // Ensure sprite exists
    this.log(`Ensuring sprite '${spriteName}' exists...`)
    const createResult = await execCommand('sprite', ['create', spriteName], {silent: true})
    if (createResult.exitCode !== 0 && !createResult.stderr.includes('already exists')) {
      this.error(`Failed to create sprite: ${createResult.stderr}`)
    }

    // Wait for sprite to be ready (check up to 30 seconds)
    this.log('Waiting for sprite to be ready...')
    let spriteReady = false
    for (let i = 0; i < 10; i++) {
      if (await this.checkSpriteReady(spriteName)) {
        spriteReady = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    if (!spriteReady) {
      this.warn('Sprite may not be fully ready, trying anyway...')
    }

    // Create host directory for memory volume
    this.log(`Creating host memory directory: ${hostMemoryPath}`)
    await execCommand('sudo', ['mkdir', '-p', hostMemoryPath], {silent: true})
    await execCommand('sudo', ['chmod', '777', hostMemoryPath], {silent: true})

    // Ensure Python and venv are installed (use longer timeout for apt)
    this.log('Ensuring Python is installed...')
    await this.execOnSprite(spriteName, 'apt-get update && apt-get install -y python3 python3-pip python3-venv', 300000)

    // Package and transfer agent files
    this.log('Transferring agent files...')
    await this.transferAgentFiles(agentPath, spriteName)

    // Create memory directory inside sprite
    this.log('Creating memory directory inside sprite...')
    await this.execOnSprite(spriteName, `mkdir -p ${AGENT_DIR}/memory`)

    // Create virtual environment and install dependencies
    // Use longer timeout for venv creation and pip install (5 minutes)
    const longTimeout = 300000

    this.log('Setting up Python environment...')
    await this.execOnSprite(spriteName, `python3 -m venv ${AGENT_DIR}/venv`, longTimeout)
    this.log('Installing dependencies...')
    await this.execOnSprite(spriteName, `${AGENT_DIR}/venv/bin/pip install -r ${AGENT_DIR}/requirements.txt`, longTimeout)

    // Register a supervised service. A one-shot nohup dies with the exec
    // session, and the sprite proxy then resets every chat connection.
    this.log('Starting agent service...')
    await this.setupBackgroundService(spriteName, agentName, authToken)

    const status = await execCommand('sprite', spriteServiceStatusArgs(spriteName), {silent: true, shell: false})
    if (status.exitCode !== 0 || !status.stdout.includes('"status":"running"')) {
      this.warn(
        'Agent service may not be running. Check logs with: sprite exec -s ' +
        spriteName + ` -- cat /.sprite/logs/services/${SPRITE_SERVICE_NAME}.log`,
      )
    }

    // Get URL
    const urlResult = await execCommand('sprite', ['url', '-s', spriteName], {silent: true})
    // sprite url may output multiple lines (URL + Auth info); extract only the first line
    const firstLine = urlResult.stdout.split(/\r?\n/)[0] || ''
    const deploymentUrl = firstLine
      .replace(/^URL:\s*/i, '')
      .trim()

    // Save deployment
    const volumeConfig = JSON.stringify({ deploymentId, mountPath: '/opt/cast-agent/memory', hostPath: hostMemoryPath })
    saveDeployment(agentName, 'sprites', deploymentUrl, tokenHash, volumeId, volumeConfig)

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
    // sprite exec runs as the sprite user, so the remote command uses sudo.
    // Name and command are argv. A local shell would treat quotes in either as syntax.
    return runSpriteExec(spriteName, command, timeout || 120000)
  }

  private async checkSpriteReady(spriteName: string): Promise<boolean> {
    try {
      const result = execFileSync('sprite', spriteReadyArgv(spriteName), {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      })
      return result.trim() === 'ready'
    } catch {
      return false
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
      // Note: We don't exclude files here as macOS tar (BSD) has limited exclude support.
      // The main fix is the streaming transfer to avoid the string length limit.
      // Large files should be cleaned up before deployment or will be handled by user.
      execFileSync('tar', ['czf', tarPath, '-C', agentPath, '.'], {
        encoding: 'utf8',
        stdio: 'pipe',
      })

      // Get file size to check if it's too large
      const tarStats = fs.statSync(tarPath)
      const fileSizeMB = (tarStats.size / (1024 * 1024)).toFixed(2)
      this.log(`  Tar file size: ${fileSizeMB}MB`)

      // Use streaming transfer to avoid Node.js string length limit (~512MB)
      // The base64 encoding increases size by ~33%, so we need to stream to avoid hitting the limit
      this.log('  Transferring tar to sprite (streaming)...')
      await this.streamFileToSprite(tarPath, spriteName, tarStats.size)

      // Extract on sprite (use longer timeout for extraction)
      this.log('  Extracting files...')
      await this.execOnSprite(spriteName, `tar xzf /tmp/agent.tar.gz -C ${AGENT_DIR} && rm /tmp/agent.tar.gz`, 300000)
    } finally {
      // Clean up local tar
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath)
      }
    }
  }

  private streamFileToSprite(localPath: string, spriteName: string, originalSize: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Spawn the sprite exec command - truncate to original size after decode
      const child = spawn(
        'sprite',
        ['exec', '-s', spriteName, '--', 'bash', '-c', `sudo mkdir -p ${AGENT_DIR} && base64 -d > /tmp/agent.tar.gz && truncate -s ${originalSize} /tmp/agent.tar.gz`],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      let stderr = ''

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn sprite command: ${err.message}`))
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Sprite command failed with code ${code}: ${stderr}`))
        }
      })

      // Use streaming base64 transfer with proper chunking
      // Read file in chunks that are multiples of 3 bytes for valid base64
      const CHUNK_SIZE = 3 * 1024 * 1024 // 3MB chunks (multiple of 3 for clean base64 boundaries)
      let leftover = Buffer.alloc(0)

      const readStream = fs.createReadStream(localPath, { highWaterMark: CHUNK_SIZE })

      readStream.on('data', (chunk: Buffer | string) => {
        // Handle both Buffer and string chunks
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk

        // Combine with any leftover bytes from previous chunk
        const combined = Buffer.concat([leftover, bufferChunk])
        const remainder = combined.length % 3

        // Process all complete 3-byte groups
        const complete = remainder ? combined.slice(0, -remainder) : combined
        leftover = remainder ? combined.slice(-remainder) : Buffer.alloc(0)

        if (complete.length > 0) {
          const encoded = complete.toString('base64')
          if (!child.stdin?.write(encoded)) {
            // Handle backpressure
            readStream.pause()
            child.stdin?.once('drain', () => readStream.resume())
          }
        }
      })

      readStream.on('end', () => {
        // Process remaining bytes with proper base64 padding
        if (leftover.length > 0) {
          // Pad with null bytes to make it a multiple of 3, then encode
          // The remote will decode correctly since the original size is known
          const padded = Buffer.concat([leftover, Buffer.alloc(3 - leftover.length)])
          const encoded = padded.toString('base64')
          child.stdin?.write(encoded)
        }
        child.stdin?.end()
      })

      readStream.on('error', (err) => {
        reject(new Error(`Failed to read tar file: ${err.message}`))
      })
    })
  }

  private async setupBackgroundService(spriteName: string, agentName: string, authToken: string): Promise<void> {
    this.log('  Stopping any existing agent process...')
    await this.execOnSprite(spriteName, `if [ -f ${AGENT_DIR}/agent.pid ]; then kill $(cat ${AGENT_DIR}/agent.pid) 2>/dev/null; rm -f ${AGENT_DIR}/agent.pid; fi`)

    // stdin is the script. The remote bash -c string must stay one argument.
    this.log('  Creating startup script...')
    const inference = filterInferenceEnv(readAgentModel(getAgentPath(agentName)), inferenceEnv())
    const args = spriteInstallExecArgs(spriteName)
    const script = spriteAgentLaunchScript(agentName, authToken, inference)
    assertSecretsNotInArgv('sprite exec', args, secretValues({AUTH_TOKEN: authToken, ...inference}))
    const startResult = await execCommand(
      'sprite',
      args,
      {silent: true, shell: false, input: script},
    )
    if (startResult.exitCode !== 0) {
      const detail = (startResult.stderr || startResult.stdout).trim()
      this.warn(`Agent service returned exit code ${startResult.exitCode}${detail ? `: ${detail}` : ''}`)
    }
  }
}
