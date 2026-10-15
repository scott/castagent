---
title: Connect, shutdown, upgrade
section: building-agents
group: deployment
order: 3
description: 'The three lifecycle commands: cast connect, cast shutdown, cast upgrade.'
ref: ['cli:connect', 'cli:shutdown', 'cli:upgrade']
---

# Connect, shutdown, upgrade

After `cast deploy` you have three lifecycle commands that target an
existing deployment.

## connect

```bash
cast connect email-assistant
cast connect abc123         # by deployment SHA
```

`{% ref "cli:connect" %}` opens a TUI chat session against the deployed
agent. The CLI reads that deployment's `auth_token_hash` from the SQLite
database and fetches the bearer token stored for that SHA. It uses the
agent-level keychain entry only when the hash matches this deployment, so
connecting to one host does not send another host's token. No token ever
appears in shell output. Deploying the same agent to a second provider
stores a second token and leaves the first one in place. On a machine
with no Secret Service, those tokens are read from
`~/.cast/tokens/deployments/<sha>.token` and
`~/.cast/tokens/<agent>.token` instead of the keychain. The token
directory is mode 0700, each file is created mode 0600, and both sit
outside the agent directory.

In the TUI, `{% ref "slash:connect" %}` opens a modal listing recent
deployments — pick by SHA or by name.

### Resolution priority

`cast connect <input>` resolves `<input>` in this order:

1. If `<input>` is a 6-character SHA, look up the deployment directly.
2. If `<input>` is an agent name and only one deployment exists, use it.
3. If `<input>` is an agent name and multiple deployments exist, the
   CLI prints a SHA list and exits with a clear error.
4. If no match: "No deployment found for 'X'. Use 'cast deploy' to
   deploy."

## shutdown

```bash
cast shutdown email-assistant
cast shutdown abc123
cast shutdown email-assistant --force
```

`{% ref "cli:shutdown" %}` calls that deployment's destroy method
(deletes the Railway project, destroys the Fly app, the sprite, or that
one MicroVM), then soft-deletes the matching row. The SHA stays on the
deleted row for audit. The remote resources for that row are gone.

Docker shutdown stops and removes the container `cast-<agent>`, removes
the image `cast-<agent>:latest`, and removes that agent's memory volumes.
If the image is already gone, shutdown stays quiet about it. If Docker
cannot delete the image, shutdown prints a note and still removes the
local records.

A SHA shuts down only that deployment. Another provider for the same
agent stays in the registry and keeps its auth token. An agent name is
accepted when every live row is the same target, and then every row of
that target is removed, including older re-deploys. Distinct targets
still require a SHA. `--force` skips the confirmation prompt only.

Sprites, Fly, Railway, Docker, and Droplets name one remote after the
agent. Shutting down any SHA of that provider removes the other rows for
that same provider, because the remote is shared. A MicroVM is one
remote per row, so shutting down its SHA leaves every other MicroVM
running.

When shutdown deletes an auth token, the log names the place it was
removed from. A token taken from the system keychain is reported as
`keychain`. A token taken from `~/.cast/tokens/` is reported as
`token file`. A token another live deployment still needs is left in
place.

In the TUI, `{% ref "slash:shutdown" %}` lists every active deployment
(including DigitalOcean MicroVM and local) and shuts one down after a
Y/N confirmation. It runs in dev and production, not in the
[on-host TUI](building-agents/development-workflow/tui/on-host-tui).
ESC while output is streaming closes the modal and leaves the shutdown
running.

## upgrade

```bash
cast upgrade email-assistant 1.7
cast upgrade abc123 1.7
cast upgrade email-assistant              # defaults to latest
cast upgrade email-assistant --list-versions
```

`{% ref "cli:upgrade" %}` redeploys an existing deployment with a new
release tarball. The container is replaced but the **volume mount is
preserved** — agent memory survives the upgrade.

### Resolution

Same priority as `connect`: SHA first, then agent name (most-recent
deployment).

### Version

The version is a positional argument, not a flag.

- `cast upgrade <name> <semver>` must name an existing release
  (`cast releases <name>` to list).
- `cast upgrade <name> latest` uses the current working state, not a release.
- Omitting the version defaults to `latest`.

### Provider differences

- **Docker** — re-extracts the tarball, rebuilds the image, stops the
  old container, starts a new one with the same volume. The new container
  must stay running and print `Agent ready`. If it exits, the upgrade fails.
- **Railway** — re-extracts, runs `railway up --detach` to redeploy.
- **Fly** — re-extracts, runs `flyctl deploy --detach`.
- **DigitalOcean** — re-extracts, rebuilds, re-streams the image, and
  updates the SSH login MOTD so it shows the new version (and the
  on-host TUI hint if `--with-tui` is in the image). The SSH session
  reuses the host key in `~/.cast/ssh/known_hosts` and does not connect
  when that pin is missing.
- **Sprites** — re-extracts, runs `sprite deploy`.
- **DigitalOcean MicroVM** — exports memory (8 MiB cap), builds a new linux/amd64 image, creates a replacement MicroVM, restores memory, then deletes the previous one. Image, size, and env cannot be changed in place.

`cast upgrade` is the right command for routine version bumps. For
rollbacks (you shipped a broken release and want to revert),
the same command works. Pass the previous release as the version
argument.
