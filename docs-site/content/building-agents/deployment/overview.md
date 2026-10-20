---
title: Deployment overview
section: building-agents
group: deployment
order: 1
description: Choosing a provider, the deployment lifecycle, and multi-deployment with SHAs.
ref: ['cli:deploy', 'cli:connect', 'cli:shutdown', 'cli:upgrade', 'cli:registry']
---

# Deployment overview

Cast deploys the runtime agent as a containerised A2A server on the
provider of your choice. Every successful `cast deploy` returns a unique
**deployment SHA** that you can use to refer to that specific deployment
later.

## The lifecycle

```
  cast deploy --version <semver|latest>
        |
        v
  +-----------+    cast connect     +-----------+
  |  deploy   | ------------------->|  connect  |
  |  <sha>    |                     |  <sha>    |
  +-----------+                     +-----------+
        |                                  |
        |  cast upgrade <version>          |  cast logs / cast shutdown
        v                                  v
  (redeploy in place)                (target the SHA)
```

## Providers

See the [providers page](deployment/providers) for the full list. The
short version:

| Provider | Best for | Container | On-host TUI |
|---|---|---|---|
| **Railway** | managed containers, zero-config | yes | no |
| **Fly.io** | global edge, low latency | yes | no |
| **DigitalOcean** | a single VM you can SSH into | yes | yes (opt-in) |
| **DigitalOcean MicroVM** | pause/resume Firecracker VM in MKC1 (public preview) | yes | no |
| **Sprites** | tiny Firecracker VMs on Fly | yes | no |
| **Docker** | self-hosted Docker on this machine | yes | n/a |
| **Local** | not implemented; use Docker on this machine | no | n/a |

DigitalOcean SSH checks the droplet host key. Cast generates an ed25519 key, installs it with the droplet user-data, and saves the public key in `~/.cast/ssh/known_hosts` before the first connection. Later deploys and upgrades reuse that file. A droplet that has no pinned key is refused. Recreate it, or add a key you verified from the DigitalOcean console.

A new droplet uses size `s-2vcpu-2gb`. Pass `--size` with a size slug, such as `s-1vcpu-1gb`, to choose another size. An existing droplet keeps its original size.

Deploy also requires the OpenSSH client (`ssh` and `ssh-keygen`) and checks both before it stores an auth token. If deploy fails after that token is written, Cast deletes the token for that attempt, including `~/.cast/tokens/deployments/<sha>.token`. The agent token file is deleted only when no other deployment is still live.

`cast shutdown` of a droplet deletes the droplet and its memory volume. Shutdown looks that volume up by name and region, waits until it is detached, and deletes the DigitalOcean volume ID. If the volume is still attached after about two minutes, the deployment stays recorded so shutdown can be run again. It leaves every DigitalOcean account SSH key in place, including `cast-do-key`. The private key at `~/.ssh/cast_do_key` stays on this machine. Deploy reuses any account SSH key with that fingerprint, whatever the key is named, and passes that key's id when it creates a droplet. Deploy and shutdown do not delete, rename, or modify existing account keys. When the fingerprint is not on the account, deploy uploads the public key as `cast-do-key-<first 8 hex characters>`, or with a distinct suffix if that name is already taken.

A deploy that fails after creating a droplet deletes that droplet, any volume created for the attempt, and the `~/.cast/ssh/known_hosts` entry. The volume is deleted by ID after a lookup by name and region, once it has finished detaching. It counts as already gone only when that lookup finds nothing. If it is still attached after about two minutes, Cast records the deployment so `cast shutdown` can retry. A failed deploy does not delete account SSH keys. If the droplet or volume cannot be deleted, Cast records the deployment so `cast shutdown` can remove it.

`cast deploy --provider local` is not implemented. The command exits with
`Not yet implemented. Use --provider docker for now.` and does not record
a deployment. `cast registry` stays empty, and `cast connect` reports that
no deployment was found. Use `--provider docker` to run on this machine.
A successful Docker deploy stores the SHA printed by `cast deploy`.
`cast registry` lists that id, and `cast connect <sha>` finds it.

Each provider has its own CLI auth (`railway login`, `flyctl auth login`,
`doctl auth init`, `sprite login`). `cast deploy` walks you through any
prerequisites interactively if you haven't set them up.

Sprites needs the `sprite` CLI. Set `SPRITES_TOKEN` to a token created at
[sprites.dev/account](https://sprites.dev/account) in the
`org-slug/org-id/token-id/token-value` format. `sprite login` is an
alternative. `FLY_API_TOKEN` is not a Sprites token.

Sprites pause when idle. A process started only for the deploy command
is gone on the next wake, and chat then fails as soon as the local proxy
resets the socket. Cast registers the agent as a sprite service on port
8080. That service starts again after a wake, and `cast connect` starts
it before opening the proxy. Deploy the sprite again if it was created
before that service existed.

`sprite login` or `SPRITES_TOKEN` authenticates a Sprites deploy. The
sprite CLI reads `SPRITE_TOKEN`, so Cast copies `SPRITES_TOKEN` into
the environment of each `sprite` process when `SPRITE_TOKEN` is unset.
The token is not passed as an argument.
The launch script goes to `sprite exec` on stdin and contains the
deployment token plus the API key for `brain.model`. Other inference
keys stay on the machine running `cast deploy`.
Before the agent directory is packed, Cast writes `requirements.txt`
and copies the `cast` package to `.cast-runtime/cast`. The archive
uses the Docker build-context exclusions, so `.cast/` (release tarballs,
`releases.json`, and the undo log) stays on the machine running deploy.
`.cast-runtime/` is packed with the agent. The package
install on the sprite includes git, which GitPython imports before the
server binds. The service log is
`/.sprite/logs/services/cast-agent.log`. `cast logs` prints that file.
Deploy waits until the log contains `Agent ready`. A log line
`Error loading agent config` is a failure, including while the service
is still reported as running. If the service does
not become ready, deploy exits non-zero and does not print a deployment
SHA. A sprite this attempt created is destroyed. If that destroy fails,
Cast records the deployment so `cast shutdown` can remove it, and keeps
the token for that attempt. Otherwise the token file written for the
attempt is removed, including
`~/.cast/tokens/deployments/<sha>.token` when the machine has no Secret
Service. Memory stays at `/opt/cast-agent/memory` on the sprite. Cast
does not create a local directory under `/mnt/cast-memory`.

## Reaching a Sprites agent

`cast connect <agent>` is how you reach a Sprites agent. The sprites.app
address recorded for the deployment, `https://cast-<agent>.sprites.app`,
sits behind Sprites org auth. A request that is not logged in, including
`GET /`, `GET /health`, and `GET /.well-known/agent.json`, returns 302 to
`https://sprites.dev/auth/sprite`. That redirect is expected. The address
is not a direct agent URL, and the deploy banner points at `cast connect`
instead of presenting it as one.

`cast connect` treats that 302 as Sprites auth. It starts the sprite
service, then opens a local proxy. Cast copies `SPRITES_TOKEN` onto
`SPRITE_TOKEN` only for the `sprite` processes it starts. A proxy you
start yourself does not get that copy. Run `sprite login` first, or set
`SPRITE_TOKEN="$SPRITES_TOKEN"` on the command. Without one of those,
`sprite` exits with "no organizations configured". The value stays in
the environment. It is not a command argument.

`sprite proxy` runs in the foreground until you stop it. Use a second
terminal for the HTTP call, or end the proxy command with `&`.

```bash
SPRITE_TOKEN="$SPRITES_TOKEN" sprite proxy <port>:8080 -s cast-<agent>
```

The TUI talks to `http://127.0.0.1:<port>`. The proxy forwards to port
8080 on the sprite. Plain GETs through the proxy still return 404. The
agent answers JSON-RPC 2.0 on `POST /` only.

To call the agent over HTTP, start that proxy and POST JSON-RPC with the
deployment bearer token. That token is the one `cast connect` sends. It
lives in the system keychain, or in
`~/.cast/tokens/deployments/<sha>.token` (mode 0600) when the machine
has no Secret Service. Put it in the environment and send it as a
header. Do not pass it as an argument to `sprite` or `curl`.

```bash
# Foreground. Second terminal for curl, or append &.
SPRITE_TOKEN="$SPRITES_TOKEN" sprite proxy 8080:8080 -s cast-<agent>
# CAST_TOKEN is the deployment bearer token, not SPRITES_TOKEN.
curl --silent --show-error --config - http://127.0.0.1:8080/ <<EOF
header = "Authorization: Bearer ${CAST_TOKEN}"
header = "Content-Type: application/json"
data = "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"agent/card\",\"params\":{}}"
EOF
```

`message/send` needs `params.message` with `role` and `parts`. An empty
`params` object returns JSON-RPC `-32602`, "No text content found in
message".

```bash
curl --silent --show-error --config - http://127.0.0.1:8080/ <<EOF
header = "Authorization: Bearer ${CAST_TOKEN}"
header = "Content-Type: application/json"
data = "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"Hello\"}]}}}"
EOF
```

A GET of `/health` or `/.well-known/agent.json` through the proxy
returns 404.

`sprite url update --auth public -s cast-<agent>` turns off Sprites org
auth for that address. Anyone with the URL can open a connection to the
agent's HTTP service. It does not grant a shell or access to the Sprites
API. JSON-RPC still requires the deployment bearer token, and GET still
returns 404. Public mode puts that endpoint on the internet. Leave the
default (`sprite url update --auth sprite -s cast-<agent>`) unless you
intend that exposure.

Docker starts a container named `cast-<name>`. After it is ready, Cast
writes the deployment to `~/.cast/cast.db` under the SHA that `cast deploy`
prints. That write needs an `agents` row for the same name. Creating an
agent records the row, and deploy inserts it if it is still missing. If
that registry write fails, Cast stops and removes the container and its
memory volume before exiting. A container that exits before it is ready
stays in place so `docker logs cast-<name>` still works. `cast logs <name>`
prints those same container logs. Pass the deployment SHA when more than
one live deployment exists. `cast stop <name>` stops the running
container and leaves the deployment row and the `cast-<name>` memory
volume in place. `cast shutdown` removes both.

A DigitalOcean droplet runs the container `cast-agent`. The memory
volume is attached before that container starts. Cast formats it only
when it has no filesystem, mounts it at `/mnt/cast-<name>`, and records
that mount in `/etc/fstab` by filesystem UUID with `nofail`. Deploy
fails if the path is not mounted or the container's `/app/agent/memory`
is not that mount. `cast stop <name>`
SSHs to the stored droplet address and stops that container when it is
running. The droplet and its `cast-<name>` memory volume stay.
`cast shutdown` deletes the droplet and that volume. SSH checks the
pinned host key. A missing pin is reported as a stop failure.

A Fly app is named `cast-<agent>`. The first deploy creates it with
`flyctl apps create` after writing `fly.toml`. It does not use
`flyctl launch`, which refuses to run when that file is already there.
The memory volume is created once the app exists, with `--yes`, in region
`iad`, and only when the app has no volume of that name. A later deploy
reuses the existing volume. The volume name is `cast_<agent>_memory` (lowercase letters,
numbers, and underscores, at most 30 characters). The image copies the
Cast package to `/app/cast` and sets `PYTHONPATH=/app`, the same layout
Droplet and MicroVM images use. Secrets are sent with
`flyctl secrets import --stage`, so they reach the machine only when
`flyctl deploy` succeeds. A failed build leaves the previous `AUTH_TOKEN`
on the running machine, and Cast keeps that token. After `flyctl deploy` exits 0, Cast waits
until a machine is started and
`https://cast-<agent>.fly.dev/.well-known/agent.json` responds. A stopped machine, a
log line `No module named 'cast'`, or a card that never responds fails
the deploy. A current log line `Error loading agent config` fails it too,
including while the machine is still started or starting. An older copy
of that line, followed later by `Agent ready`, does not. Cast does not
print the success banner in that case. The new
token stays, because that release is already live.
`cast shutdown` destroys each machine and prints a line for every machine
removed, then destroys the app, then lists volumes with
`flyctl volumes list --json` and deletes every remaining volume of that
name by its `vol_...` id. A volume bound to a machine cannot be deleted,
and stopping the machine does not release it. It reports the volume
removed only when a delete exits 0. When the app destroy already removed
the volume, it says the memory volume was removed with the app. It says
the volume was not present when that destroy did not remove the app and
the volume lookup finds nothing. It reports the app destroyed only when
`flyctl apps destroy` exits 0. If a remote step fails, shutdown exits
non-zero and keeps the deployment record and token. Fly's error text and
the retry hint are separated by a newline.
A failed deploy records the deployment as soon as the app exists, so
`cast shutdown <agent>` can remove the partial app, and deletes the
token file written for that attempt (`~/.cast/tokens/deployments/<sha>.token`)
when the new release did not go out.
The agent token file is deleted only when no other deployment is still live.
`cast logs` prints `flyctl logs --no-tail`. `cast stop` stops machines that
are started, starting, or replacing. `cast status` prints `flyctl status`.
Pass `--local-only`, `--remote-only`, `--depot`, or `--no-depot` on
`cast deploy` to choose the builder.

## What gets shipped

The deployment is a single Docker image that contains:

- The agent's working directory, taken from the requested release
  tarball: `agent.yaml`, the prompt file, `skills/`, `tools/`, `mcp/`,
  `tests/`, and other project files. Paths listed in `.castignore` are
  not in that tarball.
- A Python venv with `cast` runtime + the agent's `runtime.requirements`
  packages.
- The git binary, installed with `apt-get install -y --no-install-recommends git`.
  The same step deletes the apt package lists. The runtime imports GitPython
  before the server binds, and that import fails when git is missing.
  Recommended packages such as openssh-client, xauth, less, and patch stay out of the image.
  perl stays, because git depends on it.
- For DigitalOcean with `--with-tui`: the `cast-tui` binary + Bun, so you
  can SSH into the droplet and run `cast-tui` inside the container.

Deploy sends `AUTH_TOKEN` and the API key for the provider selected by
`brain.model`. Other inference keys stay on the machine that runs
`cast deploy`. Fly imports the values on stdin. Docker passes an env
file on stdin. Railway reads each value from stdin. A droplet writes
them to a mode 0600 env file over SSH stdin. A sprite sends the launch
script on stdin. A MicroVM sends them in the create request body.

The image exposes A2A on port 8080. Railway and Fly assign a public
HTTPS URL. A DigitalOcean droplet binds that port to `127.0.0.1` and
records `https://<droplet-ip>` as the droplet address. `cast connect`
opens an SSH tunnel to that loopback port and does not send the bearer
token over public HTTP. `cast stop` reads that address and stops
`cast-agent` over SSH. It does not open port 8080. Docker maps the port
on the machine that ran `cast deploy`.

`cast deploy` writes `requirements.txt` before the provider runs. Each built-in
that installs packages writes it again on `cast upgrade`, after any snapshot of
the agent directory. A new provider calls the same helper on upgrade.
The file starts from `pip freeze` of `python/.venv` when that virtualenv exists,
otherwise from the built-in dependency list. That list already meets the floors
declared in `python/pyproject.toml`, including `typing-extensions`. Those
declared dependencies are applied on top. When both name a package, the higher
minimum is kept. A pre-release or dev pin sorts below the matching final
release, so pip does not keep it under the floor. Packages in the agent's
`runtime.requirements` are merged the same way. GitPython stays at 3.2.1 or
newer, which the runtime imports at startup. The `cast` package itself is omitted
because the image copies that source tree in directly.

Docker, Fly, Sprites, Droplets, MicroVMs, and Railway install that file with
`pip install -r requirements.txt`. A new provider uses the same file and does
not keep its own package list. `--provider local` writes the file and then
stops, because that provider is not implemented and does not run pip.

Droplet, MicroVM, and Fly images copy that same package to `/app/cast` and set
`PYTHONPATH=/app`. Their `requirements.txt` is the same file and also omits
`cast`. Fly deploy then waits until
`https://cast-<agent>.fly.dev/.well-known/agent.json` returns the agent
card. A machine that exits before that, including `No module named 'cast'`,
fails the deploy and Cast does not print a success banner. A current
log line `Error loading agent config` fails that check while the machine
is still started or starting.

The runtime stage installs git with
`--no-install-recommends` and removes the apt lists. gcc stays in the
builder stage. A generated Dockerfile that still points `PYTHONPATH` at
`/usr/local`, or whose runtime stage omits
`apt-get install -y --no-install-recommends git` and the apt list cleanup,
is replaced on the next deploy.

`cast deploy --provider docker` and `cast deploy --provider digitalocean`
wait until the container is still running and the runtime has printed
`Agent ready`. A log line `Error loading agent config` fails that check.
If the container exits or keeps restarting, deploy fails
with a non-zero status and does not print a deployment SHA. The same
readiness check applies to `cast upgrade` of a Docker deployment. A
MicroVM that fails before the endpoint answers is deleted. If that
delete fails, Cast records the MicroVM so `cast shutdown` can remove it.
When the MicroVM is deleted, Cast also deletes the registry tag it pushed
and the auth token file written for that attempt. The tag and token stay
when the MicroVM remains and the deployment is recorded.

## Multi-deployment

You can deploy the same agent to many places. Each deployment gets a
6-character SHA, generated from `SHA256(agentName + timestamp + random)`,
which you use to disambiguate:

```bash
cast deploy email-assistant --provider railway   # SHA: abc123
cast deploy email-assistant --provider fly       # SHA: def456
cast deploy email-assistant --provider digitalocean --with-tui  # SHA: ghi789

cast connect abc123     # the railway one
cast connect def456     # the fly one
cast shutdown ghi789    # tear down only the digitalocean one
```

Deploying that agent again on a provider it already uses replaces the
previous row for that remote. The older SHA is marked deleted and its
token file is removed, so `cast connect email-assistant` reaches the new
deployment when that provider is the only live one. Rows left over from
a redeploy before this repair are retired the same way when
`cast connect` or `cast shutdown` resolves the agent name. The host stays
up. Two providers, or two MicroVMs, still need a SHA.

The database keeps a soft-delete history, so you can audit what was
deployed where and when.

## Volumes and persistent memory

Each provider's deployment creates (or attaches to) a volume that holds
the agent's persistent memory. The volume is keyed by the agent name
(`cast-email-assistant`), not the deployment SHA — so when you
`cast upgrade` to a new release, the new container reattaches the same
volume and the agent's memories survive the upgrade.

A DigitalOcean Droplet uses that same `cast-<name>` volume name. Shutdown
deletes that volume and any older `cast-<name>-<uuid>-memory` volume left
by a previous deploy.

## Rolling back

There is no first-class `cast rollback` (yet). The recipe:

1. `cast releases email-assistant` to find the previous version.
2. `cast upgrade <current-sha> <previous-version>`.

The previous tarball is extracted over the working tree, the image is
rebuilt, and the new container starts with the same volume. The
`deployed_version` field updates in the database.

## DigitalOcean MicroVMs

`--provider microvm` runs the same image on a DigitalOcean MicroVM instead of a Droplet.

- Public preview, region **MKC1** only, **linux/amd64** images only. Not for production.
- The image is pushed to your team's DigitalOcean Container Registry. Cast reuses the existing registry, or creates one named `cast`. The image includes the Cast package at `/app/cast`.
- A MicroVM whose workload exits is deleted. If the delete fails, the deployment is recorded so `cast shutdown` can remove it.
- A failed deploy or readiness probe that deletes the MicroVM also deletes the registry tag pushed for that attempt (for example `cast-<agent>:<id>`) and the auth token file under `~/.cast/tokens/`. The agent token stays when another deployment is still live. The tag and token stay when the MicroVM cannot be deleted and the deployment is recorded. A failed upgrade deletes the replacement tag only after that replacement MicroVM is gone. The previous MicroVM and its tag stay.
- The MicroVM pauses after an idle timeout (default 15 minutes, maximum 4 hours). The next request resumes it. While it is waking, the endpoint can return HTTP 503. Cast retries that response for about a minute. A paused MicroVM bills storage only.
- The edge closes each chat response about 15 seconds after the request starts, even while bytes are still arriving. Cast keeps that reply running and continues it on the next request, so a long step such as installing a skill can finish. A keepalive every 5 seconds still covers proxies that drop a quiet stream. Deploy or upgrade the agent so the image includes that runtime, and reconnect with a current build.
- There is no SSH and no on-host TUI. `--with-tui` is rejected. Logs: `doctl compute microvm exec <id> -- <log command>`.
- Cast passes the DigitalOcean API token to `doctl` as `DIGITALOCEAN_ACCESS_TOKEN` in the child environment. The token is not a `doctl` argument. `ps` and command logs do not show it.
- Every request to the endpoint sends your DigitalOcean token as `Authorization`. Cast also sends the agent token as `X-Cast-Authorization`. If deploy's probe gets 401, rerun with `--edge-auth-only`. That mode trusts any token on the team that has `microvm:access`.
- Sizes are `1:2048` (default), `2:4096`, `8:16384`, and `16:32768`, passed as `--size`.
- Upgrade copies memory off the old MicroVM and onto a new one, and packages the current Cast runtime into the new image. Stores larger than 8 MiB are left on the old MicroVM and the upgrade stops.
- `cast shutdown` deletes the registry tag stored for that MicroVM after the MicroVM is destroyed. Another MicroVM for the same agent keeps its own tag. If that tag delete fails, Cast warns and names the tag that is still in the registry, then continues the rest of shutdown.
- A custom-scoped token needs `microvm:create`, `microvm:read`, `microvm:update`, `microvm:delete`, `microvm:access`, and registry read/write.

## Pre-flight checklist

`cast deploy` reads `agent.yaml` before it talks to a provider. A file
that cannot be parsed, or whose top level is not a mapping, exits
non-zero and prints the error. The runtime exits the same way and does
not start on defaults.

Before `cast deploy`:

- [ ] The agent has a release at the version you want to ship
      (`cast releases <name>`).
- [ ] You've authenticated with the provider's CLI
      (`railway login`, `flyctl auth login`, etc.).
- [ ] For DigitalOcean Droplets or MicroVMs, you've set `DIGITALOCEAN_ACCESS_TOKEN`.
      MicroVMs also need `doctl` 1.173.0 or newer.
- [ ] The agent's `agent.yaml` parses, and its top level is a mapping.
      A broken file fails `cast deploy` before any provider work.
- [ ] The agent's `agent.yaml` has a description — the deploy banner
      uses it.
- [ ] You're not on a metered connection with a giant image; the on-host
      TUI bundle is ~100 MB. Use `--with-tui` only when needed.
