---
title: Inspect, rename, delete
section: agents
order: 4
description: cast list, cast describe, cast rename, cast delete.
ref: ['cli:list', 'cli:describe', 'cli:rename', 'cli:delete']
---

# Inspect, rename, delete

Day-to-day housekeeping commands. All of them are read-only or near-read-only
(except `delete`, which is destructive).

## List agents

```bash
cast list
```

Output looks like:

```
Agents in ~/.cast/agents/

  email-assistant   [deployed: railway, v1.6]
  research-bot      [local: running on port 21357]
  slack-helper      [local: stopped]
```

The status suffix is one of:

- `[local: stopped]` — agent exists but is not running.
- `[local: running on port NNNNN]` — runtime is up locally.
- `[deployed: <provider>]` — at least one deployment exists.

## Describe an agent

```bash
cast describe email-assistant
```

`{% ref 'cli:describe" %}` prints:

- The description.
- Current status.
- A deployments table (SHA, provider, version, URL).
- The model.
- Configured tools (builtin, MCP, custom).
- The first 10 lines of `instructions.md`, then the full content.
- Permissions.
- The full `agent.yaml`.
- Quick actions (`cast dev`, `cast deploy`, `cast update`).

The deployment table uses the same SHA you'll see in `cast registry` and
when connecting.

## Rename

```bash
cast rename email-assistant mailer
```

`{% ref 'cli:rename" %}` moves the directory and rewrites references in the
SQLite database. It does not change git history if the agent is a Git repo
— the old name remains in the commit log.

In the TUI, `{% ref 'slash:rename" %}` opens a modal that prompts for the
new name with the same validation rules as the CLI.

## Delete

```bash
cast delete email-assistant
cast delete email-assistant --force     # skip confirmation
```

`{% ref 'cli:delete" %}` removes the agent directory, all release tarballs,
all deployment rows, and the database entry. **This is destructive and
unrecoverable** — Cast refuses without confirmation unless `--force` is
passed. To delete safely, first:

```bash
cast git push <name>          # backup to a remote
cast release <name> <ver>     # make sure the current state is in .cast/releases/
cast delete <name>
```

## What "deleted" means in Cast

Cast does not currently support a soft-delete for agents (only for
deployments — see [deployment overview](/deployment/overview)). When you
`cast delete`, the agent is gone. The release tarballs under
`~/.cast/agents/<name>/.cast/releases/` go with it, since they live inside
the agent directory.

If you want a recoverable delete, push to a Git remote first (`cast git
init` + `cast git push`); the repo retains the full history.
