import {Args, Command} from '@oclif/core'
import {execFileSync, spawn} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {keychain} from '../keychain'
import {db} from '../sqlite'
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
  copyCastPackage,
  deploymentShaFromEnv,
  isShaPattern,
  type InferenceCatalogEntry,
} from './deploy-utils'
import {waitForContainerHealth} from './container-health'
import {writeRequirementsTxt} from './requirements'
import {
  SPRITE_SERVICE_LOG,
  SPRITE_SERVICE_NAME,
  ensureSpriteCliToken,
  parseSpriteServiceProbe,
  redactSecrets,
  redactSpriteSecrets,
  spriteAgentLaunchScript,
  spriteCliEnv,
  spriteHealthProbeCommand,
  spriteInstallExecArgs,
} from './sprites-service'

const AGENT_DIR = '/opt/cast-agent'
const SPRITE_MEMORY_PATH = `${AGENT_DIR}/memory`
/** Local directories created by deploys before memory stayed on the sprite. */
export const HOST_MOUNT_BASE = '/mnt/cast-memory'

/** argv for `sprite exec` with no local shell. The remote command is one argument. */
export function spriteExecArgv(spriteName: string, command: string): string[] {
  return ['exec', '-s', spriteName, '--', 'sudo', 'bash', '-c', command]
}

export function spriteReadyArgv(spriteName: string): string[] {
  return ['exec', '-s', spriteName, '--', 'echo', 'ready']
}

export function runSpriteExec(spriteName: string, command: string, timeout = 120000): string {
  ensureSpriteCliToken()
  try {
    return execFileSync('sprite', spriteExecArgv(spriteName, command), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      env: spriteCliEnv(),
    })
  } catch (e: any) {
    const errorMsg = e?.message || ''
    const stderr = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString?.() || ''
    const detail = redactSpriteSecrets(stderr || errorMsg)
    if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timed out')) {
      throw new Error(`Sprite command timed out after ${timeout / 1000}s: ${command.substring(0, 50)}...`)
    }
    throw new Error(`Sprite command failed: ${detail}`)
  }
}

export interface SpriteLog {
  log(message: string): void
  warn(message: string): void
}

export interface SpriteDeployOptions {
  healthTimeoutMs?: number
  healthIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /**
   * Resolved inference env before it is narrowed to the model's key.
   * Tests pass a stub so the catalog import is not required.
   */
  serviceEnv?: () => Record<string, string>
  /** Used with serviceEnv so tests do not load the Python catalog. */
  inferenceCatalog?: InferenceCatalogEntry[]
  /**
   * Bearer token to install. When set, the deploy reuses it and does not
   * mint a replacement. Upgrade passes the token already stored for the
   * deployment.
   */
  authToken?: string
  /**
   * When false, the sprite is installed and no deployment row is written.
   * Upgrade leaves the existing row in place and records the version only
   * after this call returns.
   */
  recordDeployment?: boolean
}

export interface SpriteDestroyOptions {
  /** Root of host paths recorded by older deploys. Tests pass a temporary directory. */
  hostMemoryRoot?: string
}

/** Write requirements.txt and copy python/cast into the agent directory before the tar. */
export function stageSpriteAgent(agentPath: string, projectRoot = findSpriteProjectRoot()): void {
  writeRequirementsTxt(projectRoot, agentPath)
  copyCastPackage(agentPath, projectRoot)
}

export function findSpriteProjectRoot(): string {
  const marker = 'python/cast'
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    path.resolve(__dirname, '../../../../../..'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, marker))) return candidate
  }
  return process.cwd()
}

export function spriteMemoryConfig(deploymentId: string): string {
  return JSON.stringify({deploymentId, mountPath: SPRITE_MEMORY_PATH})
}

export function recordedHostMemoryPaths(
  agentName: string,
  configs: Array<string | null | undefined>,
  root = HOST_MOUNT_BASE,
): string[] {
  const paths: string[] = []
  const prefix = `cast-${agentName}-`
  for (const config of configs) {
    let hostPath: unknown
    try {
      hostPath = JSON.parse(config || '{}').hostPath
    } catch {
      continue
    }
    if (typeof hostPath !== 'string' || hostPath.length === 0) continue
    if (hostPath.includes('\0') || hostPath.includes('..')) continue
    if (path.posix.dirname(hostPath) !== root) continue
    const base = path.posix.basename(hostPath)
    if (!base.startsWith(prefix) || !base.endsWith('-memory')) continue
    if (!paths.includes(hostPath)) paths.push(hostPath)
  }
  return paths
}

export function removeHostMemoryDir(hostPath: string): 'removed' | 'missing' | 'failed' {
  if (!fs.existsSync(hostPath)) return 'missing'
  try {
    fs.rmdirSync(hostPath)
    return 'removed'
  } catch {
    return 'failed'
  }
}

/**
 * Remove host directories recorded on earlier deploys.
 * A missing directory is left unmentioned. A directory that is still there
 * is reported as not removed.
 */
export function cleanupRecordedSpriteMemory(
  agentName: string,
  configs: Array<string | null | undefined>,
  log: (message: string) => void = console.log,
  root = HOST_MOUNT_BASE,
): void {
  for (const hostPath of recordedHostMemoryPaths(agentName, configs, root)) {
    const result = removeHostMemoryDir(hostPath)
    if (result === 'removed') {
      log(`Host memory directory '${hostPath}' has been removed.`)
    } else if (result === 'failed') {
      log(`Host memory directory '${hostPath}' could not be removed.`)
    }
  }
}

export async function discardFailedSpriteTokens(agentName: string, deploymentSha: string | undefined): Promise<void> {
  if (deploymentSha && isShaPattern(deploymentSha)) {
    await keychain.deleteDeploymentToken(deploymentSha)
  }
  if (db.listDeployments(agentName).length === 0) {
    await keychain.deleteToken(agentName)
  }
}

function spriteAlreadyExists(result: {exitCode: number; stderr: string; stdout: string}): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return text.includes('already exists')
}

function spriteIsGone(result: {stderr: string; stdout: string}): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return text.includes('not found') || text.includes('does not exist') || text.includes('no such sprite')
}

async function destroyCreatedSprite(spriteName: string): Promise<'destroyed' | 'missing' | 'failed'> {
  const result = await execCommand('sprite', ['destroy', spriteName, '--force'], {
    silent: true,
    shell: false,
    env: spriteCliEnv(),
  })
  if (result.exitCode === 0) return 'destroyed'
  if (spriteIsGone(result)) return 'missing'
  return 'failed'
}

export async function rollbackFailedSpriteDeploy(input: {
  agentName: string
  spriteName: string
  createdSprite: boolean
  deploymentSha?: string
  tokenHash: string
  deploymentId: string
  log: (message: string) => void
  /** Upgrade reuses the live deployment token, so a failed redeploy must leave it stored. */
  discardTokens?: boolean
}): Promise<void> {
  let recorded = false
  if (input.createdSprite) {
    const destroyed = await destroyCreatedSprite(input.spriteName)
    if (destroyed === 'failed') {
      await saveDeployment(
        input.agentName,
        'sprites',
        `https://${input.spriteName}.sprites.app`,
        input.tokenHash,
        `cast-${input.agentName}-memory`,
        spriteMemoryConfig(input.deploymentId),
        undefined,
        {supersede: false},
      )
      input.log(
        `Could not delete sprite '${input.spriteName}'. Recorded the deployment so cast shutdown ${input.agentName} can clean it up.`,
      )
      recorded = true
    } else {
      input.log(`Removed sprite '${input.spriteName}' after the deploy failed.`)
    }
  }
  if (!recorded && input.discardTokens !== false) {
    await discardFailedSpriteTokens(input.agentName, input.deploymentSha)
  }
}

function tailText(text: string, maxLines = 80): string {
  const lines = text.trim().split('\n')
  if (lines.length <= maxLines) return text.trim()
  return lines.slice(-maxLines).join('\n').trim()
}

export function spriteHealthFailureMessage(
  spriteName: string,
  result: {status: string; logs: string; reason: 'exited' | 'timeout'},
): string {
  const status = result.status || 'unknown'
  const summary = result.reason === 'timeout'
    ? `Sprite service '${SPRITE_SERVICE_NAME}' on '${spriteName}' did not become ready (status: ${status}).`
    : `Sprite service '${SPRITE_SERVICE_NAME}' on '${spriteName}' failed before the runtime was ready.`
  const logs = tailText(result.logs)
  const parts = [summary, `Status: ${status}`]
  if (logs) parts.push(logs)
  parts.push(`Logs: sprite exec -s ${spriteName} -- cat ${SPRITE_SERVICE_LOG}`)
  return parts.join('\n')
}

export async function deployToSprites(
  agentName: string,
  hooks: SpriteLog,
  options: SpriteDeployOptions = {},
): Promise<void> {
  ensureSpriteCliToken()
  const agentPath = getAgentPath(agentName)
  if (!fs.existsSync(agentPath)) {
    throw new Error(`Agent '${agentName}' not found at ${agentPath}`)
  }

  hooks.log(`Deploying ${agentName} to Sprites...`)

  try {
    await checkCli('sprite', 'https://sprites.dev/install.sh')
  } catch (error: any) {
    throw new Error(redactSpriteSecrets(error?.message || String(error)))
  }

  const authCheck = await execCommand('sprite', ['list'], {silent: true, shell: false, env: spriteCliEnv()})
  if (authCheck.exitCode !== 0) {
    const detail = redactSpriteSecrets((authCheck.stderr || authCheck.stdout).trim())
    throw new Error(
      'Not authenticated with Sprites. Run "sprite login" or set SPRITES_TOKEN.'
      + (detail ? `\n${detail}` : ''),
    )
  }

  stageSpriteAgent(agentPath)

  const deploymentSha = deploymentShaFromEnv()
  const spriteName = `cast-${agentName}`
  let createdSprite = false
  let tokenHash = ''
  const deploymentId = generateDeploymentId()
  const recordDeployment = options.recordDeployment !== false

  try {
    let authToken = options.authToken || ''
    if (!authToken) {
      const generated = await generateAuthToken(agentName)
      tokenHash = generated.tokenHash
      authToken = generated.authToken
    } else if (recordDeployment) {
      tokenHash = keychain.hashToken(authToken)
    }

    hooks.log(`Ensuring sprite '${spriteName}' exists...`)
    const createResult = await execCommand('sprite', ['create', spriteName], {
      silent: true,
      shell: false,
      env: spriteCliEnv(),
    })
    if (createResult.exitCode !== 0 && !spriteAlreadyExists(createResult)) {
      throw new Error(`Failed to create sprite: ${redactSpriteSecrets(createResult.stderr || createResult.stdout)}`)
    }
    createdSprite = createResult.exitCode === 0 && !spriteAlreadyExists(createResult)

    hooks.log('Waiting for sprite to be ready...')
    let spriteReady = false
    for (let i = 0; i < 10; i++) {
      if (await checkSpriteReady(spriteName)) {
        spriteReady = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    if (!spriteReady) {
      hooks.warn('Sprite may not be fully ready, trying anyway...')
    }

    hooks.log('Ensuring Python is installed...')
    await execOnSprite(spriteName, 'apt-get update && apt-get install -y python3 python3-pip python3-venv git', 300000)

    hooks.log('Transferring agent files...')
    await transferAgentFiles(agentPath, spriteName, hooks)

    hooks.log('Creating memory directory inside sprite...')
    await execOnSprite(spriteName, `mkdir -p ${SPRITE_MEMORY_PATH} && chmod 700 ${SPRITE_MEMORY_PATH}`)

    const longTimeout = 300000
    hooks.log('Setting up Python environment...')
    await execOnSprite(spriteName, `python3 -m venv ${AGENT_DIR}/venv`, longTimeout)
    hooks.log('Installing dependencies...')
    await execOnSprite(spriteName, `${AGENT_DIR}/venv/bin/pip install -r ${AGENT_DIR}/requirements.txt`, longTimeout)

    hooks.log('Starting agent service...')
    const resolvedEnv = options.serviceEnv ? options.serviceEnv() : inferenceEnv()
    const inference = filterInferenceEnv(readAgentModel(agentPath), resolvedEnv, options.inferenceCatalog)
    await setupBackgroundService(spriteName, agentName, authToken, inference)

    hooks.log('Waiting for the agent service to become ready...')
    const health = await waitForContainerHealth(async () => {
      try {
        return parseSpriteServiceProbe(runSpriteExec(spriteName, spriteHealthProbeCommand(), 20000))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {status: 'missing', logs: message}
      }
    }, {
      timeoutMs: options.healthTimeoutMs,
      intervalMs: options.healthIntervalMs ?? 2_000,
      sleep: options.sleep,
      now: options.now,
    })
    if (!health.ok) {
      throw new Error(spriteHealthFailureMessage(spriteName, {
        ...health,
        logs: redactSecrets(health.logs, [authToken, process.env.SPRITES_TOKEN, process.env.SPRITE_TOKEN]),
      }))
    }

    const urlResult = await execCommand('sprite', ['url', '-s', spriteName], {
      silent: true,
      shell: false,
      env: spriteCliEnv(),
    })
    const firstLine = urlResult.stdout.split(/\r?\n/)[0] || ''
    const deploymentUrl = firstLine.replace(/^URL:\s*/i, '').trim()

    if (recordDeployment) {
      await saveDeployment(
        agentName,
        'sprites',
        deploymentUrl,
        tokenHash,
        `cast-${agentName}-memory`,
        spriteMemoryConfig(deploymentId),
      )
    }

    hooks.log('')
    hooks.log('╔══════════════════════════════════════════════════════════════╗')
    hooks.log('║              Sprites Deployment Successful!                  ║')
    hooks.log('╚══════════════════════════════════════════════════════════════╝')
    hooks.log('')
    hooks.log(`Agent: ${agentName}`)
    hooks.log(`Sprite: ${spriteName}`)
    hooks.log('Provider: sprites')
    hooks.log('')
    hooks.log('To connect:')
    hooks.log(`  cast connect ${agentName}`)
    hooks.log('cast connect starts a local sprite proxy and sends the deployment bearer token.')
    if (deploymentUrl) {
      hooks.log(`Sprites address: ${deploymentUrl}`)
    }
    hooks.log('That address needs Sprites org auth. A request without it returns 302 to the Sprites login page.')
    hooks.log('It is not a direct agent URL. Use cast connect.')
    hooks.log('')
    hooks.log('To view logs:')
    hooks.log(`  cast logs ${agentName}`)
    hooks.log(`  sprite exec -s ${spriteName} -- cat ${SPRITE_SERVICE_LOG}`)
    hooks.log('')
    hooks.log('To destroy:')
    hooks.log(`  cast shutdown ${agentName}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await rollbackFailedSpriteDeploy({
        agentName,
        spriteName,
        createdSprite,
        deploymentSha,
        tokenHash,
        deploymentId,
        log: (line) => hooks.log(line),
        discardTokens: options.authToken ? false : undefined,
      })
    } catch (rollbackError) {
      const extra = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`${redactSpriteSecrets(message)}\nCleanup failed: ${redactSpriteSecrets(extra)}`)
    }
    throw new Error(redactSpriteSecrets(message))
  }
}

async function checkSpriteReady(spriteName: string): Promise<boolean> {
  try {
    const result = execFileSync('sprite', spriteReadyArgv(spriteName), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      env: spriteCliEnv(),
    })
    return result.trim() === 'ready'
  } catch {
    return false
  }
}

async function execOnSprite(spriteName: string, command: string, timeout?: number): Promise<string> {
  return runSpriteExec(spriteName, command, timeout || 120000)
}

function spriteVolumeConfigs(
  agentName: string,
  deployment?: {volume_config?: string | null},
): Array<string | null | undefined> {
  const configs: Array<string | null | undefined> = []
  if (deployment?.volume_config) configs.push(deployment.volume_config)
  for (const row of db.listDeployments(agentName)) {
    if (row?.provider === 'sprites') configs.push(row.volume_config)
  }
  return configs
}

async function transferAgentFiles(agentPath: string, spriteName: string, hooks: SpriteLog): Promise<void> {
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
      hooks.log(`  Tar file size: ${fileSizeMB}MB`)

      // Use streaming transfer to avoid Node.js string length limit (~512MB)
      // The base64 encoding increases size by ~33%, so we need to stream to avoid hitting the limit
      hooks.log('  Transferring tar to sprite (streaming)...')
      await streamFileToSprite(tarPath, spriteName, tarStats.size)

      // Extract on sprite (use longer timeout for extraction)
      hooks.log('  Extracting files...')
      await execOnSprite(spriteName, `tar xzf /tmp/agent.tar.gz -C ${AGENT_DIR} && rm /tmp/agent.tar.gz`, 300000)
    } finally {
      // Clean up local tar
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath)
      }
    }
}

function streamFileToSprite(localPath: string, spriteName: string, originalSize: number): Promise<void> {
  ensureSpriteCliToken()
  return new Promise((resolve, reject) => {
    // Spawn the sprite exec command - truncate to original size after decode
    const child = spawn(
      'sprite',
      ['exec', '-s', spriteName, '--', 'bash', '-c', `sudo mkdir -p ${AGENT_DIR} && base64 -d > /tmp/agent.tar.gz && truncate -s ${originalSize} /tmp/agent.tar.gz`],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spriteCliEnv(),
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

async function setupBackgroundService(
  spriteName: string,
  agentName: string,
  authToken: string,
  env: Record<string, string>,
): Promise<void> {
  await execOnSprite(spriteName, `if [ -f ${AGENT_DIR}/agent.pid ]; then kill $(cat ${AGENT_DIR}/agent.pid) 2>/dev/null; rm -f ${AGENT_DIR}/agent.pid; fi`)

  // stdin is the script. The remote bash -c string must stay one argument.
  // env is already narrowed to the model's inference key.
  const args = spriteInstallExecArgs(spriteName)
  const script = spriteAgentLaunchScript(agentName, authToken, env)
  assertSecretsNotInArgv('sprite exec', args, secretValues({AUTH_TOKEN: authToken, ...env}))
  const startResult = await execCommand(
    'sprite',
    args,
    {
      silent: true,
      shell: false,
      env: spriteCliEnv(),
      input: script,
    },
  )
  if (startResult.exitCode !== 0) {
    const detail = redactSecrets((startResult.stderr || startResult.stdout).trim(), [
      authToken,
      process.env.SPRITES_TOKEN,
      process.env.SPRITE_TOKEN,
    ])
    throw new Error(`Failed to start the sprite agent service${detail ? `: ${detail}` : ''}`)
  }
}

export default class SpritesDeploy extends Command {
  static description = 'Deploy agent to Sprites (Fly.io Firecracker VM)'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static async destroy(
    agentName: string,
    deployment?: {volume_config?: string | null},
    options: SpriteDestroyOptions = {},
  ): Promise<void> {
    ensureSpriteCliToken()
    const spriteName = `cast-${agentName}`
    const result = await execCommand('sprite', ['destroy', spriteName, '--force'], {
      silent: true,
      shell: false,
      env: spriteCliEnv(),
    })
    const missing = result.exitCode !== 0 && spriteIsGone(result)
    const failed = result.exitCode !== 0 && !missing
    if (missing) {
      console.log(`Sprite '${spriteName}' does not exist (already deleted or never created).`)
    } else if (!failed) {
      console.log(`Sprite '${spriteName}' has been destroyed.`)
    }

    cleanupRecordedSpriteMemory(
      agentName,
      spriteVolumeConfigs(agentName, deployment),
      console.log,
      options.hostMemoryRoot,
    )

    if (failed) {
      throw new Error(`Failed to destroy sprite '${spriteName}': ${redactSpriteSecrets(result.stderr || result.stdout)}`)
    }
  }

  async run(): Promise<void> {
    const {args} = await this.parse(SpritesDeploy)
    try {
      await deployToSprites(args.agent as string, {
        log: (message) => this.log(message),
        warn: (message) => this.warn(message),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(message)
    }
  }
}
