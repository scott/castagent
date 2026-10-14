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
```

In the TUI, `{% ref "slash:releases" %}` lists releases for the agent
open in the session. Inside `cast new`, that is the agent the wizard
just created. Before an agent exists, the command replies
`No agent is loaded.`

`releases.json` is the manifest; the tarballs (`1.0.tar.gz`, `1.5.tar.gz`,
…) sit alongside it. `agent.yaml`'s `version: "1.6"` always points at the
current release.

## Creating a release

```bash
cast release email-assistant 1.7
cast release email-assistant 1.7 --message "Switched model + tightened permissions"
```

`{% ref "cli:release" %}` does six things:

1. Validates the semver format (`MAJOR.MINOR.PATCH`).
2. Snapshots the current working tree into `releases/<version>.tar.gz`.
3. Updates `agent.yaml` with `version: "<version>"`.
4. Writes a row to `releases.json` with timestamp, message, and
   auto-generated changelog.
5. Records the release in the `releases` table of `cast.db`.
6. Auto-generates a changelog from the changes since the previous release
   and groups them by category (Features / Improvements / Config).

The `--message` flag overrides the auto-generated message. If the version
you're about to release corresponds to a breaking change (e.g. you removed
a required tool), Cast prompts for confirmation.

`cast release`, the TUI `/release` command, and the builder `create_release`
tool all use the same writer. A successful release updates `releases.json`
and inserts one SQLite row (version, change number, message, changelog, and
tarball path). Listing releases or reading the current release also inserts
any JSON versions that are missing from `cast.db`. A row that is already
stored is left as-is, so a second create does not blank its message or
changelog. `cast.db`'s current release and `releases.json`'s `current.version`
stay in agreement.

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

`{% ref "cli:deploy" %}` extracts the `1.7.tar.gz` over the working tree
before building the deployment image. The resulting deployment's
`deployed_version` is recorded as `1.7` in the database. A unique
**deployment SHA** is also generated and printed:

```
Deployed email-assistant with deployment SHA: abc123
Connect with: cast connect abc123
```

## Upgrading a live deployment

```bash
cast upgrade abc123 --version 1.7        # by deployment SHA
cast upgrade email-assistant --version 1.7    # most recent
cast upgrade email-assistant                  # defaults to latest release
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
git-agent        ghi789    digitalocean     —          5/12/2026 1:08:33 PM     http://203.0.113.42:8080
```

`cast registry <name>` is that table filtered to one agent. The agent name
is only in the heading.

```
Local Agent Registry: email-assistant
─────────────────────────────────────────────────────────────
  SHA       PROVIDER        VERSION  DEPLOYED               URL
  abc123    railway         1.6      5/12/2026 1:08 PM     https://email-assistant.up.railway.app
  def456    fly             1.5      5/9/2026  9:35 PM     https://email-assistant.fly.dev
  ghi789    digitalocean    —        5/12/2026 1:08 PM     http://203.0.113.42:8080
─────────────────────────────────────────────────────────────
```

`cast upgrade` and `cast shutdown` both accept a SHA to target a specific
deployment, falling back to the most-recent deployment when given an
agent name.
