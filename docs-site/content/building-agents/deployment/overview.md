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

`cast shutdown` of a droplet deletes the droplet and its memory volume. Shutdown looks that volume up by name and region, waits until it is detached, and deletes the DigitalOcean volume ID. If the volume is still attached after about two minutes, the deployment stays recorded so shutdown can be run again. It also deletes the DigitalOcean account SSH key named `cast-do-key` when no other Cast droplet or Cast MicroVM still uses it. The key stays while another Cast droplet or MicroVM remains. The private key at `~/.ssh/cast_do_key` stays on this machine. The next deploy uploads it again if the account key is missing.

A deploy that fails after creating a droplet deletes that droplet, any volume created for the attempt, and the `~/.cast/ssh/known_hosts` entry. The volume is deleted by ID after a lookup by name and region, once it has finished detaching. It counts as already gone only when that lookup finds nothing. If it is still attached after about two minutes, Cast records the deployment so `cast shutdown` can retry. A failed deploy does not delete `cast-do-key`. If the droplet or volume cannot be deleted, Cast records the deployment so `cast shutdown` can remove it.

`cast deploy --provider local` is not implemented. The command exits with
`Not yet implemented. Use --provider docker for now.` and does not record
a deployment. `cast registry` stays empty, and `cast connect` reports that
no deployment was found. Use `--provider docker` to run on this machine.
A successful Docker deploy stores the SHA printed by `cast deploy`.
`cast registry` lists that id, and `cast connect <sha>` finds it.

Each provider has its own CLI auth (`railway login`, `flyctl auth login`,
`doctl auth init`, `sprite login`). `cast deploy` walks you through any
prerequisites interactively if you haven't set them up.

Sprites pause when idle. A process started only for the deploy command
is gone on the next wake, and chat then fails as soon as the local proxy
resets the socket. Cast registers the agent as a sprite service on port
8080. That service starts again after a wake, and `cast connect` starts
it before opening the proxy. Deploy the sprite again if it was created
before that service existed.

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

A DigitalOcean droplet runs the container `cast-agent`. `cast stop <name>`
SSHs to the stored droplet address and stops that container when it is
running. The droplet and its `cast-<name>` memory volume stay.
`cast shutdown` deletes the droplet and that volume. SSH checks the
pinned host key. A missing pin is reported as a stop failure.

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

The image exposes A2A on port 8080. Railway and Fly assign a public
HTTPS URL. A DigitalOcean droplet binds that port to `127.0.0.1` and
records `https://<droplet-ip>` as the droplet address. `cast connect`
opens an SSH tunnel to that loopback port and does not send the bearer
token over public HTTP. `cast stop` reads that address and stops
`cast-agent` over SSH. It does not open port 8080. Docker maps the port
on the machine that ran `cast deploy`.

For Docker, `requirements.txt` is written when you deploy or upgrade. It
starts from `pip freeze` of `python/.venv` when that virtualenv exists,
otherwise from the runtime's dependency list. It always adds dependencies
from `python/pyproject.toml` (including GitPython 3.2.1 or newer, which the runtime
imports at startup) and every package in the agent's `runtime.requirements`.
The `cast` package itself is omitted because the image copies that source
tree in directly.

Droplet and MicroVM images copy that same package to `/app/cast` and set
`PYTHONPATH=/app`. Their `requirements.txt` is written the same way and
also omits `cast`. The runtime stage installs git with
`--no-install-recommends` and removes the apt lists. gcc stays in the
builder stage. A generated Dockerfile that still points `PYTHONPATH` at
`/usr/local`, or whose runtime stage omits
`apt-get install -y --no-install-recommends git` and the apt list cleanup,
is replaced on the next deploy.

`cast deploy --provider docker` and `cast deploy --provider digitalocean`
wait until the container is still running and the runtime has printed
`Agent ready`. If the container exits or keeps restarting, deploy fails
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
- Every request to the endpoint sends your DigitalOcean token as `Authorization`. Cast also sends the agent token as `X-Cast-Authorization`. If deploy's probe gets 401, rerun with `--edge-auth-only`. That mode trusts any token on the team that has `microvm:access`.
- Sizes are `1:2048` (default), `2:4096`, `8:16384`, and `16:32768`, passed as `--size`.
- Upgrade copies memory off the old MicroVM and onto a new one, and packages the current Cast runtime into the new image. Stores larger than 8 MiB are left on the old MicroVM and the upgrade stops.
- `cast shutdown` deletes the registry tag stored for that MicroVM after the MicroVM is destroyed. Another MicroVM for the same agent keeps its own tag. If that tag delete fails, Cast warns and names the tag that is still in the registry, then continues the rest of shutdown.
- A custom-scoped token needs `microvm:create`, `microvm:read`, `microvm:update`, `microvm:delete`, `microvm:access`, and registry read/write.

## Pre-flight checklist

Before `cast deploy`:

- [ ] The agent has a release at the version you want to ship
      (`cast releases <name>`).
- [ ] You've authenticated with the provider's CLI
      (`railway login`, `flyctl auth login`, etc.).
- [ ] For DigitalOcean Droplets or MicroVMs, you've set `DIGITALOCEAN_ACCESS_TOKEN`.
      MicroVMs also need `doctl` 1.173.0 or newer.
- [ ] The agent's `agent.yaml` has a description — the deploy banner
      uses it.
- [ ] You're not on a metered connection with a giant image; the on-host
      TUI bundle is ~100 MB. Use `--with-tui` only when needed.
