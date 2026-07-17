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
agent. The CLI reads the deployment's `auth_token_hash` from the SQLite
database, fetches the corresponding bearer token from the keychain, and
hands both to the TUI. No token ever appears in shell output.

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

`{% ref "cli:shutdown" %}` calls the provider's destroy method
(deletes the Railway project, destroys the Fly app, etc.), removes the
SSH key entry, and soft-deletes the row in the `deployments` table.
The deployment SHA is preserved in the deleted row for audit, but the
remote resources are gone.

`--force` skips the confirmation prompt and the "if multiple deployments
exist" check — useful in scripts where you want to tear down everything
matching a name.

## upgrade

```bash
cast upgrade email-assistant --version 1.7
cast upgrade abc123 --version 1.7
cast upgrade email-assistant              # defaults to latest release
cast upgrade email-assistant --list-versions
```

`{% ref "cli:upgrade" %}` redeploys an existing deployment with a new
release tarball. The container is replaced but the **volume mount is
preserved** — agent memory survives the upgrade.

### Resolution

Same priority as `connect`: SHA first, then agent name (most-recent
deployment).

### Version

- `--version <semver>` — must be an existing release
  (`cast releases <name>` to list).
- `--version latest` — uses the current working state, not a release.
- No `--version` — defaults to `latest`.

### Provider differences

- **Docker** — re-extracts the tarball, rebuilds the image, stops the
  old container, starts a new one with the same volume.
- **Railway** — re-extracts, runs `railway up --detach` to redeploy.
- **Fly** — re-extracts, runs `flyctl deploy --detach`.
- **DigitalOcean** — re-extracts, rebuilds, re-streams the image, and
  updates the SSH login MOTD so it shows the new version (and the
  on-host TUI hint if `--with-tui` is in the image).
- **Sprites** — re-extracts, runs `sprite deploy`.

`cast upgrade` is the right command for routine version bumps. For
destructive rollbacks (you shipped a broken release and want to revert),
the same command works — just point `--version` at the previous
release.
