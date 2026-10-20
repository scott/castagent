# Deployment providers

A deployment provider hosts a Cast agent. `cast deploy`, `cast upgrade`, `cast shutdown`, and `cast connect` look up a provider by its `key` and call it. They do not contain a switch per host.

The seven built-ins (`railway`, `fly`, `digitalocean`, `microvm`, `sprites`, `docker`, `local`) live in this directory. Another host can add itself without editing those commands.

## Add a built-in

1. Add `providers/<key>.ts` that exports a `DeploymentProvider`.
2. Import it once from the built-in registry, in picker order.
3. Add a row to `providers.manifest.json` with the same `key`. A test fails if the module and the manifest disagree.
4. Add tests for `deploy`, `destroy`, and any `upgrade` or `connect` hook.
5. Install Python packages from the `requirements.txt` that `cast deploy` writes. Call `stagePythonRequirements` from `requirements.ts` on `upgrade`, after any snapshot of the agent directory. Do not copy package minimums into the provider. `python/pyproject.toml` is the source of truth.
6. Update `docs-site/content/building-agents/deployment/overview.md` if the public comparison table changes.

Do not add the key to `deploy.ts`, `upgrade.ts`, `shutdown.ts`, `connect.ts`, or `cast-tui/src/lib/deployment-providers.ts`. Those read the registry.

## Add an external provider

Create `~/.cast/providers/<key>/provider.cjs`:

```js
module.exports = {
  key: 'my-host',
  name: 'My Host',
  description: 'One line shown in the picker.',
  cli: {
    command: 'myhost',
    installUrl: 'https://example.com/install',
    installHints: ['brew install myhost'],
  },
  auth: {
    command: 'myhost login',
    envVars: ['MYHOST_TOKEN'],
    configKey: 'providers.myhost.token',
  },
  async deploy(ctx) {
    ctx.log(`Deploying ${ctx.agentName} to My Host...`)
    // Create the host resource, then record it:
    const {saveDeployment} = require('cast-cli/dist/lib/deploy/deploy-utils.js')
    await saveDeployment(ctx.agentName, 'my-host', 'https://example.invalid', ctx.tokenHash)
  },
  async destroy(ctx) {
    ctx.log(`Removing ${ctx.agentName} from My Host.`)
  },
}
```

Or list a CommonJS file or package in `~/.cast/config.yaml`:

```yaml
deploymentProviders:
  - ~/src/my-host/provider.cjs
  - my-cast-provider
```

Cast loads built-ins first, then every `~/.cast/providers/<key>/provider.cjs` in directory order, then `deploymentProviders` in the order written. The `key` must match `[a-z0-9-]+`, must be unique, and must not reuse a built-in key. The folder name and the `key` must match.

External providers appear in `cast deploy` and in the TUI picker after the built-ins. Number keys run from 1 through the full list. They are not written into the docs site. The docs site lists built-ins only.

`provider.cjs` has to be CommonJS. Cast loads it with `require` while it builds `cast deploy` flags.

## Provider object

```ts
interface DeploymentProvider {
  key: string
  name: string
  description: string

  cli?: {
    command: string
    installUrl: string
    installHints?: string[]
    minVersion?: string
  }
  auth?: {
    command?: string
    envVars?: string[]
    configKey?: string
    tokenHelp?: string[]
  }
  requiresDocker?: boolean

  // 'supported' forwards --with-tui (digitalocean).
  // 'rejected' errors with withTuiRejectMessage (microvm).
  // omitted or 'ignored' accepts the flag and does not forward it.
  withTui?: 'supported' | 'rejected' | 'ignored'
  withTuiRejectMessage?: string

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
```

`deploy` is required. `destroy` is required for any provider that creates a remote resource. If `destroy` is omitted, `cast shutdown` warns `No shutdown handler for provider '<key>'. Removing local records only.` and still removes the local deployment rows and the keychain token.

If `upgrade` is omitted, `cast upgrade` errors with `Upgrade not supported for provider '<key>'. Please use 'cast shutdown' and 'cast deploy' instead.`

## What Cast does before `deploy`

The provider does not repeat this work:

- Checks that `~/.cast/agents/<agent>` exists.
- Prompts to commit a dirty agent git repo. `--force` commits without asking.
- Extracts the requested release tarball when `--version` is not `latest`.
- Generates the 6-character deployment SHA and sets `CAST_DEPLOYMENT_SHA`.
- Runs the generic CLI, auth, and Docker checks from `cli`, `auth`, and `requiresDocker`.
- Calls `prepare` after those checks, for anything the generic walkthrough cannot express.
- Writes `requirements.txt` with `stagePythonRequirements`. Declared minimums come from `python/pyproject.toml` in the checkout that contains both `python/cast` and that file. The built-in fallback list carries those same floors. A `pip freeze` pin or a fallback floor is kept when it is at least that minimum. A pre-release or dev pin sorts below the matching final release. A post-release (`1.2.16-1`) sorts above it, and a higher epoch sorts above a lower one. An agent `runtime.requirements` line is kept as written, except a plain name or a lower bound below the floor, which is raised. Extras, compatible upper bounds, and markers stay. A marker does not remove the unconditional floor. A direct URL or VCS reference is kept, with one warning, because it cannot be checked against the floor. `--hash` options are removed, and deploy prints one warning that hashes are not supported. A pin or upper bound that cannot meet the floor fails the deploy before the image is built. The error names the package, the agent's spec, and the required floor, and it says to raise the bound or remove the line. A malformed line fails the same way. URL userinfo is masked in that error and in warnings. Package names match after PEP 503 normalization. Install that file. Do not ship a second package list.
- After `deploy` resolves, stores the deployed version on the deployment row.

`cast upgrade` does not write the file before `upgrade`. A failed Sprites upgrade restores a snapshot taken at the start of `upgrade`, and a file written before that snapshot would be restored with it. Call `stagePythonRequirements(agentPath)` inside `upgrade` after the snapshot. Image upgrades that already call `stageCastRuntime` or `prepareCastImageContext` write the same file.

`deploy` must call `saveDeployment` (or the db helper it wraps) so `cast connect` and `cast shutdown` can find the row. Use `ctx.deploymentSha` as the row id. `ctx.tokenHash` is the hash of the agent auth token Cast generated. The raw token is `ctx.authToken`. Put it in the host environment. Do not log it. `saveDeployment` marks earlier rows for the same provider and resource deleted and removes their `~/.cast/tokens/deployments/<sha>.token` files. Pass `{supersede: false}` when a failed deploy records a leftover remote, so the previous successful row stays. A second provider and a separate MicroVM stay registered.

## Context

```ts
interface ProviderContext {
  agentName: string
  agentPath: string
  force: boolean
  token?: string          // first hit from auth.envVars, then auth.configKey
  authToken: string       // per-agent bearer token
  tokenHash: string
  log(message: string): void
  warn(message: string): void
  error(message: string): never
  confirm(message: string): Promise<boolean>
}

interface DeployContext extends ProviderContext {
  flags: Record<string, unknown>
  version: string         // 'latest' or a semver; tarball already extracted
  deploymentSha: string
  port: number            // --port, default 8080
  withTui: boolean
}

interface DestroyContext {
  agentName: string
  deployment: DeploymentRow
  log(message: string): void
}

interface UpgradeContext extends DeployContext {
  versionTarballPath: string | null
  deployment: DeploymentRow
}

interface MemoryContext {
  agentName: string
  deploymentId: string
  volumeId: string
  mountPath: string
}

interface ConnectContext {
  agentName: string
  deployment: DeploymentRow
  url: string
  token?: string
  log(message: string): void
  warn(message: string): void
  error(message: string): never
}

interface ConnectResult {
  url?: string
  token?: string | null
  edgeToken?: string
  proxyProcess?: import('child_process').ChildProcess
  timeoutHint?: string
}
```

`DeploymentRow` is the sqlite deployments row: `id`, `agent_name`, `provider`, `deployment_url`, `volume_id`, `volume_config`, `deployed_version`, `remote_version_state`.

`connect` runs after the row is loaded and before the A2A client is built. Return `edgeToken` to send it as `Authorization` while the agent token goes out as `X-Cast-Authorization`. Return `token: null` to omit the agent token. Return `url` and `proxyProcess` to point the TUI at a local proxy. Cast kills `proxyProcess` when the TUI exits. `timeoutHint` is appended to a connect timeout.

`memory.create` and `memory.delete` replace the switches in `deploy-utils.ts`. `delete` is best-effort: a missing volume is not a failure. `mountPath` is what `getMemoryMountPath` returns.

## Rules

- `key` is stable. Do not rename a shipped key.
- `description` is one line. The TUI truncates it to 50 characters plus `...`.
- `destroy` should log and return when the remote resource is already gone. Throw only when the host rejects a real delete.
- Do not delete a container registry, an account-level resource, or the agent directory under `~/.cast/agents/` from `destroy`.
- Do not read `providers.digitalocean.token` for anything except DigitalOcean deploys. Inference keys stay on `DIGITALOCEAN_MODEL_ACCESS_KEY`.
- A provider that needs Docker sets `requiresDocker: true` instead of checking Docker itself.
- Keep provider-specific flags on the provider object. Do not add them to the shared `Deploy` flag list by hand.

## Metadata manifest

`providers.manifest.json` is the docs-site source. Each built-in has one object:

| Field | Used for |
|---|---|
| `key`, `name`, `description` | Picker, TUI, docs |
| `cliCommand`, `cliInstallUrl` | Docs provider card. Empty string if there is no CLI |
| `authCommand`, `authEnvVar` | Docs provider card. Omit if unused |
| `supportsWithTui` | `true` only when `withTui` is `'supported'` |
| `order` | Picker order. Built-ins use 10, 20, 30, … so a new host can slot in |

`docs-site/scripts/extract-providers.ts` reads this file with `JSON.parse`. It does not parse `deploy.ts` and it does not infer `--with-tui` from a switch. The TUI catalog is this file plus external providers discovered at runtime. Do not keep a second hand-written list of names.

## Built-in notes

These behaviors move behind the interface. They do not change.

| Key | Notes |
|---|---|
| `railway` | `railway` CLI, `railway login`. Memory is a Railway volume. `destroy` runs `railway down --yes`. Deploy and upgrade install `requirements.txt` from `stagePythonRequirements`. |
| `fly` | `flyctl`, `flyctl auth login`. The app is created with `flyctl apps create` (not `launch`) when `fly.toml` is already present. The image copies `python/cast` to `/app/cast`. Memory is a Fly volume named `cast_<agent>_memory` (lowercase, digits, underscores, at most 30 characters), created after the app exists with `--yes` only when `flyctl volumes list` has no volume of that name. A later deploy reuses it. Shutdown destroys machines (`flyctl machine destroy --force`) and the app first, then deletes every remaining `vol_...` id of that name, and reports removal only on exit 0. A failed remote step keeps the deployment row and token. Deploy waits until `/.well-known/agent.json` responds and fails if the machine exits. A log line `Error loading agent config` fails that check, including while the machine is still started or starting. A failed build records the row once the app exists and deletes the attempt's token file. Secrets go to `flyctl secrets import --stage` on stdin and apply only when `flyctl deploy` succeeds; that failure leaves the previous token in place. A release that exits 0 keeps the new token even if the health check then fails. Deploy flags: `--local-only`, `--remote-only`, `--depot`, `--no-depot`. |
| `digitalocean` | Droplet plus `docker load`. `withTui: 'supported'`. Flag `--size` is a droplet slug (default `s-2vcpu-2gb`) and is forwarded on deploy. Token from `DIGITALOCEAN_ACCESS_TOKEN` or `providers.digitalocean.token`. Requires Docker and `doctl`. SSH pins an ed25519 host key in `~/.cast/ssh/known_hosts` and keeps host key checking enabled. Memory volume is `cast-<agent>`. Shutdown deletes that volume and older `cast-<agent>-<uuid>-memory` volumes, and reports removal only when the delete succeeds. |
| `microvm` | `withTui: 'rejected'` with the existing error sentence. Flags `--size` (default `1:2048`), `--idle-timeout` (default `15m`), `--edge-auth-only`. `doctl` >= 1.173.0. The API token is `DIGITALOCEAN_ACCESS_TOKEN` in the `doctl` child environment, not an argument. `connect` sets the edge token and the resume hint. `destroy` deletes the MicroVM, not the registry. |
| `sprites` | `sprite`, `sprite login`, or `SPRITES_TOKEN` from https://sprites.dev/account (`org-slug/org-id/token-id/token-value`, copied to `SPRITE_TOKEN` for the CLI; not placed on argv). `FLY_API_TOKEN` is not a Sprites token. Deploy writes `requirements.txt`, copies `python/cast` to `.cast-runtime/cast`, and registers a `cast-agent` service on port 8080. The deploy fails unless `/.sprite/logs/services/cast-agent.log` contains `Agent ready`. A log line `Error loading agent config` fails that check. A sprite created by a failed attempt is destroyed, or recorded when destroy fails. Memory is `/opt/cast-agent/memory` on the sprite. The sprites.app URL needs Sprites org auth, so a 302 to the Sprites login page is expected, and the success output points at `cast connect` instead of that URL. `connect` starts the service, then `sprite proxy <port>:8080 -s cast-<agent>`, and sends the deployment bearer token on JSON-RPC POST. A proxy started by hand runs in the foreground and needs `sprite login` or `SPRITE_TOKEN="$SPRITES_TOKEN"`; Cast copies that variable only for sprite processes it starts. `message/send` needs `params.message.role` and `params.message.parts`. Plain GETs through the proxy return 404. `sprite url update --auth public` removes org auth and exposes the HTTP service to anyone with the URL; the bearer token still applies. `cast logs` reads the service log. `cast upgrade` re-extracts a release and runs that same install against the existing `cast-<agent>` sprite, reusing the deployment bearer token. It leaves the deployment row in place. If the redeploy fails, the local agent directory is restored and that previous release is redeployed through the same path. The recorded version stays the last known-good release. If that rollback also fails, the row is marked `remote-state-unknown` and `cast upgrade <agent> <recorded version>` is allowed. That restore prints `Restoring <recorded version> on the remote...` once and redeploys the recorded release once. A failure ends with one `Logs: sprite exec -s cast-<agent> -- cat /.sprite/logs/services/cast-agent.log` line. When no version was recorded, the failure says to run `cast upgrade <agent> --list-versions`. |
| `docker` | Requires a running Docker daemon. Reads `--port`. |
| `local` | `deploy` logs that it is not implemented and tells the user to use `--provider docker`. No `destroy`. |
