import { execFileSync, spawn } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import crypto from 'crypto'
import YAML from 'yaml'
import { db } from '../sqlite'
import { keychain, type TokenStore } from '../keychain'
import {writeRequirementsTxt} from './requirements'

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

export function readDoctlAccessToken(configPath = path.join(os.homedir(), '.config', 'doctl', 'config.yaml')): string | undefined {
  if (!fs.existsSync(configPath)) return undefined
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) || {}
    if (typeof parsed['access-token'] === 'string' && parsed['access-token']) {
      return parsed['access-token']
    }
    const contexts = parsed['auth-contexts']
    const context = typeof parsed.context === 'string' ? parsed.context : 'default'
    if (contexts && typeof contexts[context] === 'string' && contexts[context]) {
      return contexts[context]
    }
    if (contexts && typeof contexts.default === 'string' && contexts.default) {
      return contexts.default
    }
  } catch {
    return undefined
  }
  return undefined
}

export function resolveDigitalOceanToken(): string | undefined {
  return getProviderToken('digitalocean', [
    'DIGITALOCEAN_ACCESS_TOKEN',
    'DIGITALOCEAN_API_TOKEN',
    'DIGITALOCEAN_API_KEY',
    'DIGITALOCEAN_TOKEN',
  ]) || readDoctlAccessToken()
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

export function deploymentShaFromEnv(): string | undefined {
  const envSha = process.env.CAST_DEPLOYMENT_SHA
  return envSha && isShaPattern(envSha) ? envSha : undefined
}

/**
 * Providers whose live remote is one record per deployment row.
 * The others name a single remote after the agent (`cast-<agent>`), so
 * shutting one row down destroys every row of that provider.
 */
const PER_DEPLOYMENT_REMOTE = new Set(['microvm'])

export interface ShutdownTargetRow {
  id: string
  provider: string
  volume_id?: string | null
  auth_token_hash?: string | null
}

/**
 * Rows a shutdown removes.
 * By agent name, every live row is one target (the caller already rejected
 * distinct provider/URL pairs). By SHA, remove only the remote that destroy
 * actually deletes.
 */
export function deploymentIdsToRemove(
  target: ShutdownTargetRow,
  live: ShutdownTargetRow[],
  bySha: boolean,
): string[] {
  if (!bySha) return live.map(row => row.id)

  if (PER_DEPLOYMENT_REMOTE.has(target.provider)) {
    if (target.volume_id) {
      const matches = live.filter(row => row.provider === target.provider && row.volume_id === target.volume_id)
      if (matches.length > 0) return matches.map(row => row.id)
    }
    return [target.id]
  }

  const sameProvider = live.filter(row => row.provider === target.provider)
  if (sameProvider.length > 0) return sameProvider.map(row => row.id)
  return [target.id]
}

/**
 * Save the bearer token for this deployment.
 * The agent-level keychain entry is only written when nothing else is live,
 * so a second provider does not replace the token the first host still has.
 */
export async function storeAuthToken(
  agentName: string,
  authToken: string,
  deploymentSha?: string,
): Promise<void> {
  const sha = deploymentSha || deploymentShaFromEnv()
  if (sha) await keychain.setDeploymentToken(sha, authToken)
  const others = db.listDeployments(agentName)
  // No SHA means this caller cannot keep the tokens apart. Keep the previous
  // single-entry behavior so the new host is still connectable.
  if (!sha || others.length === 0) await keychain.setToken(agentName, authToken)
}

export async function generateAuthToken(
  agentName: string,
  deploymentSha?: string,
): Promise<{ authToken: string; tokenHash: string }> {
  const authToken = crypto.randomBytes(32).toString('base64')
  const tokenHash = crypto.createHash('sha256').update(authToken).digest('hex')
  await storeAuthToken(agentName, authToken, deploymentSha)
  return { authToken, tokenHash }
}

/**
 * Bearer token for one deployment.
 * A per-SHA keychain entry wins. The agent-level entry is used only when its
 * hash is the one stored on this row, so connect does not send another
 * deployment's token.
 */
export async function resolveDeploymentAuthToken(deployment: {
  id?: string | null
  agent_name: string
  auth_token_hash?: string | null
}): Promise<string | null> {
  if (deployment.id) {
    const bySha = await keychain.getDeploymentToken(deployment.id)
    if (bySha) return bySha
  }
  const byAgent = await keychain.getToken(deployment.agent_name)
  if (!byAgent) return null
  if (!deployment.auth_token_hash) return byAgent
  if (keychain.hashToken(byAgent) === deployment.auth_token_hash) return byAgent
  return null
}

/** Why connect could not load a bearer token. A hash mismatch is the only case that means another deployment owns the agent entry. */
export async function deploymentAuthFailureReason(deployment: {
  agent_name: string
  auth_token_hash?: string | null
}): Promise<'missing' | 'mismatch'> {
  const byAgent = await keychain.getToken(deployment.agent_name)
  if (
    byAgent
    && deployment.auth_token_hash
    && keychain.hashToken(byAgent) !== deployment.auth_token_hash
  ) {
    return 'mismatch'
  }
  return 'missing'
}

export function missingDeploymentAuthMessage(
  deployment: {id?: string | null; agent_name: string; provider?: string | null},
  reason: 'missing' | 'mismatch',
): string {
  const providerFlag = deployment.provider ? ` --provider ${deployment.provider}` : ''
  const lines = [
    `No auth token found for deployment '${deployment.id}' (${deployment.agent_name}).`,
  ]
  if (reason === 'mismatch') {
    lines.push('The keychain token for this agent belongs to a different deployment.')
  }
  lines.push('Redeploy this one:', `  cast deploy ${deployment.agent_name}${providerFlag}`)
  return lines.join('\n')
}

export interface ForgottenDeploymentTokens {
  scope: 'agent' | 'deployment' | 'none'
  stores: TokenStore[]
}

/** A boolean `true` is the older deleteToken result and means the keychain. */
export function storesFromTokenDelete(result: unknown): TokenStore[] {
  if (result === true) return ['keychain']
  if (!result || typeof result !== 'object' || !('stores' in result)) return []
  const stores = (result as {stores?: unknown}).stores
  if (!Array.isArray(stores)) return []
  const found = new Set<TokenStore>()
  for (const store of stores) {
    if (store === 'keychain' || store === 'file') found.add(store)
  }
  return orderedTokenStores(found)
}

export function orderedTokenStores(stores: Iterable<TokenStore>): TokenStore[] {
  const found = stores instanceof Set ? stores : new Set(stores)
  const ordered: TokenStore[] = []
  if (found.has('keychain')) ordered.push('keychain')
  if (found.has('file')) ordered.push('file')
  return ordered
}

function tokenDeleteRemoved(result: unknown): boolean {
  if (typeof result === 'boolean') return result
  if (result && typeof result === 'object' && 'removed' in result) {
    return (result as {removed?: unknown}).removed === true
  }
  return storesFromTokenDelete(result).length > 0
}

function absorbTokenStores(into: Set<TokenStore>, result: unknown): boolean {
  for (const store of storesFromTokenDelete(result)) into.add(store)
  return tokenDeleteRemoved(result)
}

/** Drop stored tokens that belong to the rows just shut down. Leave tokens other live rows still need. */
export async function forgetDeploymentTokens(
  agentName: string,
  removed: ShutdownTargetRow[],
  remaining: ShutdownTargetRow[],
): Promise<ForgottenDeploymentTokens> {
  const stores = new Set<TokenStore>()
  let removedDeploymentToken = false
  for (const row of removed) {
    if (!row.id) continue
    if (absorbTokenStores(stores, await keychain.deleteDeploymentToken(row.id))) {
      removedDeploymentToken = true
    }
  }
  const finish = (scope: ForgottenDeploymentTokens['scope']): ForgottenDeploymentTokens => ({
    scope,
    stores: orderedTokenStores(stores),
  })
  if (remaining.length === 0) {
    absorbTokenStores(stores, await keychain.deleteToken(agentName))
    return finish('agent')
  }
  const agentToken = await keychain.getToken(agentName)
  if (!agentToken) return finish(removedDeploymentToken ? 'deployment' : 'none')
  const hash = keychain.hashToken(agentToken)
  const owns = (row: ShutdownTargetRow) => Boolean(row.auth_token_hash) && row.auth_token_hash === hash
  if (removed.some(owns) && !remaining.some(owns)) {
    absorbTokenStores(stores, await keychain.deleteToken(agentName))
    return finish('agent')
  }
  return finish(removedDeploymentToken ? 'deployment' : 'none')
}

export function ensureDockerfile(agentPath: string): void {
  const dockerfilePath = path.join(agentPath, 'Dockerfile')
  if (!fs.existsSync(dockerfilePath)) {
    // Multi-stage Docker build for smaller image size:
    // - Stage 1 (builder): Compiles any Python packages with C extensions
    // - Stage 2 (runtime): Contains only the installed packages, no build tools
    //
    // Size savings vs single-stage with gcc/git:
    //   gcc: ~250 MB, git: ~60 MB
    const dockerfile = `FROM python:3.11-slim-bookworm AS builder

WORKDIR /build

# Copy requirements and install dependencies
COPY requirements.txt .
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/* \\
    && pip install --no-cache-dir -r requirements.txt

# Runtime stage — no build tools, just Python and installed packages
FROM python:3.11-slim-bookworm

WORKDIR /app

# Copy installed Python packages from builder stage
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy agent files
COPY . /app/agent/

# Set environment variables
ENV CAST_AGENT_PATH=/app/agent
ENV PYTHONPATH=/usr/local

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

const GENERATED_DOCKERFILE_MARKER = 'FROM python:3.11-slim-bookworm AS builder'

/**
 * Image used by DigitalOcean Droplets and MicroVMs.
 * `cast` is copied onto PYTHONPATH. It is not a requirements.txt entry,
 * because pip would look for a different package of that name.
 */
export function castRuntimeDockerfile(): string {
  return `FROM python:3.11-slim-bookworm AS builder

WORKDIR /build

# Copy requirements and install dependencies
COPY requirements.txt .
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/* \\
    && pip install --no-cache-dir -r requirements.txt

# Runtime stage. No build tools, just Python and installed packages.
FROM python:3.11-slim-bookworm

WORKDIR /app

# Copy installed Python packages from the builder stage
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# The Cast package is copied from the build context, not installed from requirements.txt.
COPY .cast-runtime/cast /app/cast

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
}

export function dockerfileCopiesCastPackage(content: string): boolean {
  return /^\s*COPY\s+\.cast-runtime\/cast\s+\/app\/cast(?:\s|$)/m.test(content)
}

export function isGeneratedAgentDockerfile(content: string): boolean {
  return content.includes(GENERATED_DOCKERFILE_MARKER) && content.includes('cast.runtime')
}

/**
 * Write the Droplet and MicroVM Dockerfile, or replace a previously
 * generated file that omitted the Cast package. A custom Dockerfile
 * is left in place.
 */
export function ensureCastRuntimeDockerfile(agentPath: string): void {
  ensureDockerfile(agentPath)
  const dockerfilePath = path.join(agentPath, 'Dockerfile')
  const current = fs.readFileSync(dockerfilePath, 'utf8')
  if (dockerfileCopiesCastPackage(current) && /PYTHONPATH=\/app(?:\s|$)/.test(current)) return
  if (!isGeneratedAgentDockerfile(current)) return
  fs.writeFileSync(dockerfilePath, castRuntimeDockerfile())
}

/** Dockerfile, dockerignore, and requirements for a Droplet or MicroVM image. */
export function prepareCastImageContext(agentPath: string, projectRoot: string): void {
  ensureCastRuntimeDockerfile(agentPath)
  createDockerignore(agentPath)
  writeRequirementsTxt(projectRoot, agentPath)
}

// Budget for the total .cast-tui/ build context (dist + node_modules +
// launcher scripts). 100MB accommodates the full @opentui/core tree
// including its transitive deps (jimp, zod, web-tree-sitter, etc.).
// Bump this if you add new TUI dependencies.
const EMBED_BUDGET_MB = 100

// Pattern that matches any line referencing the on-host TUI bundle.
// Used to strip stale TUI patches from the agent's Dockerfile (e.g. when
// a user re-deploys with --with-tui=false after a prior --with-tui=true
// deploy left a TUI patch in place).
const TUI_BUNDLE_PATTERN =
  /(\.cast-tui\/|\/opt\/cast-tui\/|\/opt\/cast-cli\/|CAST_TUI_DIR|Host TUI bundle|apt-get install -y (nodejs|curl unzip)|bun\.sh\/install|oven-sh\/bun\/releases|npm install.*--no-optional|npm install.*--production|ln -sf \/opt\/cast-tui)/

/**
 * Strip any/all Host TUI bundle content from a Dockerfile string. A
 * "TUI block" is any contiguous run of lines that reference the TUI
 * bundle — by marker comment, by `.cast-tui/...` paths, by
 * `/opt/cast-tui/...` paths, by `CAST_TUI_DIR` env var, or by RUN
 * commands that install /opt/cast-tui (apt-get for curl+unzip inside
 * the bundle, a pinned Bun archive, npm install inside the bundle, ln -sf
 * pointing at the launcher). We detect blocks by walking the file
 * line by line: any line that mentions the TUI bundle (or is a
 * blank/comment line that follows one) gets stripped. Loops until no
 * more blocks are found, because a Dockerfile can have multiple stale
 * blocks from successive deploys.
 */
function stripDockerfileTuiBlocks(input: string): string {
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

/**
 * Options for `prepareHostTuiBuildContext`.
 */
export interface HostTuiBuildContextOptions {
  /**
   * Whether to embed the on-host TUI bundle (cast-tui command) in the
   * agent image. Defaults to `true` to preserve prior behavior; the
   * `cast deploy` command for DigitalOcean passes `false` by default
   * to keep the image small, with `--with-tui` to opt back in.
   */
  enabled: boolean
}

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
 * When `options.enabled === false`, the function is a near no-op: it
 * only strips any existing TUI patch from the agent's Dockerfile (in
 * case a prior deploy was `--with-tui=true`) and logs a skip message.
 *
 * @param agentPath - Path to the agent's directory (Docker build context)
 * @param projectRoot - Root of the castagent project (to locate TUI dist)
 * @param options - { enabled: boolean }. Defaults to { enabled: true }
 *                  for backwards compatibility.
 */
export async function prepareHostTuiBuildContext(
  agentPath: string,
  projectRoot: string,
  options: HostTuiBuildContextOptions = { enabled: true },
): Promise<void> {
  if (!options.enabled) {
    console.log('On-host TUI bundle: skipped (use --with-tui to enable).')
    // If a previous deploy patched the Dockerfile with a TUI bundle,
    // strip it now so the agent deploys with the lean image.
    const dockerfilePath = path.join(agentPath, 'Dockerfile')
    if (fs.existsSync(dockerfilePath)) {
      const original = fs.readFileSync(dockerfilePath, 'utf-8')
      const stripped = stripDockerfileTuiBlocks(original)
      if (stripped !== original) {
        fs.writeFileSync(dockerfilePath, stripped)
        console.log('Stripped existing TUI bundle from Dockerfile.')
      }
    }
    return
  }

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
      'simple-git': '^4.0.2',
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
${pinnedBunRun()}
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

    // Strip ALL existing Host TUI bundle content (see
    // stripDockerfileTuiBlocks above for the full rationale).
    dockerfile = stripDockerfileTuiBlocks(dockerfile)

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
      // argv is passed through as-is. shell:true would join it into sh -c
      // and interpret quotes, backticks, and $() inside secret values.
      shell: options?.shell ?? false,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

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
      // A failed ssh can close stdin before the write finishes (EPIPE).
      // The process error and exit handlers report that failure.
      proc.stdin.on('error', () => {})
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
        if (settled) return
        settled = true
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

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (settled) return
      settled = true
      // A missing binary used to come back as sh's exit 127 because
      // shell defaulted to true. Keep that result so callers that only
      // check exitCode still see "command not found".
      if (err.code === 'ENOENT') {
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: 127,
        })
        return
      }
      reject(err)
    })
    proc.on('exit', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // If we killed the process via timeout, the timeout's reject
      // has already been called — don't double-resolve.
      if (killed || settled) return
      settled = true
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
  const envSha = deploymentShaFromEnv()
  if (envSha) {
    db.createDeployment(envSha, agentName, provider, url, tokenHash, volumeId, volumeConfig, deployedVersion)
    return envSha
  }
  // Otherwise, let db.setDeployment auto-generate SHA
  db.setDeployment(agentName, provider, url, tokenHash, volumeId, volumeConfig)
  // Return the SHA that was generated (query the most recent deployment)
  const deployment = db.getActiveDeployment(agentName)
  return deployment?.id || ''
}

export interface InferenceCatalogEntry {
  key: string
  name: string
  default: boolean
  prefixes: string[]
  envVar: string
  configKey: string
  baseUrl: string
  acceptsAnyModel: boolean
}

export interface InstallPin {
  name: string
  version: string
  target: string
  sha256: string
}

/** Pins published in install-checksums.txt next to the installer. */
export function readInstallPins(root = findCastRoot()): InstallPin[] {
  const file = path.join(root, 'install-checksums.txt')
  const pins: InstallPin[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [name, version, target, sha256] = trimmed.split(/\s+/)
    if (!name || !version || !target || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Invalid install pin: ${trimmed}`)
    }
    pins.push({name, version, target, sha256})
  }
  return pins
}

export function installPin(name: string, target: string, root = findCastRoot()): InstallPin {
  const pin = readInstallPins(root).find(item => item.name === name && item.target === target)
  if (!pin) {
    throw new Error(`No pinned checksum for ${name} ${target}`)
  }
  return pin
}

function pinnedBunRun(): string {
  const x64 = installPin('bun', 'linux-x64')
  const arm64 = installPin('bun', 'linux-arm64')
  if (x64.version !== arm64.version) {
    throw new Error('Bun linux pins must share a version')
  }
  return 'RUN apt-get update && apt-get install -y curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*'
    + ' && arch="$(dpkg --print-architecture)"'
    + ` && case "$arch" in amd64) bun_sha='${x64.sha256}'; bun_name='bun-linux-x64' ;; arm64) bun_sha='${arm64.sha256}'; bun_name='bun-linux-aarch64' ;; *) echo "unsupported bun architecture: $arch" >&2; exit 1 ;; esac`
    + ` && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${x64.version}/$bun_name.zip"`
    + ' && echo "$bun_sha  /tmp/bun.zip" | sha256sum -c -'
    + ' && unzip -q /tmp/bun.zip -d /tmp/bun-extract'
    + ' && install -m 0755 /tmp/bun-extract/$bun_name/bun /usr/local/bin/bun'
    + ' && rm -rf /tmp/bun-extract /tmp/bun.zip'
}

function findCastRoot(): string {
  const markers = ['python/cast/providers/manifest.json', 'typescript/cast-cli']
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
  ]
  for (const candidate of candidates) {
    if (markers.every(marker => fs.existsSync(path.join(candidate, marker)))) {
      return candidate
    }
  }
  return process.cwd()
}

function castPython(): {command: string; env: NodeJS.ProcessEnv} {
  const pythonDir = path.join(findCastRoot(), 'python')
  const venvPython = path.join(pythonDir, '.venv', 'bin', 'python3')
  let command = process.platform === 'win32' ? 'python' : 'python3'
  if (fs.existsSync(venvPython)) command = venvPython
  const env = {...process.env}
  env.PYTHONPATH = env.PYTHONPATH ? `${pythonDir}${path.delimiter}${env.PYTHONPATH}` : pythonDir
  return {command, env}
}

export function loadInferenceCatalog(): InferenceCatalogEntry[] {
  const {command, env} = castPython()
  const stdout = execFileSync(command, ['-m', 'cast.providers.catalog'], {
    encoding: 'utf8',
    env,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    throw new Error('cast.providers.catalog did not print a JSON array')
  }
  return parsed
}

function configValue(config: any, dotted: string | undefined): string | undefined {
  if (!dotted) return undefined
  let current = config
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = current[part]
  }
  if (typeof current !== 'string' || current.length === 0) return undefined
  return current
}

// Env first, then configKey. Omits pairs with no value.
// Does not read providers.digitalocean.token; that key is not in the catalog.
export function inferenceEnv(config: any = loadConfig()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of loadInferenceCatalog()) {
    if (!entry.envVar) continue
    const fromEnv = process.env[entry.envVar]
    const value = fromEnv || configValue(config, entry.configKey)
    if (value) out[entry.envVar] = value
  }
  return out
}

export function inferenceModelStatus(model: string): {
  valid: boolean
  warning?: string
  error?: string
  provider?: string
} {
  const {command, env} = castPython()
  const stdout = execFileSync(command, [
    '-c',
    'import json,sys\nfrom cast.providers.registry import model_status\njson.dump(model_status(sys.argv[1]), sys.stdout)\n',
    model,
  ], {encoding: 'utf8', env})
  const parsed = JSON.parse(stdout) as {
    valid?: boolean
    warning?: string | null
    error?: string | null
    provider?: string
  }
  const result: {valid: boolean; warning?: string; error?: string; provider?: string} = {
    valid: parsed.valid !== false && !parsed.error,
  }
  if (typeof parsed.provider === 'string' && parsed.provider) result.provider = parsed.provider
  if (typeof parsed.warning === 'string' && parsed.warning) result.warning = parsed.warning
  if (typeof parsed.error === 'string' && parsed.error) result.error = parsed.error
  if (result.warning || result.error) result.valid = false
  return result
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

/** Lazy require: the registry imports this module while it is still loading. */
function loadDeploymentRegistry(): typeof import('./registry') {
  return require('./registry')
}

export function getMemoryMountPath(provider: string): string {
  const registered = loadDeploymentRegistry().getDeploymentProvider(provider)
  if (registered?.memory && typeof registered.memory.mountPath === 'string') {
    return registered.memory.mountPath
  }
  return '/app/agent/memory'
}

export async function createMemoryVolume(
  provider: string,
  agentName: string,
  deploymentId: string,
): Promise<VolumeConfig> {
  const volumeId = getVolumeName(agentName, deploymentId)
  const mountPath = getMemoryMountPath(provider)
  const registered = loadDeploymentRegistry().getDeploymentProvider(provider)
  if (!registered?.memory?.create) {
    throw new Error(`Unsupported provider for memory volume: ${provider}`)
  }
  await registered.memory.create({agentName, deploymentId, volumeId, mountPath})
  return { volumeId, mountPath, provider }
}

export async function deleteMemoryVolume(volumeConfig: VolumeConfig, agentName: string): Promise<void> {
  const { provider, volumeId, mountPath } = volumeConfig
  const registered = loadDeploymentRegistry().getDeploymentProvider(provider)
  if (!registered?.memory?.delete) return
  await registered.memory.delete({
    agentName,
    deploymentId: '',
    volumeId,
    mountPath,
  })
}

/**
 * Creates a comprehensive .dockerignore file in the agent directory to
 * exclude non-runtime files from the Docker build context. This
 * significantly reduces image size by excluding .git, archives,
 * __pycache__, logs, .env files, and other build artifacts.
 *
 * Note: .cast-runtime/ is deliberately NOT excluded — it contains
 * the runtime needed at runtime.
 */
export function createDockerignore(agentPath: string): void {
  const content = `.git
.gitignore
*.tar
*.tar.gz
*.zip
__pycache__/
*.py[cod]
*.pyc
.DS_Store
.AppleDouble
.LSOverride
*.log
.env
.env.*
cast.db
cast.db-*
.cast/
.castignore
.cloud-init.yml
.dockerignore
`
  fs.writeFileSync(path.join(agentPath, '.dockerignore'), content)
}
