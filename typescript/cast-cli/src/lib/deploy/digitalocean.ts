import {Args, Command, Flags} from '@oclif/core'
import {execSync, spawn} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import axios from 'axios'
import {
  generateAuthToken,
  ensureDockerfile,
  getAgentPath,
  saveDeployment,
  inferenceEnv,
  getProviderToken,
  execCommand,
  execCommandIgnoreError,
  generateDeploymentId,
  getVolumeName,
  prepareHostTuiBuildContext,
  createDockerignore,
} from './deploy-utils'
import {buildCloudInitBaselineMotd, buildHostMotd, writeHostMotdOverSsh} from './motd'
import type {MotdContext} from './motd'
import {db} from '../sqlite'

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

// Execute SSH command with shell: false to prevent shell from interfering with options.
// A 30s default timeout is applied so a hung SSH probe can't block
// callers (notably `waitForDocker`'s retry loop) for many minutes.
async function execSsh(
  ip: string,
  remoteCmd: string,
  silent = false,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execCommand('ssh', buildSshArgs(ip, remoteCmd), { silent, shell: false, timeoutMs })
}

export default class DigitalOceanDeploy extends Command {
  static description = 'Deploy agent to DigitalOcean Droplet with Docker'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    'with-tui': Flags.boolean({
      description:
        'Bundle the on-host TUI (cast-tui command) into the image. ' +
        'Off by default to keep images small and streaming fast; ' +
        'pass --with-tui if you want SSH-in chat via `cast-tui`.',
      default: false,
    }),
    size: Flags.string({
      description:
        'Droplet size slug. Default: s-2vcpu-2gb (bumped from s-1vcpu-1gb ' +
        'to give `docker load` more CPU headroom). Only affects new droplets; ' +
        'existing droplets keep their original size.',
      default: 's-2vcpu-2gb',
    }),
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

    // Clean up volume
    const volumeId = getVolumeName(agentName, 'latest')
    try {
      await execCommand('doctl', ['compute', 'volume', 'delete', volumeId, '--force'], {silent: true})
      console.log(`Memory volume '${volumeId}' has been removed.`)
    } catch {
      console.log(`Note: Memory volume '${volumeId}' could not be removed.`)
    }
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DigitalOceanDeploy)
    const agentName = args.agent as string
    const withTui = flags['with-tui'] as boolean
    const dropletSize = flags.size as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to DigitalOcean Droplet...`)
    this.log(`On-host TUI: ${withTui ? 'enabled (--with-tui)' : 'disabled (use --with-tui to enable)'}`)
    this.log(`Droplet size: ${dropletSize}${dropletSize === 's-1vcpu-1gb' ? ' (note: smaller than the new default — docker load may time out)' : ''}`)

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
    createDockerignore(agentPath)

    // Resolve project root for locating cast runtime
    const projectRoot = this.findProjectRoot()

    // Copy the cast runtime into the agent's .cast-runtime/ directory
    // This is required for the Dockerfile's COPY .cast-runtime/cast step
    const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
    fs.mkdirSync(path.dirname(castRuntimeDir), { recursive: true })
    const castRuntimeSrc = path.join(projectRoot, 'python', 'cast')
    if (fs.existsSync(castRuntimeSrc)) {
      if (fs.existsSync(castRuntimeDir)) {
        fs.rmSync(castRuntimeDir, { recursive: true })
      }
      fs.cpSync(castRuntimeSrc, castRuntimeDir, { recursive: true })
    }

    // Generate auth token and deployment ID
    const { authToken, tokenHash } = await generateAuthToken(agentName)
    const deploymentId = generateDeploymentId()
    const volumeId = getVolumeName(agentName, deploymentId)

    // Get DO token
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      this.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Setup SSH key
    await this.ensureSshKey()

    // Prepare on-host TUI bundle (cast-tui command inside the container).
    // Skipped entirely when --with-tui is not set, which keeps the image
    // ~100MB smaller and substantially reduces streaming time.
    if (withTui) {
      this.log('Preparing on-host TUI bundle...')
    }
    await prepareHostTuiBuildContext(agentPath, projectRoot, { enabled: withTui })

    // Get or create droplet
    const droplet = await this.getOrCreateDroplet(agentName, agentPath, apiToken, dropletSize)

    this.log(`Droplet IP: ${droplet.ip}`)
    this.log('Waiting for SSH to be available...')
    await this.waitForSsh(droplet.ip)

    // Cloud-init's runcmd (which installs Docker) runs asynchronously and
    // SSH comes up before that completes. If we try to `docker load` over
    // SSH right after `waitForSsh`, we'll hit "docker: command not found"
    // on fresh droplets. Poll for a working Docker daemon before
    // streaming the image.
    this.log('Waiting for Docker to be ready on droplet...')
    await this.waitForDocker(droplet.ip)

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

    // Stream image directly to droplet (no intermediate disk write)
    this.log('Streaming Docker image to droplet...')
    await this.streamImageToDroplet(droplet.ip, imageTag)

    // Deploy on droplet
    this.log('Deploying on droplet...')
    const deploymentUrl = `http://${droplet.ip}:8080`

    // Look up the current agent release version so the SSH login MOTD
    // shows the semantic version (e.g. v1.2.3) instead of a placeholder.
    let deployedVersion: string | undefined
    try {
      const currentRelease = db.getCurrentRelease(agentName)
      if (currentRelease?.version) {
        deployedVersion = String(currentRelease.version)
      }
    } catch {
      // DB unavailable — MOTD will fall back to a placeholder
    }

    await this.deployOnDroplet(droplet.ip, agentName, authToken, imageTag, volumeId, deploymentUrl, deployedVersion, withTui)

    // Create and attach volume
    this.log(`Creating memory volume: ${volumeId}`)
    const volumeResult = await this.createAndAttachVolume(apiToken, droplet.id, volumeId, droplet.region)
    if (volumeResult) {
      this.log(`Volume attached at ${volumeResult}`)
    }

    // Save deployment
    const volumeConfig = JSON.stringify({ deploymentId, mountPath: '/app/agent/memory', region: droplet.region })
    saveDeployment(agentName, 'digitalocean', deploymentUrl, tokenHash, volumeId, volumeConfig)

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
    this.log('To connect (from your machine):')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    if (withTui) {
      // TUI is bundled — show the on-host chat path.
      this.log('To chat on-host (SSH into droplet, then inside container):')
      this.log(`  ssh -i ~/.ssh/cast_do_key root@${droplet.ip}`)
      this.log(`  docker exec -it cast-agent bash`)
      this.log(`  cast-tui`)
      this.log('')
    } else {
      // TUI is not bundled — only the A2A API is available for
      // talking to the agent. The MOTD on the droplet says the
      // same.
      this.log(`Talk to this agent via the A2A API at: ${deploymentUrl}`)
      this.log('')
    }
    this.log('To destroy:')
    this.log(`  cast shutdown ${agentName}`)
  }

  /**
   * Find the project root directory by looking for known marker paths.
   * Tries several relative paths from the current working directory and
   * the compiled output directory to locate the castagent project root.
   */
  private findProjectRoot(): string {
    const markers = ['python/cast', 'typescript/cast-tui']
    const candidates = [
      process.cwd(),
      // __dirname at runtime: typescript/cast-cli/dist/lib/deploy/
      path.resolve(__dirname, '..'),             // dist/lib
      path.resolve(__dirname, '../..'),           // dist
      path.resolve(__dirname, '../../..'),        // cast-cli
      path.resolve(__dirname, '../../../..'),     // typescript
      path.resolve(__dirname, '../../../../..'),  // project root
    ]
    for (const candidate of candidates) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(candidate, marker))) {
          return candidate
        }
      }
    }
    return process.cwd()
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

  private async getOrCreateDroplet(agentName: string, agentPath: string, apiToken?: string, size: string = 's-2vcpu-2gb'): Promise<{id: string; name: string; ip: string; region: string}> {
    const dropletName = `cast-${agentName}`
    const region = 'nyc3'

    // Check if droplet exists
    const listResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = listResult.stdout.trim().split('\n')

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3 && parts[1] === dropletName) {
        return {id: parts[0], name: dropletName, ip: parts[2], region}
      }
    }

    // Create droplet with cloud-init
    this.log(`Creating droplet '${dropletName}'...`)

    // Get SSH key fingerprint (MD5 format required by DO API)
    const keyResult = await execCommand('ssh-keygen', ['-l', '-E', 'md5', '-f', `${SSH_KEY_PATH}.pub`], {silent: true})
    const fingerprint = keyResult.stdout.trim().split(/\s+/)[1].replace(/^MD5:/, '')

    // Write cloud-init to install Docker and seed a baseline MOTD.
    //
    // IMPORTANT: this cloud-init goes through DigitalOcean's user-data
    // pipeline, which is then validated by cloud-init's STRICT schema
    // validator. Anything that parses as YAML but doesn't match the
    // schema gets rejected with `SCHEMA_ERROR: part-001` and runcmd
    // silently never runs. We keep the cloud-config minimal:
    //   - write_files only (no in-yaml block scalars with shell logic)
    //   - runcmd is a flat list of single-line strings
    //   - no comments between runcmd items (those have tripped the
    //     schema validator in past iterations)
    // The install script itself is written to disk by write_files and
    // invoked from runcmd — this also makes it inspectable in
    // /var/log/cast-docker-install.log after the fact.
    const cloudInitPath = path.join(agentPath, '.cloud-init.yml')
    const baselineMotd = buildCloudInitBaselineMotd()

    // Install script: tries the official Docker apt repo first
    // (more reliable than get.docker.com which has been observed to
    // fail silently on some DO regions), then falls back to
    // get.docker.com. All output is logged. The script is
    // intentionally tolerant — it always exits 0 so cloud-init
    // continues to the sentinel touch below.
    const installScript = [
      '#!/bin/bash',
      'set +e',
      'LOG=/var/log/cast-docker-install.log',
      'echo "[cast] docker install started at $(date -Iseconds)" > $LOG',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update >> $LOG 2>&1',
      'apt-get install -y ca-certificates curl >> $LOG 2>&1',
      'install -m 0755 -d /etc/apt/keyrings >> $LOG 2>&1',
      'if curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc >> $LOG 2>&1; then',
      '  chmod a+r /etc/apt/keyrings/docker.asc >> $LOG 2>&1',
      '  ARCH=$(dpkg --print-architecture)',
      '  CODENAME=$(. /etc/os-release && echo $VERSION_CODENAME)',
      '  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" > /etc/apt/sources.list.d/docker.list',
      '  apt-get update >> $LOG 2>&1',
      '  apt-get install -y docker-ce docker-ce-cli containerd.io >> $LOG 2>&1',
      'else',
      '  echo "[cast] apt-repo fetch failed, falling back to get.docker.com" >> $LOG',
      '  curl -fsSL https://get.docker.com | sh >> $LOG 2>&1',
      'fi',
      'if command -v docker >/dev/null 2>&1; then',
      '  systemctl enable docker >> $LOG 2>&1',
      '  systemctl start docker >> $LOG 2>&1',
      '  echo "[cast] docker install finished: $(docker --version 2>&1)" >> $LOG',
      'else',
      '  echo "[cast] FAILED: docker not on PATH after install" >> $LOG',
      'fi',
      'exit 0',
      '',
    ].join('\n')

    // Indent every line of the MOTD and install script by 10 spaces
    // (matches the YAML block scalar indent under `content: |`).
    const motdIndented = baselineMotd
      .split('\n')
      .map((line) => line.length > 0 ? '          ' + line : '')
      .join('\n')
    const scriptIndented = installScript
      .split('\n')
      .map((line) => '          ' + line)
      .join('\n')

    // Build the cloud-init YAML. Keep the runcmd list as a flat list
    // of single-line strings — no inline block scalars, no comments
    // between items. cloud-init's strict schema validator has
    // rejected previous versions that used those constructs.
    const cloudInit = [
      '#cloud-config',
      'write_files:',
      '  - path: /etc/motd',
      '    permissions: "0644"',
      '    owner: root',
      '    group: root',
      '    content: |',
      motdIndented,
      '  - path: /etc/profile.d/cast.sh',
      '    permissions: "0755"',
      '    owner: root',
      '    group: root',
      '    content: |',
      '      #!/bin/bash',
      '      : # cast placeholder',
      '  - path: /usr/local/bin/cast-install-docker.sh',
      '    permissions: "0755"',
      '    owner: root',
      '    group: root',
      '    content: |',
      scriptIndented,
      'runcmd:',
      '  - /usr/local/bin/cast-install-docker.sh',
      '  - mkdir -p /var/lib/cast',
      '  - touch /var/lib/cast/docker-ready',
      '',
    ].join('\n')
    fs.writeFileSync(cloudInitPath, cloudInit)

    const createResult = await execCommand('doctl', [
      'compute', 'droplet', 'create',
      dropletName,
      '--region', region,
      '--size', size,
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

    return {id: parts[0], name: dropletName, ip: parts[1], region}
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

  /**
   * Wait until Docker is installed AND the daemon is responsive on the
   * droplet.
   *
   * Two signal sources are checked:
   *   1. Sentinel file at `/var/lib/cast/docker-ready`. New droplets
   *      write this in the LAST line of cloud-init's runcmd, so its
   *      presence means the install completed (successfully or not —
   *      see step 2 for the success check).
   *   2. `docker info`. Confirms the daemon is actually responsive.
   *      Required because `docker load` / `docker run` need the
   *      daemon, not just the CLI on PATH.
   *
   * For older droplets that pre-date the sentinel, the function falls
   * back to polling `docker info` directly, so it remains compatible.
   *
   * Background: cloud-init's `runcmd` runs asynchronously and the SSH
   * server comes up before it finishes. The very first deploy flow
   * only waited for SSH, so the first `docker load` over SSH would
   * fail with "bash: line 1: docker: command not found" (exit 127).
   */
  private async waitForDocker(ip: string): Promise<void> {
    const maxAttempts = 60    // 60 × 5s = 5 min between *attempts* (not wall-clock)
    const delayMs = 5000
    // 15s per-call SSH timeout — tight enough that a hung probe
    // can't make a single iteration last minutes. The cloud-init
    // install itself can run for several minutes, so the loop needs
    // many attempts; we just need each one to fail fast.
    const sshTimeoutMs = 15_000

    for (let i = 0; i < maxAttempts; i++) {
      // Heartbeat every ~30s so the user can see the loop is alive.
      // This is what the deploy log was missing before — without
      // it, a user can't tell "stuck" from "polling slowly".
      if (i > 0 && i % 6 === 0) {
        const elapsedSec = i * delayMs / 1000
        this.log(`  ...still waiting (${elapsedSec}s elapsed)`)
      }

      // Probe the sentinel written by cloud-init's last runcmd step.
      // If it exists, install is fully done and we just need to wait
      // for the daemon. If it doesn't, either install is still
      // running OR this is an older droplet without the sentinel —
      // either way, `docker info` is the source of truth.
      let sentinelExists = false
      try {
        const sentinel = await execSsh(ip, 'test -f /var/lib/cast/docker-ready', true, sshTimeoutMs)
        sentinelExists = sentinel.exitCode === 0
      } catch {
        // ignore — transient SSH error or timeout, retry next iteration
      }

      try {
        const info = await execSsh(ip, 'docker info >/dev/null 2>&1', true, sshTimeoutMs)
        if (info.exitCode === 0) {
          return
        }
        // Otherwise fall through and keep polling. If sentinelExists
        // is true the daemon is just slow to come up; if false, the
        // install is probably still in progress.
      } catch {
        // ignore
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    // Timed out — gather diagnostics from the droplet so the user has
    // something actionable in the error message. Use a longer
    // per-call timeout here so the diagnostic collection itself
    // doesn't time out on a sluggish SSH connection.
    const diagnostics = await this.collectDropletDiagnostics(ip)

    throw new Error(
      'Timed out waiting for Docker to become ready on droplet. ' +
      diagnostics +
      ' SSH in and run `journalctl -u cloud-init-main --no-pager` for full logs.',
    )
  }

  /**
   * Best-effort collection of cloud-init / docker state from the
   * droplet for inclusion in a timeout error message. Never throws.
   */
  private async collectDropletDiagnostics(ip: string): Promise<string> {
    const parts: string[] = []

    const probe = async (label: string, cmd: string): Promise<void> => {
      try {
        const r = await execSsh(ip, cmd, true)
        const out = (r.stdout || r.stderr || '').trim()
        if (out) {
          parts.push(`${label}: ${out.split('\n').slice(0, 5).join(' | ')}`)
        }
      } catch {
        // ignore
      }
    }

    await probe('cloud-init', 'cloud-init status 2>&1')
    await probe('sentinel', 'ls -la /var/lib/cast/docker-ready 2>&1')
    await probe('docker', 'docker info 2>&1 | head -20')

    return parts.length > 0 ? parts.join('; ') + '.' : ''
  }

  private async deployOnDroplet(
    ip: string,
    agentName: string,
    authToken: string,
    imageTag: string,
    volumeId: string,
    deploymentUrl: string,
    deployedVersion?: string,
    withTui: boolean = false,
  ): Promise<void> {
    // Image is already loaded via streamImageToDroplet; stop old container
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

    for (const [key, value] of Object.entries(inferenceEnv())) {
      envArgs.push(`-e ${key}=${value}`)
    }

    // Build the host MOTD. We pass it base64-encoded so it can be safely
    // embedded in shell commands without escaping concerns. It's written
    // to BOTH the host (for SSH login banners) AND the container (as
    // CAST_MOTD, so the on-host TUI can display the same content in
    // its first chat message).
    //
    // onHostTui is the source of truth for whether the MOTD mentions
    // `cast-tui` — when false (the default), the banner points users
    // at the A2A URL only, since the TUI command isn't in the
    // container and we'd be telling them to run something that
    // doesn't exist.
    const motdCtx: MotdContext = {
      agentName,
      dropletIp: ip,
      a2aUrl: deploymentUrl,
      deployedVersion,
      onHostTui: withTui,
    }
    const hostMotd = buildHostMotd(motdCtx)
    const motdB64 = Buffer.from(hostMotd, 'utf8').toString('base64')

    // Inject the env var so the container can pick it up
    envArgs.push(`-e CAST_MOTD=${motdB64}`)

    // Run container with volume mount
    const runResult = await execSsh(ip, `docker run -d --name cast-agent --restart unless-stopped -p 8080:8080 -v /mnt/${volumeId}:/app/agent/memory ${envArgs.join(' ')} ${imageTag}`, true)

    if (runResult.exitCode !== 0) {
      throw new Error(`Failed to start container on droplet: ${runResult.stderr}`)
    }

    // Write the host MOTD and login-shell snippet. This is independent
    // of the container — the files live on the host and are shown by
    // pam_motd (and sourced by login shells) on every subsequent SSH.
    const {motdStderr, profileStderr} = await writeHostMotdOverSsh(ip, motdCtx)
    if (motdStderr) {
      this.warn(`Failed to write /etc/motd on droplet: ${motdStderr}`)
    }
    if (profileStderr) {
      this.warn(`Failed to write /etc/profile.d/cast.sh on droplet: ${profileStderr}`)
    }

  }

  /**
   * Stream a Docker image directly to the droplet via SSH pipe,
   * avoiding any intermediate disk write on the local machine.
   *
   * Runs: docker save <imageTag> | gzip -6 | ssh <options> root@<ip> 'gunzip | docker load'
   *
   * The gzip wrapper is the key throughput win. `docker save` emits
   * an uncompressed tar, so a 400MB compressed image becomes a
   * ~1.2-1.5GB on-the-wire tar. Compressing in the middle:
   *   1. Shifts the CPU cost of decompression from the 1-vCPU
   *      droplet (s-1vcpu-1gb / s-2vcpu-2gb) to the build host
   *      (a multi-core Mac/Linux laptop), which is much faster.
   *   2. Cuts network payload to roughly ⅓ of the raw tar size.
   *   3. Reduces disk I/O on both ends (less to write to overlay2
   *      on the droplet, less to read from /var/lib/docker on
   *      the host).
   *
   * Safeguards (matching every other SSH call in this file):
   *   - SSH keepalive (`ServerAliveInterval=5`, `ServerAliveCountMax=1`)
   *     so a half-open TCP connection eventually exits instead of
   *     hanging the deploy forever.
   *   - Wall-clock timeout (default 15 min) that SIGKILLs all three
   *     children. Mirrors the pattern in `execCommand` in
   *     deploy-utils.ts.
   *   - `save.on('close')` / `gzip.on('close')` handlers: if either
   *     upstream child exits non-zero, error out immediately rather
   *     than waiting for `docker load` to time out waiting for bytes
   *     that will never come.
   *   - Pipe error handlers on every writable side so EPIPE is not
   *     silently swallowed.
   *   - Progress logging every ~10 MB of *compressed* bytes so
   *     future hangs are diagnosable from the deploy log alone
   *     (you can see "stuck at N MB after T minutes").
   *
   * @param ip - The droplet's public IPv4 address.
   * @param imageTag - The local Docker image tag to stream.
   * @param timeoutMs - Wall-clock timeout in ms (default 900_000 = 15 min).
   */
  private async streamImageToDroplet(
    ip: string,
    imageTag: string,
    timeoutMs = 900_000,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Reuse the shared SSH base options so the streaming SSH gets
      // ServerAliveInterval / ServerAliveCountMax / ConnectTimeout / etc.
      // exactly like every other SSH call in this file. Without
      // keepalive, a half-open TCP connection (e.g. NAT timeout, droplet
      // suspend) would make this hang indefinitely — which is the bug
      // that motivated this rewrite.
      //
      // The remote command is `gunzip | docker load` so the
      // receiving end (the droplet's docker daemon) doesn't have to
      // decompress layers — that's gzip's job, which now runs on
      // the build host. `gunzip` is provided by the `gzip` package,
      // which is a hard dep of `apt` on Ubuntu and present in the
      // base image.
      const sshArgs = [...getSshBaseOptions(), `root@${ip}`, 'gunzip | docker load']

      const save = spawn('docker', ['save', imageTag], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      // `-6` is a good speed/ratio balance for layer content
      // (mostly already-compressible JSON and binary blobs).
      const gzip = spawn('gzip', ['-6', '-c'], {
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      const load = spawn('ssh', sshArgs, {
        stdio: ['pipe', 'inherit', 'inherit'],
      })

      save.stdout.pipe(gzip.stdin)
      gzip.stdout.pipe(load.stdin)

      let done = false
      let timeoutHandle: NodeJS.Timeout | undefined

      const finish = (err?: Error) => {
        if (done) return
        done = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        // SIGKILL is the only reliable way to stop children that are
        // blocked on I/O (a stuck `ssh` won't respond to SIGTERM).
        // Wrap in try/catch — the process may have exited between
        // the timeout firing and the kill() call.
        try { save.kill('SIGKILL') } catch { /* may already be dead */ }
        try { gzip.kill('SIGKILL') } catch { /* may already be dead */ }
        try { load.kill('SIGKILL') } catch { /* may already be dead */ }
        if (err) reject(err)
        else resolve()
      }

      // Hard wall-clock timeout. Bumped from 10 to 15 min to give
      // first-deploy headroom (the first deploy is the slowest since
      // the droplet's overlay2 cache is cold). With gzip in place,
      // typical deploys finish in 1-2 min.
      timeoutHandle = setTimeout(() => {
        finish(new Error(`Image streaming timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      // EPIPE on any writable side must not be silently swallowed.
      // `docker load` dying mid-stream → EPIPE on load.stdin
      // `gzip` dying mid-stream → EPIPE on gzip.stdin
      // The close handlers will report the real exit codes.
      load.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          finish(err)
        }
      })
      gzip.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          finish(err)
        }
      })
      save.stdout.on('error', (err) => finish(err))
      gzip.stdout.on('error', (err) => finish(err))

      // Progress logging — every ~10 MB of *compressed* bytes, log
      // how much has been streamed to the droplet. Reading from
      // gzip.stdout (not save.stdout) gives us the network-visible
      // throughput, which is what we care about for hang diagnosis
      // (not the uncompressed docker-save rate).
      let bytes = 0
      let lastLoggedMb = 0
      gzip.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        const mb = Math.floor(bytes / (10 * 1024 * 1024))
        if (mb > lastLoggedMb) {
          lastLoggedMb = mb
          this.log(`Streamed ${mb * 10} MB (compressed) to droplet...`)
        }
      })

      // Track exit codes from all three children. We need all three
      // to close before we can declare success — but if any fails,
      // we should error out as soon as we know.
      let saveCode: number | null = null
      let gzipCode: number | null = null
      let loadCode: number | null = null

      const tryFinishFromCodes = (): void => {
        if (saveCode === null || gzipCode === null || loadCode === null) return
        if (saveCode === 0 && gzipCode === 0 && loadCode === 0) {
          finish()
        } else {
          finish(new Error(
            `Image streaming failed: docker save exited ${saveCode}, ` +
            `gzip exited ${gzipCode}, docker load (ssh) exited ${loadCode}`,
          ))
        }
      }

      // `docker save` exiting early is a failure mode the original
      // code missed: if save dies but load is still running, we'd
      // wait for load's close event with no way to know save had
      // failed.
      save.on('close', (code) => {
        saveCode = code ?? 0
        // If save died non-zero, error out immediately — don't wait
        // for load, which may be blocked on a read for bytes that
        // will never arrive.
        if (saveCode !== 0) {
          finish(new Error(`docker save exited with code ${saveCode}`))
          return
        }
        // Save exited cleanly — end gzip.stdin so gzip gets EOF and
        // can flush its final compressed bytes to load.
        if (gzip.exitCode === null && gzip.killed === false) {
          try { gzip.stdin.end() } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      // gzip exiting: if it dies (e.g. SIGPIPE because load closed
      // early), the pipeline is broken. Treat non-zero as fatal.
      gzip.on('close', (code) => {
        gzipCode = code ?? 0
        if (gzipCode !== 0) {
          finish(new Error(`gzip exited with code ${gzipCode}`))
          return
        }
        // gzip exited cleanly — end load.stdin so load gets EOF
        // and can finish consuming whatever's already in the pipe.
        if (load.exitCode === null && load.killed === false) {
          try { load.stdin.end() } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      load.on('close', (code) => {
        loadCode = code ?? 0
        // Symmetric: if load dies first, unpipe save.stdout so save
        // and gzip can exit cleanly instead of getting EPIPE.
        if (save.exitCode === null && save.killed === false) {
          try { save.stdout.unpipe(gzip.stdin) } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      save.on('error', (err) => {
        // If save fails before it's written any data, gzip and load
        // will be waiting for input that never arrives. Make sure
        // they get EOF on stdin so they don't hang on a read.
        try { gzip.stdin.end() } catch { /* ignore */ }
        try { load.stdin.end() } catch { /* ignore */ }
        finish(err)
      })
      gzip.on('error', (err) => {
        try { load.stdin.end() } catch { /* ignore */ }
        finish(err)
      })
      load.on('error', (err) => finish(err))
    })
  }

  private async createAndAttachVolume(apiToken: string, dropletId: string, volumeName: string, region: string): Promise<string | null> {
    try {
      // Create volume
      const createResult = await axios.post('https://api.digitalocean.com/v2/volumes', {
        name: volumeName,
        size_gigabytes: 1,
        region: region,
      }, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      })

      const volumeId = createResult.data.volume.id

      // Attach volume to droplet
      await axios.post(`https://api.digitalocean.com/v2/volumes/${volumeId}/actions`, {
        type: 'attach',
        droplet_id: parseInt(dropletId, 10),
      }, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      })

      // Format and mount volume on droplet
      const mountPath = `/mnt/${volumeName}`
      return mountPath
    } catch (error: any) {
      if (error.response?.data?.id === 'invalid') {
        // Volume might already exist
        return `/mnt/${volumeName}`
      }
      this.warn(`Failed to create volume: ${error.message}`)
      return null
    }
  }

}
