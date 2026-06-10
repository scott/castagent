import { spawn } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import crypto from 'crypto'
import YAML from 'yaml'
import { db } from '../sqlite'
import { keychain } from '../keychain'

const CAST_DIR = path.join(os.homedir(), '.cast')
const CONFIG_PATH = path.join(CAST_DIR, 'config.yaml')

export interface DeploymentResult {
  url: string
  authToken: string
}

export interface VolumeConfig {
  volumeId: string
  mountPath: string
  provider: string
  config?: Record<string, any>
}

export interface DeploymentResolution {
  type: 'sha' | 'single' | 'ambiguous' | 'not_found'
  deployment?: any
  deployments?: any[]
  message?: string
}

// Check if input matches SHA pattern (6 lowercase alphanumeric chars)
export function isShaPattern(input: string): boolean {
  return /^[a-z0-9]{6}$/.test(input)
}

// Resolve deployment target - tries SHA first, then agent name
export function resolveDeploymentTarget(input: string): DeploymentResolution {
  // Try SHA lookup first
  if (isShaPattern(input)) {
    const deployment = db.getDeploymentBySha(input)
    if (deployment) {
      return { type: 'sha', deployment }
    }
    return { type: 'not_found', message: `No deployment found for '${input}'. Use 'cast deploy' to deploy.` }
  }

  // Try agent name lookup
  const deployments = db.listDeployments(input)
  if (deployments.length === 0) {
    return { type: 'not_found', message: `No deployment found for '${input}'. Use 'cast deploy' to deploy.` }
  }
  if (deployments.length === 1) {
    return { type: 'single', deployment: deployments[0] }
  }

  // Multiple deployments - return ambiguous with list
  const shaList = deployments.map(d => d.id).join(', ')
  return {
    type: 'ambiguous',
    deployments,
    message: `Multiple deployments found for '${input}'. Use SHA: ${shaList}`
  }
}

export function generateDeploymentId(): string {
  return crypto.randomUUID()
}

// Generate deployment SHA (6 chars, lowercase alphanumeric)
export function generateDeploymentSha(agentName: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(agentName + Date.now().toString() + crypto.randomBytes(16).toString('hex'))
  return hash.digest('hex').substring(0, 6).toLowerCase()
}

export function getAgentPath(agentName: string): string {
  return path.join(os.homedir(), '.cast', 'agents', agentName)
}

export function loadConfig(): any {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {}
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return YAML.parse(content) || {}
  } catch {
    return {}
  }
}

export function getProviderToken(provider: string, envVarNames?: string[]): string | undefined {
  // Check custom env vars first
  if (envVarNames) {
    for (const envName of envVarNames) {
      if (process.env[envName]) {
        return process.env[envName]
      }
    }
  }

  // Fall back to auto-generated env var name
  const envVar = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'
  if (process.env[envVar]) {
    return process.env[envVar]
  }

  const config = loadConfig()
  const providerConfig = config.providers?.[provider]
  if (providerConfig?.api_key) {
    const key = providerConfig.api_key
    if (key.startsWith('${') && key.endsWith('}')) {
      const envName = key.slice(2, -1)
      return process.env[envName]
    }
    return key
  }
  if (providerConfig?.token) {
    const token = providerConfig.token
    if (token.startsWith('${') && token.endsWith('}')) {
      const envName = token.slice(2, -1)
      return process.env[envName]
    }
    return token
  }

  return undefined
}

export async function checkCli(
  command: string,
  installUrl: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, ['--version'])
    let stdout = ''
    let stderr = ''
    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `${command} CLI is not installed. Install it from: ${installUrl}`,
          ),
        )
      } else {
        reject(err)
      }
    })
    proc.on('exit', (code) => {
      if (code === 0 && stdout.length > 0) {
        resolve()
      } else if (stderr.toLowerCase().includes('not found') || stderr.toLowerCase().includes('not recognized')) {
        reject(
          new Error(
            `${command} CLI is not installed. Install it from: ${installUrl}`,
          ),
        )
      } else if (code === 0) {
        resolve()
      } else {
        // Command exists but --version failed; that's okay for our purposes
        resolve()
      }
    })
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
  })
}

export async function generateAuthToken(
  agentName: string,
): Promise<{ authToken: string; tokenHash: string }> {
  const authToken = crypto.randomBytes(32).toString('base64')
  const tokenHash = crypto.createHash('sha256').update(authToken).digest('hex')
  await keychain.setToken(agentName, authToken)
  return { authToken, tokenHash }
}

export function ensureDockerfile(agentPath: string): void {
  const dockerfilePath = path.join(agentPath, 'Dockerfile')
  if (!fs.existsSync(dockerfilePath)) {
    const dockerfile = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy Python runtime
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent files
COPY . /app/agent/

# Set environment variables
ENV CAST_AGENT_PATH=/app/agent
ENV PYTHONPATH=/app

# Expose port
EXPOSE 8080

# Run agent
CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]
`
    fs.writeFileSync(dockerfilePath, dockerfile)
  }

  const requirementsPath = path.join(agentPath, 'requirements.txt')
  if (!fs.existsSync(requirementsPath)) {
    const requirements = `langchain>=0.1.0
langchain-openai>=0.0.5
langchain-core>=0.1.0
starlette>=0.35.0
uvicorn>=0.25.0
pyyaml>=6.0.1
python-dotenv>=1.0.0
`
    fs.writeFileSync(requirementsPath, requirements)
  }
}

export async function execCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; silent?: boolean; input?: string; shell?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env || process.env,
      shell: options?.shell ?? true,  // default to true for backwards compatibility
    })
    let stdout = ''
    let stderr = ''

    if (!options?.silent) {
      proc.stdout?.pipe(process.stdout)
      proc.stderr?.pipe(process.stderr)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    if (options?.input && proc.stdin) {
      proc.stdin.write(options.input)
      proc.stdin.end()
    }

    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      resolve({ stdout, stderr, exitCode: code || 0 })
    })
  })
}

export function saveDeployment(
  agentName: string,
  provider: string,
  url: string,
  tokenHash: string,
  volumeId?: string,
  volumeConfig?: string,
  deployedVersion?: string,
): string {
  // Check if SHA was passed via environment variable (from deploy.ts)
  const envSha = process.env.CAST_DEPLOYMENT_SHA
  if (envSha && isShaPattern(envSha)) {
    db.createDeployment(envSha, agentName, provider, url, tokenHash, volumeId, volumeConfig, deployedVersion)
    return envSha
  }
  // Otherwise, let db.setDeployment auto-generate SHA
  db.setDeployment(agentName, provider, url, tokenHash, volumeId, volumeConfig)
  // Return the SHA that was generated (query the most recent deployment)
  const deployment = db.getActiveDeployment(agentName)
  return deployment?.id || ''
}

export function getOpenRouterApiKey(): string | undefined {
  return (
    process.env.OPENROUTER_API_KEY ||
    loadConfig().providers?.openrouter?.api_key
  )
}

export async function execCommandIgnoreError(
  command: string,
  args: string[],
  options?: { cwd?: string; silent?: boolean },
): Promise<void> {
  try {
    await execCommand(command, args, {...options, silent: options?.silent ?? true})
  } catch {
    // ignore errors
  }
}

export function getVolumeName(agentName: string, deploymentId: string): string {
  return `cast-${agentName}-${deploymentId}-memory`
}

export function getMemoryMountPath(provider: string): string {
  switch (provider) {
    case 'docker':
      return '/app/agent/memory'
    case 'fly':
      return '/app/agent/memory'
    case 'sprites':
      return '/opt/cast-agent/memory'
    case 'railway':
      return '' // Railway uses CAST_MEMORY_PATH env var
    case 'digitalocean':
      return '/app/agent/memory'
    default:
      return '/app/agent/memory'
  }
}

export async function createMemoryVolume(
  provider: string,
  agentName: string,
  deploymentId: string,
): Promise<VolumeConfig> {
  const volumeId = getVolumeName(agentName, deploymentId)
  const mountPath = getMemoryMountPath(provider)

  switch (provider) {
    case 'docker':
      await execCommand('docker', ['volume', 'create', volumeId])
      break
    case 'fly':
      await execCommand('flyctl', ['volumes', 'create', volumeId, '--size', '1', '--app', `cast-${agentName}`])
      break
    case 'sprites':
      // For sprites, we create the host directory (actual volume creation happens at deploy time)
      break
    case 'railway':
      await execCommand('railway', ['volume', 'create', volumeId])
      break
    case 'digitalocean':
      // Volume creation and attachment happen in digitalocean.ts
      break
    default:
      throw new Error(`Unsupported provider for memory volume: ${provider}`)
  }

  return { volumeId, mountPath, provider }
}

export async function deleteMemoryVolume(volumeConfig: VolumeConfig, agentName: string): Promise<void> {
  const { provider, volumeId } = volumeConfig

  switch (provider) {
    case 'docker':
      await execCommandIgnoreError('docker', ['volume', 'rm', volumeId])
      break
    case 'fly':
      await execCommandIgnoreError('flyctl', ['volumes', 'delete', volumeId, '--app', `cast-${agentName}`, '--yes'])
      break
    case 'sprites':
      // Host directory cleanup happens at deploy time
      break
    case 'railway':
      // Railway volumes are tied to projects and cleaned up with project deletion
      break
    case 'digitalocean':
      // DigitalOcean volumes are cleaned up in digitalocean.ts destroy
      break
  }
}
