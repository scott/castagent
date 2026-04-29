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

export function getAgentPath(agentName: string): string {
  return path.join(os.homedir(), 'cast-agents', agentName)
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

export function getProviderToken(provider: string): string | undefined {
  const envVar = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'
  if (process.env[envVar]) {
    return process.env[envVar]
  }
  if (process.env[`${envVar}_API_KEY`]) {
    return process.env[`${envVar}_API_KEY`]
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
RUN apt-get update && apt-get install -y \\
    gcc \\
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
CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080"]
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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; silent?: boolean; input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env || process.env,
      shell: true,
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
): void {
  db.setDeployment(agentName, provider, url, tokenHash)
}

export function getOpenRouterApiKey(): string | undefined {
  return (
    process.env.OPENROUTER_API_KEY ||
    loadConfig().providers?.openrouter?.api_key
  )
}
