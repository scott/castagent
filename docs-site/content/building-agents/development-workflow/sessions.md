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

## Connecting starts a new session

`cast connect` (by agent name, by deployment SHA, or to a local agent),
`/connect`, and opening the on-host TUI all start a new session. The
transcript is empty, and the model has no messages from any earlier
session. Turns inside that connection still share context with each
other. Connecting does not delete, end, or rewrite the previous
session — `cast session list` still shows it.

Continuing an old conversation is an explicit resume. Use
`cast session resume`, `/session resume`, or `Enter` / `R` in
`/sessions`. The resumed transcript is what the model sees, and later
turns append to that session. A fork (`cast session fork`, or `F` in
`/sessions`) continues from the copy; the original session's messages
stay as they were. `/session new` also starts a fresh model context
instead of carrying the chat you were just in. Switching agents with
`/connect` starts a new session for the agent you land on and does not
carry the previous agent's conversation across.

Persistent memory is separate from the session transcript and still
applies on a new session.

## Listing sessions

```bash
cast session list
cast session list --agent my-agent
cast session list --json
```

An unnamed session in this list and in the `/sessions` picker shows a
one-line topic from that agent's model (`brain.model` in `agent.yaml`).
The picker opens immediately and fills in a missing or outdated topic
in the background. Until that summary exists, the first user message
remains the fallback, and then `(untitled)`. A name you set is never
replaced by the topic. `--json` includes the stored `topic` and
`topic_message_count`.

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

The TUI opens with the session's full transcript preloaded. That
transcript is the model's context, and future chat turns are appended
to the resumed session. Connecting again does not reopen it. Resume
is how you continue the old conversation.

A dev session, including one created by `cast session new`, opens the
local agent. Resume attaches when that agent is already running, and
starts it when it is not. A production session connects to the agent's
deployment and opens the TUI there. In both cases the saved transcript
is loaded and later turns append to that session.

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
/session new [name]          # start a fresh session and model context
/session resume [id|name]    # resume; opens the picker if no argument
```

`/sessions` and `/session resume` (with no argument) open a modal that
follows the AGENTS.md design standards (90% wide, 80% tall, centered).
Use `↑/↓` to navigate. `Enter` and `R` resume the highlighted session,
`F` forks it, `N` renames it, and `D` deletes it. Fork, rename, and
delete do not have dedicated slash subcommands.

`/save [filename]` writes a plain text copy of the chat on screen. It
does not write session JSON. With no filename the file is
`~/.cast/transcripts/<agent>-<timestamp>.txt`. A relative name is saved
in that directory. An absolute path, or a path that starts with `~`,
is written at that location. Missing parent directories are created.

## Storage

```
~/.cast/sessions/         # mode 0700
├── <session-id>.json     # full transcript + metadata, created mode 0600
└── ...

cast.db 'sessions' table  # index for fast listing, database file mode 0600
```

The session JSON file holds the full conversation, including message
timestamps and any UI actions. `~/.cast/sessions` is mode 0700, and each
transcript is created mode 0600, so a permissive umask cannot leave the
conversation world-readable. The SQLite `sessions` table is a metadata
index for fast listing across agents. Deleting an agent cascades into
its sessions.
