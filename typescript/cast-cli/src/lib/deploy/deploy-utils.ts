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

  // Check if all deployments target the same (provider, deployment_url) tuple.
  // If so, they are just historical re-deploys of the same logical target
  // (e.g. re-deploying the same agent on the same droplet). Collapse to the
  // most recent row — listDeployments already orders by deployed_at DESC.
  // Only return 'ambiguous' when there are genuinely distinct live targets
  // (different providers or different deployment URLs).
  const uniqueTargets = new Set(
    deployments.map(d => `${d.provider}|${d.deployment_url}`)
  )
  if (uniqueTargets.size === 1) {
    return { type: 'single', deployment: deployments[0] }
  }

  // Multiple distinct targets — genuinely ambiguous
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

// Budget for the total .cast-tui/ build context (dist + node_modules +
// launcher scripts). 100MB accommodates the full @opentui/core tree
// including its transitive deps (jimp, zod, web-tree-sitter, etc.).
// Bump this if you add new TUI dependencies.
const EMBED_BUDGET_MB = 100

/**
 * Prepare the build context for the on-host TUI bundle.
 *
 * Steps:
 *   1. Copy the pre-built cast-tui dist into `.cast-tui/dist/`
 *   2. Copy the host_tui_launcher.py and create the launcher.sh wrapper
 *   3. Write a minimal package.json (without better-sqlite3, which
 *      has a native binding that can't be cross-compiled for the
 *      container)
 *   4. Run `npm install` on the host in `.cast-tui/` and copy the
 *      resolved node_modules into the build context
 *   5. Patch the Dockerfile to install nodejs and COPY the
 *      pre-resolved TUI bundle (dist, node_modules, launcher) into
 *      /opt/cast-tui/, and create the /usr/local/bin/cast-tui
 *      symlink
 *
 * @param agentPath - Path to the agent's directory (Docker build context)
 * @param projectRoot - Root of the agent-cast project (to locate TUI dist)
 */
export async function prepareHostTuiBuildContext(agentPath: string, projectRoot: string): Promise<void> {
  const hostTuiDir = path.join(agentPath, '.cast-tui')
  const hostTuiDistDir = path.join(hostTuiDir, 'dist')

  // Create directory structure
  fs.mkdirSync(hostTuiDistDir, { recursive: true })

  // 1. Copy pre-built TUI dist from project
  const tuiDistSrc = path.join(projectRoot, 'typescript', 'cast-tui', 'dist')
  if (fs.existsSync(tuiDistSrc)) {
    // Remove stale dist if present
    if (fs.existsSync(hostTuiDistDir)) {
      fs.rmSync(hostTuiDistDir, { recursive: true, force: true })
    }
    fs.mkdirSync(hostTuiDistDir, { recursive: true })
    const entries = fs.readdirSync(tuiDistSrc)
    for (const entry of entries) {
      const srcPath = path.join(tuiDistSrc, entry)
      const destPath = path.join(hostTuiDistDir, entry)
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true })
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  } else {
    console.warn('Warning: cast-tui dist not found. Build it first with: npm run build:tui')
    console.warn('On-host TUI will use Python REPL fallback.')
  }

  // 2. Copy launcher script
  const launcherSrc = path.join(projectRoot, 'python', 'cast', 'host_tui_launcher.py')
  if (fs.existsSync(launcherSrc)) {
    fs.copyFileSync(launcherSrc, path.join(hostTuiDir, 'host_tui_launcher.py'))
  }

  // 3. Create launcher.sh wrapper (POSIX shell, for /usr/local/bin/cast-tui)
  const launcherSh = `#!/bin/sh
exec python3 /opt/cast-tui/host_tui_launcher.py "$@"
`
  fs.writeFileSync(path.join(hostTuiDir, 'launcher.sh'), launcherSh)
  fs.chmodSync(path.join(hostTuiDir, 'launcher.sh'), 0o755)

  // 4. Create minimal package.json for the host-side install.
  //
  // We deliberately exclude `better-sqlite3` here even though the
  // TUI imports it: it's a native module and the host binary won't
  // work in the container. The TUI loads it lazily and tolerates
  // a missing module (it returns null from DB lookups in on-host
  // mode where the developer's local DB is irrelevant).
  // The native platform addon (@opentui/core-linux-x64) is required at
  // runtime — the bundle imports it dynamically via
  //   import(`@opentui/core-${platform}-${arch}/index.ts`)
  // We add it as a direct dependency (not optional) so it is installed
  // regardless of the host platform and survives the --omit=optional
  // install below.
  const pkg = {
    name: 'cast-tui-embed',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@opentui/core': '^0.1.0',
      '@opentui/core-linux-x64': '0.1.107',
      // axios is required by the cast-cli A2A client which the TUI
      // dynamically imports at runtime.
      'axios': '^1.6.8',
      'clipboardy': '^4.0.0',
      'simple-git': '^3.36.0',
      'yaml': '^2.4.1',
    },
  }
  const pkgPath = path.join(hostTuiDir, 'package.json')
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

  // 4a. Copy cast-cli A2A client files into the build context so the
  // TUI's dynamic import of `../../../cast-cli/dist/lib/a2a/client.js`
  // resolves inside the container.
  //
  // The TUI (chat.ts / chat.js) imports the A2A client from cast-cli's
  // dist via a relative path that is baked in at build time:
  //   const {A2AClient} = await import('../../../cast-cli/dist/lib/a2a/client.js')
  //
  // From /opt/cast-tui/dist/screens/chat.js this resolves to
  // /opt/cast-cli/dist/lib/a2a/client.js, so we place the files there.
  //
  // We also install the cast-cli deps (tslib, axios) into a separate
  // node_modules so the A2A client can resolve them without depending on
  // the TUI's node_modules.
  const castCliDistDir = path.join(hostTuiDir, 'cast-cli-dist')
  const castCliDistSrc = path.join(projectRoot, 'typescript', 'cast-cli', 'dist', 'lib')
  if (fs.existsSync(castCliDistSrc)) {
    const castCliA2aSrc = path.join(castCliDistSrc, 'a2a')
    const castCliA2aDest = path.join(castCliDistDir, 'lib', 'a2a')
    fs.mkdirSync(castCliA2aDest, { recursive: true })
    for (const file of fs.readdirSync(castCliA2aSrc)) {
      fs.copyFileSync(path.join(castCliA2aSrc, file), path.join(castCliA2aDest, file))
    }

    // Create a minimal package.json for cast-cli deps and install them.
    // This avoids the whack-a-mole of adding cast-cli deps to the TUI's
    // own package.json.
    const castCliPkg = {
      name: 'cast-cli-embed',
      version: '1.0.0',
      private: true,
      dependencies: {
        'tslib': '^2.8.1',
        'axios': '^1.6.8',
      },
    }
    const castCliPkgPath = path.join(castCliDistDir, 'package.json')
    fs.writeFileSync(castCliPkgPath, JSON.stringify(castCliPkg, null, 2))
    try {
      console.log('Installing cast-cli embed dependencies...')
      await execCommand('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: castCliDistDir,
        silent: false,
      })
    } catch (err: any) {
      console.warn(`Warning: Failed to install cast-cli embed deps: ${err.message}`)
    }
  }

  // 4b. Install dependencies on the host and copy the resolved
  // node_modules into the Docker build context. This is more
  // reliable than running `npm install` inside the Docker build
  // because:
  //   - We have working npm + network on the host
  //   - We don't need a build toolchain (gcc, python) inside the
  //     image to compile native modules
  //   - The build is deterministic — the same node_modules ships
  //     every time
  //
  // Note: --force is used because @opentui/core-linux-x64 declares
  // os=linux / cpu=x64 in its package.json and would be rejected by
  // npm when installing from a macOS host. --force bypasses this
  // platform check (the package is never used on the build host, only
  //   inside the Linux container).
  if (fs.existsSync(pkgPath)) {
    try {
      console.log('Installing on-host TUI dependencies (this may take a minute)...')
      const installResult = await execCommand(
        'npm',
        ['install', '--force', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
        { cwd: hostTuiDir, silent: false },
      )
      if (installResult.exitCode !== 0) {
        console.warn('Warning: npm install for on-host TUI failed. The TUI will fall back to the Python REPL.')
        console.warn(installResult.stderr || installResult.stdout)
      }
      // No need to copy node_modules — npm install with cwd: hostTuiDir
      // already writes directly to hostTuiDir/node_modules.
    } catch (err: any) {
      console.warn(`Warning: Failed to install on-host TUI dependencies: ${err.message}`)
      console.warn('The TUI will fall back to the Python REPL.')
    }
  }

  // 5. Patch Dockerfile to install and bundle the TUI
  //
  // The new patch is marked with a specific comment so we can detect
  // the *current* version. Older, incomplete patches (e.g. from earlier
  // abandoned work) used a different comment and are replaced rather
  // than left in place — otherwise the new patch would skip applying
  // and the agent would deploy with a broken on-host TUI.
  //
  // Note: we COPY .cast-tui/node_modules instead of running
  // `npm install` inside the Docker build. The host already installs
  // the deps (with --omit=dev --omit=optional) and copies the
  // resolved node_modules into the build context. This avoids
  // fragile in-build npm installs (network, native compilation,
  // missing apt repos) and makes the build deterministic.
  const dockerfilePath = path.join(agentPath, 'Dockerfile')
  const NEW_MARKER = '# Host TUI bundle (for on-host chat via `cast-tui`)'
  const patch = `
${NEW_MARKER}
RUN apt-get update && apt-get install -y curl unzip && rm -rf /var/lib/apt/lists/* && curl -fsSL https://bun.sh/install | bash && mv /root/.bun/bin/bun /usr/local/bin/bun
COPY .cast-tui/dist /opt/cast-tui/dist
COPY .cast-tui/cast-cli-dist/lib /opt/cast-cli/dist/lib
COPY .cast-tui/cast-cli-dist/node_modules /opt/cast-cli/node_modules
COPY .cast-tui/launcher.sh /opt/cast-tui/launcher.sh
COPY .cast-tui/host_tui_launcher.py /opt/cast-tui/host_tui_launcher.py
COPY .cast-tui/node_modules /opt/cast-tui/node_modules
RUN ln -sf /opt/cast-tui/launcher.sh /usr/local/bin/cast-tui
ENV CAST_TUI_DIR=/opt/cast-tui

`

  if (fs.existsSync(dockerfilePath)) {
    let dockerfile = fs.readFileSync(dockerfilePath, 'utf-8')

    // Strip ALL existing Host TUI bundle content. A "TUI block" is
    // any contiguous run of lines that reference the TUI bundle —
    // by marker comment, by `.cast-tui/...` paths, by
    // `/opt/cast-tui/...` paths, by `CAST_TUI_DIR` env var, or by
    // RUN commands that install /opt/cast-tui (apt-get for nodejs
    // inside the bundle, npm install inside the bundle, ln -sf
    // pointing at the launcher). We detect blocks by walking the
    // file line by line: any line that mentions the TUI bundle
    // (or is a blank/comment line that follows one) gets stripped.
    // Loop until no more blocks are found, because a Dockerfile
    // can have multiple stale blocks from successive deploys.
    const TUI_BUNDLE_PATTERN =
      /(\.cast-tui\/|\/opt\/cast-tui\/|\/opt\/cast-cli\/|CAST_TUI_DIR|Host TUI bundle|apt-get install -y (nodejs|curl unzip)|bun\.sh\/install|npm install.*--no-optional|npm install.*--production|ln -sf \/opt\/cast-tui)/

    function stripBlocks(input: string): string {
      let result = input
      while (true) {
        const lines = result.split('\n')
        const cleaned: string[] = []
        let skippingBlock = false
        let foundBlock = false
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (TUI_BUNDLE_PATTERN.test(line)) {
            skippingBlock = true
            foundBlock = true
            continue
          }
          if (skippingBlock) {
            // Continue skipping blank lines and comments that
            // immediately follow TUI bundle content. Stop at the
            // first real instruction.
            if (line.trim() === '' || line.trim().startsWith('#')) {
              continue
            }
            skippingBlock = false
          }
          cleaned.push(line)
        }
        if (!foundBlock) {
          return result
        }
        result = cleaned.join('\n')
      }
    }

    dockerfile = stripBlocks(dockerfile)

    // Apply the new patch before the CMD line.
    dockerfile = dockerfile.replace(/^CMD /m, `${patch}CMD `)
    fs.writeFileSync(dockerfilePath, dockerfile)
  }

  // 6. Size check — warn if the bundle is unexpectedly large
  let totalSize = 0
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else {
        totalSize += fs.statSync(fullPath).size
      }
    }
  }
  if (fs.existsSync(hostTuiDir)) {
    walkDir(hostTuiDir)
  }
  const sizeMB = totalSize / (1024 * 1024)
  if (sizeMB > EMBED_BUDGET_MB) {
    console.warn(
      `Warning: TUI embed bundle is ${sizeMB.toFixed(1)}MB ` +
      `(budget: ${EMBED_BUDGET_MB}MB). ` +
      `Run 'npm run build:tui:embed' for a smaller bundle.`
    )
  } else {
    console.log(`TUI embed bundle: ${sizeMB.toFixed(1)}MB (budget: ${EMBED_BUDGET_MB}MB)`)
  }
}

export async function execCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; silent?: boolean; input?: string; shell?: boolean; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env || process.env,
      shell: options?.shell ?? true,  // default to true for backwards compatibility
    })
    let stdout = ''
    let stderr = ''
    let killed = false

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

    // Hard wall-clock timeout. Without this, a hung child process
    // (e.g. SSH to an overloaded droplet) would block the caller
    // forever, which is how `waitForDocker` previously appeared
    // "stuck" for 10+ minutes inside a single probe.
    let timeoutHandle: NodeJS.Timeout | undefined
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killed = true
        try {
          // SIGKILL is the only reliable way to stop a stuck child
          // that isn't responding to SIGTERM (which Node sends by
          // default on `proc.kill()`).
          proc.kill('SIGKILL')
        } catch {
          // ignore — process may have exited between the timeout
          // firing and the kill() call
        }
        reject(new Error(`Command "${command}" timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    }

    proc.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      reject(err)
    })
    proc.on('exit', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // If we killed the process via timeout, the timeout's reject
      // has already been called — don't double-resolve.
      if (killed) return
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
