---
title: Sessions
section: versioning
order: 3
description: Saved conversations — resume, fork, rename, and audit.
ref: ['cli:session', 'slash:session-list', 'slash:session-new', 'slash:session-resume', 'slash:session-rename', 'slash:session-fork', 'slash:session-delete']
---

# Sessions

A **session** is a saved, named conversation tied to an agent. Sessions
are distinct from releases (the deployment artifact) and from the undo
log (the internal edit history of the agent's files).

Cast creates a session the first time you chat with an agent and
appends every user/agent message to it. You can resume, rename, fork,
or delete sessions with `cast session …` (or `/session …` in the TUI).

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

In the TUI, `/session fork` forks the *active* session and
immediately switches the chat over to the new fork.

## Renaming a session

```bash
cast session rename <id|name> "new name"
```

A session's name is a human-readable label. The id is immutable.

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
/session [list|new|resume|rename|fork|delete]   # parent
/session-list                                    # modal picker
/session-new [name]                              # start fresh
/session-resume [id|name]                        # open picker if no arg
/session-rename <id|name> <new-name>
/session-fork [name]                             # fork current
/session-delete [id|name]                        # delete (default: current)
```

`/session list` opens a modal that follows the AGENTS.md design
standards (90% wide, 80% tall, centered). Use `↑/↓` to navigate, `Enter`
to select, `/` to filter, and `R` / `D` shortcuts to resume or delete
the highlighted session.

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
