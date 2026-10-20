---
title: Releases
section: building-agents
group: deployment
order: 2
description: Creating, listing, and shipping semantic releases.
ref: ['cli:release', 'cli:releases', 'cli:deploy', 'cli:upgrade']
---

# Releases

A **release** is a named, semver'd snapshot of an agent that you can ship,
talk about, and roll back to. Releases live at
`~/.cast/agents/<name>/.cast/releases/`.

## Listing releases

```bash
cast releases email-assistant
```

Output:

```
Agent: email-assistant
Current release: 1.6

Releases:
─────────────────────────────────────────────────────────────
  1.0   5/9/2026 6:26:28 PM    Initial release
  1.5   5/9/2026 9:35:20 PM    Added email processing
  1.6   5/12/2026 1:08:33 PM   Updated model + permissions
─────────────────────────────────────────────────────────────

Commands:
  cast release email-assistant <version>  - Create a new release
  cast deploy email-assistant --version <ver>  - Deploy a specific release
  cast upgrade email-assistant <ver>  - Upgrade to a release
```

In the TUI, `{% ref "slash:releases" %}` lists releases for the agent
open in the session. Inside `cast new`, that is the agent the wizard
just created. Before an agent exists, the command replies
`No agent is loaded.`

`releases.json` is the manifest; the tarballs (`1.0.tar.gz`, `1.5.tar.gz`,
…) sit alongside it. `agent.yaml`'s `version: "1.6"` always points at the
current release. Each release records `tarball_path` relative to the agent
directory, for example `.cast/releases/1.0.tar.gz`. A clone or a move of
the agent directory still finds the archive. A manifest that already stores
an absolute path keeps using that file when it exists, and otherwise opens
the tarball of the same name in `.cast/releases/`.

## Creating a release

```bash
cast release email-assistant 1.7
cast release email-assistant 1.7 --message "Switched model + tightened permissions"
```

`{% ref "cli:release" %}` does the following:

1. Validates the semver format (`MAJOR.MINOR.PATCH`).
2. Rejects a version lower than the `version` already in `agent.yaml`.
   That file is left unchanged.
3. Updates only the `version` field in `agent.yaml`. Other quoting,
   comments, and list indentation stay as they were.
4. Snapshots that working tree into `releases/<version>.tar.gz`, so the
   tarball's `agent.yaml` records the release version. The tarball is
   the full agent: `agent.yaml`, the prompt named by
   `brain.instructions_file` (that file is not always `instructions.md`),
   `skills/`, `tools/`, `mcp/`, `tests/`, memory notes, and any other
   project file. Paths listed in `.castignore` are left out, including
   the runtime memory database, logs, `.env`, `__pycache__/`, and
   `.cast/versions/`.    `.cast/` (the undo log and release history) and
   `.git/` are not packed; restore leaves them on disk.
   Symbolic links and hard links are not packed either. Restore refuses
   an archive that contains one, including a link whose target is absolute
   or contains `..`, so a release cannot write a file outside the agent
   directory.
5. Writes a row to `releases.json` with timestamp, message, and
   auto-generated changelog.
6. Records the release in the `releases` table of `cast.db`.

The changelog groups those changes by category (Features / Improvements / Config).

The `--message` flag overrides the auto-generated message. If the version
you're about to release corresponds to a breaking change (e.g. you removed
a required tool), Cast prompts for confirmation.

`cast release`, the TUI `/release` command, and the builder `create_release`
tool all use the same writer. The CLI and TUI run that writer with the
virtualenv next to the Cast Python package (`python/.venv`) when it exists.
A successful release updates `releases.json` and inserts one SQLite row
(version, change number, message, changelog, and tarball path). Listing
releases or reading the current release also inserts any JSON versions that
are missing from `cast.db`. A row that is already stored is left as-is, so
a second create does not blank its message or changelog. `cast.db`'s current
release and `releases.json`'s `current.version` stay in agreement.

If creating a release fails, Cast restores `releases.json`, `agent.yaml`,
and the tarball to the bytes they had before the attempt. A version that
did not finish is not recorded, so the same version can be created again.

## Suggested versions

When you open `{% ref "slash:release" %}` in the TUI, Cast suggests the
next semver based on the kind of change that was last made:

| Change kind | Bump | Why |
|---|---|---|
| `model:` only | patch (1.5.0 → 1.5.1) | config change |
| `instructions` only | minor (1.5.0 → 1.6.0) | behaviour change |
| Added MCP / tool | minor | new capability |
| Removed required tool | major (1.5.0 → 2.0.0) | breaking |
| Tightened permissions | patch | config change |

You can always type a different version; the suggestion is just a
starting point.

## Deploying a release

```bash
cast deploy email-assistant --version 1.7 --provider railway
```

`{% ref "cli:deploy" %}` restores the working tree from `1.7.tar.gz`
before building the deployment image. Files in that release replace
the working copies, and project files that are not in the release are
removed. `.castignore` paths, `.cast/`, and `.git/` stay in place.
`cast restore <agent> --release 1.7` does the same restore without
deploying. The resulting deployment's
`deployed_version` is recorded as `1.7` in the database. A unique
**deployment SHA** is also generated and printed:

```
Deployed email-assistant with deployment SHA: abc123
Connect with: cast connect abc123
```

Without `--version`, Cast records the top-level `version` in the agent
directory's `agent.yaml`. Deploy and the runtime parse that field with
a YAML parser and keep it as text, so `version: 1.10`, `version: 2.0`,
and `version: 1.0.0` stay `1.10`, `2.0`, and `1.0.0`. Quoted forms such
as `version: "1.10"` and `version: '2.0'` stay that text too. A block
scalar is that text with surrounding whitespace removed, so a trailing
newline from `|`, `>`, or `|+` is not part of the version. A version
that still contains a newline or any other whitespace is refused.
Write it as one line, for example `version: "1.4.5"`. The runtime still
reports the text the parser returned. Anchors, aliases, and explicit
tags (`!!str`, `!!float`) resolve to the same text. An explicit `!!null`
tag is a missing version. A later duplicate `version` key wins. A
byte-order mark at the start of the file is ignored. `version: null`,
`version: ~`, an empty `version:`, and a missing `version` are `1.0`.
`cast deploy` records that `1.0` and warns once. A version that is not
MAJOR.MINOR or MAJOR.MINOR.PATCH, such as `true` or `yes`, is recorded
and `cast deploy` prints one warning.

## Upgrading a live deployment

```bash
cast upgrade abc123 1.7                  # by deployment SHA
cast upgrade email-assistant 1.7         # most recent
cast upgrade email-assistant             # defaults to latest
```

`{% ref "cli:upgrade" %}` redeploys with the new tarball. The deployment
record is updated in place; the SHA stays the same. Volume mounts (which
hold the agent's memory) are preserved across upgrades.

## Multi-deployment

The same agent can be deployed to multiple providers simultaneously, each
with its own SHA and its own `deployed_version`. `cast registry` lists
every live deployment, one row per row in `deployments` where `deleted_at`
is null. A blank `deployed_version`, or one that does not match a release,
is still listed. Soft-deleted deployments stay hidden. Release history
stays on `cast releases`.

```
AGENT            SHA       PROVIDER         VERSION    DEPLOYED                 URL
email-assistant  abc123    railway          1.6        5/12/2026 1:08:33 PM     https://email-assistant.up.railway.app
email-assistant  def456    fly              1.5        5/9/2026 9:35:20 PM      https://email-assistant.fly.dev
git-agent        ghi789    digitalocean     —          5/12/2026 1:08:33 PM     https://203.0.113.42
```

`cast registry <name>` is that table filtered to one agent. The agent name
is only in the heading.

```
Local Agent Registry: email-assistant
─────────────────────────────────────────────────────────────
  SHA       PROVIDER        VERSION  DEPLOYED               URL
  abc123    railway         1.6      5/12/2026 1:08 PM     https://email-assistant.up.railway.app
  def456    fly             1.5      5/9/2026  9:35 PM     https://email-assistant.fly.dev
  ghi789    digitalocean    —        5/12/2026 1:08 PM     https://203.0.113.42
─────────────────────────────────────────────────────────────
```

`cast upgrade` and `cast shutdown` both accept a SHA to target a specific
deployment, falling back to the most-recent deployment when given an
agent name.

A DigitalOcean URL in that table is `https://<droplet-ip>`. It identifies
the droplet. The agent listens on `127.0.0.1:8080`, and `cast connect`
reaches it through an SSH tunnel.
