---
title: Sessions
section: building-agents
group: development-workflow
order: 2
description: Saved conversations — list, start, resume, fork, rename, and delete.
ref: ['cli:session', 'slash:sessions', 'slash:session']
---

# Sessions

A **session** is a saved, named conversation tied to an agent. Sessions
are independent of agent state — restoring an agent to an older state
does not invalidate existing sessions, and a release does not change
the sessions that were started against it.

Cast creates a session the first time you chat with an agent and
appends every user/agent message to it. You can resume, rename, fork,
or delete sessions with `cast session …` (or the TUI slash commands
listed below).

## Listing sessions

```bash
cast session list
cast session list --agent my-agent
cast session list --json
```

Output:

```
1 session for agent 'demo-agent':
──────────────────────────────────────────────────────────────────────────────
  19f6c793a7c-3666d2712a05  test-session
    agent: demo-agent · 0 msg · updated 0s ago
```

## Creating a session

```bash
cast session new my-agent
cast session new my-agent --name "auth experiment"
cast session new my-agent --mode build --ui-mode dev
```

The new session is created immediately. To start using it in the TUI:

```bash
cast session resume <session-id>
```

## Resuming a session

```bash
cast session resume <id|name>
cast session resume                     # opens a picker
```

The TUI opens with the session's full transcript preloaded. Future
chat turns are appended to the resumed session.

## Forking a session

A fork is a copy of an existing session's transcript that you can
diverge from. The original is left untouched.

```bash
cast session fork <id|name>
cast session fork <id|name> --name "alt approach"
```

In the TUI, highlight a session in `/sessions` and press `F`.
Cast copies the transcript into a new session and switches the
chat to that fork. Leave the name prompt empty to fork without a name.

## Renaming a session

```bash
cast session rename <id|name> "new name"
```

A session's name is a human-readable label. The id is immutable.
In the TUI, highlight a session in `/sessions` and press `N`.

## Deleting a session

```bash
cast session delete <id|name>
```

By default this prints a confirmation summary. Pass `--force` to
actually delete:

```bash
cast session delete <id|name> --force
```

## Export and import

Sessions are portable. You can save a session to a JSON file and load
it on another machine:

```bash
cast session export <id> --out ~/backup.json
cast session import ~/backup.json
```

`cast session import` assigns a new id by default (so it doesn't
collide with an existing session). Pass `--keep-id` to preserve the
original id.

## Pruning old sessions

Ended sessions older than a cutoff can be pruned in bulk:

```bash
cast session prune                  # default: 30 days
cast session prune --days 7 --force
```

This is most useful in production environments where many short-lived
sessions accumulate over time.

## TUI slash commands

```
/sessions                    # list sessions and open the modal picker
/session new [name]          # start a fresh session
/session resume [id|name]    # resume; opens the picker if no argument
```

`/sessions` and `/session resume` (with no argument) open a modal that
follows the AGENTS.md design standards (90% wide, 80% tall, centered).
Use `↑/↓` to navigate. `Enter` and `R` resume the highlighted session,
`F` forks it, `N` renames it, and `D` deletes it. Fork, rename, and
delete do not have dedicated slash subcommands.

## Storage

```
~/.cast/sessions/
├── <session-id>.json     # full transcript + metadata
└── ...

cast.db 'sessions' table  # index for fast listing
```

The session JSON file holds the full conversation, including message
timestamps and any UI actions. The SQLite `sessions` table is a
metadata index for fast listing across agents. Deleting an agent
cascades into its sessions.
