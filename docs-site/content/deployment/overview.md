---
title: Deployment overview
section: deployment
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
        |  cast upgrade --version X        |  cast logs / cast shutdown
        v                                  v
  (redeploy in place)                (target the SHA)
```

## Providers

See the [providers page](/deployment/providers) for the full list. The
short version:

| Provider | Best for | Container | On-host TUI |
|---|---|---|---|
| **Railway** | managed containers, zero-config | yes | no |
| **Fly.io** | global edge, low latency | yes | no |
| **DigitalOcean** | a single VM you can SSH into | yes | yes (opt-in) |
| **Sprites** | tiny Firecracker VMs on Fly | yes | no |
| **Docker** | self-hosted Docker on this machine | yes | n/a |
| **Local** | no container, run on this host | no | n/a |

Each provider has its own CLI auth (`railway login`, `flyctl auth login`,
`doctl auth init`, `sprite login`). `cast deploy` walks you through any
prerequisites interactively if you haven't set them up.

## What gets shipped

The deployment is a single Docker image that contains:

- The agent's working directory (`agent.yaml`, `instructions.md`, `tools/`,
  `mcp/`) — extracted from the requested release tarball.
- A Python venv with `cast` runtime + the agent's `runtime.requirements`
  packages.
- For DigitalOcean with `--with-tui`: the `cast-tui` binary + Bun, so you
  can SSH into the droplet and run `cast-tui` inside the container.

The image exposes A2A on port 8080. The provider assigns a public URL
(Railway/Fly/DO) or you use `docker port` to map it locally.

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

## Rolling back

There is no first-class `cast rollback` (yet). The recipe:

1. `cast releases email-assistant` to find the previous version.
2. `cast upgrade <current-sha> --version <previous-version>`.

The previous tarball is extracted over the working tree, the image is
rebuilt, and the new container starts with the same volume. The
`deployed_version` field updates in the database.

## Pre-flight checklist

Before `cast deploy`:

- [ ] The agent has a release at the version you want to ship
      (`cast releases <name>`).
- [ ] You've authenticated with the provider's CLI
      (`railway login`, `flyctl auth login`, etc.).
- [ ] For DigitalOcean, you've set `DIGITALOCEAN_ACCESS_TOKEN`.
- [ ] The agent's `agent.yaml` has a description — the deploy banner
      uses it.
- [ ] You're not on a metered connection with a giant image; the on-host
      TUI bundle is ~100 MB. Use `--with-tui` only when needed.
