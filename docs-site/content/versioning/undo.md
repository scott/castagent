---
title: Undo and redo
section: versioning
order: 2
description: Step backwards and forwards through the agent's edit history.
ref: ['cli:undo', 'cli:redo']
---

# Undo and redo

Every time the Builder or `cast update` saves a new state of an agent,
Cast records a snapshot in an internal log at
`~/.cast/agents/<name>/.cast/changes/`. This log is the **undo log**.

You don't manage the log directly — it's an implementation detail.
You interact with it through `cast undo` and `cast redo`, which walk
the log backward and forward.

## Undo a single change

```bash
cast undo email-assistant
```

Output:

```
Undid 1 change for agent 'email-assistant':
  - v11  Added memory configuration  (2026-06-10T13:57:09.502343Z)

Use `cast redo` to bring the changes back.
```

The agent's working tree is restored to its state at v10, and v11 is
pushed onto the redo stack. `agent.yaml`, `instructions.md`, and
the `mcp/` and `tools/` directories are all rewound.

## Undo multiple changes

```bash
cast undo email-assistant --steps 3
```

This steps back three edits. The redo stack receives all three
entries, so `cast redo --steps 3` brings them all back.

## Redo

```bash
cast redo email-assistant
cast redo email-assistant --steps 3
```

`cast redo` pops the most recent entry from the redo stack and
restores that state. If the redo stack is empty, the command errors.

## The redo stack is cleared by a new edit

If you make a new edit after an undo, the redo stack is cleared. This
is the same behavior as standard text editors — once you diverge from
the "undo path," the redo path is no longer valid.

## TUI slash commands

In the TUI, `/undo` and `/redo` shell out to the CLI:

```
/undo         # step back one change
/undo 3       # step back three changes
/redo         # step forward one change
/redo 3       # step forward three changes
```

Both report success or failure in the chat. A future iteration will
add `/undo-to` with a modal picker (see the modal design standards in
`AGENTS.md`).

## How it relates to releases

When you `cast release`, the auto-generated changelog pulls from the
undo log. The release's `change_number` field is the id of the most
recent log entry at the time of release. Future releases compare
against that id to compute "what changed since v1.6".

If you `cast undo` after a release, the log entries that fed the
release's changelog are still there — the release's tarball is
self-contained, and the changelog is a snapshot of the log at release
time.

## Internal storage

```
~/.cast/agents/<name>/.cast/changes/
├── changes.json     # { versions: [...], current: N, redo_stack: [...] }
├── 001.tar.gz       # initial state
├── 002.tar.gz       # after first edit
└── ...
```

The `redo_stack` field is the source of truth for the redo path.
A new edit (with `preserve_redo_stack=False`, the default) clears the
stack. The internal `cast undo` and `cast redo` calls set
`preserve_redo_stack=True` so their internal snapshots don't wipe
the user's redo path.
