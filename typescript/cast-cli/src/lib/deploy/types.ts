import type {ChildProcess} from 'child_process'

/**
 * One deployment host. Built-ins and out-of-tree `provider.cjs` files
 * export this shape. Commands look up a provider by `key`.
 */
export interface DeploymentProvider {
  key: string
  name: string
  description: string

  cli?: {
    command: string
    installUrl: string
    installHints?: string[]
    minVersion?: string
    /** Docker's CLI is documented, but it is not a cloud login walkthrough. */
    walkthrough?: 'skip'
    /** Logged, then raised, when the interactive walkthrough still cannot find the CLI. */
    interactiveRecheckError?: string
    interactiveRecheckHelp?: string[]
  }
  auth?: {
    command?: string
    envVars?: string[]
    configKey?: string
    tokenHelp?: string[]
    /** Confirm question after tokenHelp. Defaults to a generic prompt. */
    tokenConfirm?: string
  }
  requiresDocker?: boolean
  /** Interactive walkthrough and tool check require a running daemon (local Docker). */
  requiresDockerDaemon?: boolean

  /**
   * Exact pre-deploy tool checks preserved from the historical deploy switch.
   * An empty array means the provider intentionally checks nothing here.
   * Omitted means a generic CLI / Docker check for external providers.
   */
  toolChecks?: ProviderToolCheck[]

  // 'supported' forwards --with-tui (digitalocean).
  // 'rejected' errors with withTuiRejectMessage (microvm).
  // omitted or 'ignored' accepts the flag and does not forward it.
  withTui?: 'supported' | 'rejected' | 'ignored'
  withTuiRejectMessage?: string

  /** When true, `cast upgrade` writes the version on this deployment row, not the active row. */
  recordsVersionByDeploymentId?: boolean

  // Merged onto `cast deploy`. Prefix each description with the provider
  // name. Flags you do not declare are ignored when this provider runs.
  flags?: Record<string, unknown>

  prepare?(ctx: ProviderContext): Promise<void>
  deploy(ctx: DeployContext): Promise<void>
  destroy?(ctx: DestroyContext): Promise<void>
  upgrade?(ctx: UpgradeContext): Promise<void>
  memory?: {
    mountPath: string
    create?(ctx: MemoryContext): Promise<void>
    delete?(ctx: MemoryContext): Promise<void>
  }
  connect?(ctx: ConnectContext): Promise<ConnectResult | void>
}

export interface ProviderToolCheck {
  command: string
  installUrl: string
  error: string
  requireDaemon?: boolean
}

export interface ProviderContext {
  agentName: string
  agentPath: string
  force: boolean
  token?: string
  authToken: string
  tokenHash: string
  log(message: string): void
  warn(message: string): void
  error(message: string): never
  confirm(message: string): Promise<boolean>
}

export interface DeployContext extends ProviderContext {
  flags: Record<string, unknown>
  version: string
  deploymentSha: string
  port: number
  withTui: boolean
}

export interface DeploymentRow {
  id: string
  agent_name: string
  provider: string
  deployment_url: string
  volume_id?: string | null
  volume_config?: string | null
  deployed_version?: string | null
  /** `remote-state-unknown` means the remote may not match `deployed_version`. */
  remote_version_state?: string | null
}

export interface DestroyContext {
  agentName: string
  deployment: DeploymentRow
  log(message: string): void
}

export interface UpgradeContext extends DeployContext {
  versionTarballPath: string | null
  deployment: DeploymentRow
}

export interface MemoryContext {
  agentName: string
  deploymentId: string
  volumeId: string
  mountPath: string
}

export interface ConnectContext {
  agentName: string
  deployment: DeploymentRow
  url: string
  token?: string
  /** Command flags. Sprites reads `proxy` to force the local proxy. */
  flags?: {proxy?: boolean} & Record<string, unknown>
  log(message: string): void
  warn(message: string): void
  error(message: string): never
}

export interface ConnectResult {
  url?: string
  token?: string | null
  edgeToken?: string
  proxyProcess?: ChildProcess
  timeoutHint?: string
}
