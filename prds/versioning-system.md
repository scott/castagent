# Cast Agent Versioning System PRD

## Overview

This PRD documents Cast's three-track approach to agent state:

1. **Undo log** — internal, automatic, powers `cast undo` / `cast redo`.
2. **Releases** — explicit, semver'd, the deployment artifact.
3. **Sessions** — saved conversations, the user-facing transcript layer.

The original PRD introduced a "changes vs. releases" split. This
revision collapses "changes" into a private undo log (no user-facing
commands) and adds a third track: **sessions** for saved
conversations. The change log is still the source of truth for
auto-generated changelogs at release time.

---

## Problem Statement (revised)

The original "changes vs. releases" split reduced confusion but left
two outstanding problems:

1. **No conversation layer.** The Builder ran inside the TUI, but a
   chat was in-memory only. Quitting the TUI discarded the entire
   transcript. There was no way to resume, branch, or audit a
   conversation.

2. **The "changes" surface was busy.** `cast changes`, `cast diff`,
   `cast revert`, and `cast restore --change N` all exposed the same
   underlying log with subtly different semantics. New users had to
   learn four commands before they could do basic iteration.

The fix is to hide the change log behind a tighter undo/redo
vocabulary (matching every other editor and coding harness) and to
introduce a new "session" concept that captures the conversation
layer.

---

## Design Principles

1. **Three tracks, three vocabularies.** Changes are internal (undo
   log). Releases are external (semver). Sessions are external
   (conversations). Never conflate them.
2. **Internal things stay internal.** The change log is still on disk
   for changelog generation, but no `cast changes` command surfaces
   it. The user talks to the log through `cast undo` / `cast redo`.
3. **Self-documenting commands.** Names match the action. `cast undo`
   is undo. `cast release` is release. `cast session …` is session.
4. **CLI and TUI are consistent.** Every CLI command has a TUI slash
   command and vice versa.
5. **TUI uses modals for input.** Picker-style modals follow the
   AGENTS.md design standards (90% wide, 80% tall, centered, two-line
   rows, `▸` selection indicator, no row numbers).
6. **Releases are the deployment artifact.** `cast deploy` without
   `--version` deploys the current working tree as `"latest"`; with
   `--version` it deploys a release.
7. **Single source of truth for cross-agent queries.** Session
   metadata lives in `cast.db`; session *content* lives in
   `~/.cast/sessions/<id>.json` so it can be exported and inspected
   without SQL.

---

## The Three Tracks

### 1. Undo log (internal)

Automatic snapshots created whenever an agent is modified through the
Builder or `cast update`. Each entry is a sequential integer (1, 2,
3…) stored as a tarball at `~/.cast/agents/<agent>/.cast/changes/`.

**Purpose:** Power `cast undo` / `cast redo`; supply the auto-changelog
content for `cast release`.

**User-facing surface:** none. The log is consumed by:

- `cast undo` and `cast redo` (Python `cast.undo`)
- `/undo` and `/redo` TUI slash commands
- `cast release`'s changelog generator

**Storage:**

```
~/.cast/agents/<name>/.cast/changes/
├── changes.json    # { versions: [...], current: N, redo_stack: [...] }
├── 001.tar.gz
├── 002.tar.gz
└── ...
```

`changes.json` carries an extra `redo_stack: []` field that `cast undo`
populates as the user steps back. Any new edit (with the default
`preserve_redo_stack=False`) clears the stack, matching standard text
editor behavior.

### 2. Releases (external)

Intentional semantic versions (1.0, 1.6, 2.0.0) created when a user
explicitly releases. Each release maps a version to a tarball.

**Purpose:** Production deployments, external API versioning,
audit/rollback.

**User-facing surface:** `cast release`, `cast releases`, `cast
registry`, `cast deploy --version`, `cast upgrade`, `cast restore
--release`, `/release`, `/releases`, `/registry`, `/deploy`, `/upgrade`.

**Storage:**

```
~/.cast/agents/<name>/.cast/releases/
├── releases.json    # { current: {...}, releases: [...] }
├── 1.0.tar.gz
├── 1.6.tar.gz
└── ...

cast.db 'releases' table
```

### 3. Sessions (external)

A saved, named conversation tied to an agent. Cast creates a session
on the first chat turn and appends every user/agent message to it.

**Purpose:** Resume a conversation, fork it into a parallel thread,
audit what was said, export for backup, prune old transcripts.

**User-facing surface:** `cast session list|show|new|resume|rename|fork|
delete|export|import|prune`, plus `/session [list|new|resume|rename|fork|
delete]` and the per-subcommand slash commands `/session-list`,
`/session-new`, etc.

**Storage:** SQLite index for metadata + JSON-per-session for content.

```
~/.cast/sessions/
├── <id>.json
├── <id>.json
└── ...

cast.db 'sessions' table
```

---

## Storage Layout

```
~/.cast/
├── config.yaml
├── cast.db                                # SQLite — releases, deployments, sessions
├── transcripts/                           # deprecated: text export from /save
└── agents/
    └── <agent>/
        ├── agent.yaml                     # version: "<semver>"
        ├── instructions.md
        ├── mcp/
        ├── tools/
        └── .cast/
            ├── changes/                    # INTERNAL undo log
            │   ├── changes.json
            │   ├── 001.tar.gz
            │   └── ...
            └── releases/                   # external releases
                ├── releases.json
                ├── 1.0.tar.gz
                └── 1.6.tar.gz
```

Sessions live at `~/.cast/sessions/<id>.json` so they survive
`cast delete <agent>` cleanup that targets the per-agent directory
tree.

---

## CLI Commands

### `cast undo`

```bash
cast undo my-agent                # step back one change
cast undo my-agent --steps 3      # step back three changes
cast undo my-agent --message "..." # optional snapshot message
cast undo my-agent --json         # machine-readable output
```

### `cast redo`

```bash
cast redo my-agent
cast redo my-agent --steps 3
```

### `cast session list`

```bash
cast session list
cast session list --agent my-agent
cast session list --limit 20
cast session list --include-ended=false
cast session list --json
```

### `cast session new`

```bash
cast session new my-agent
cast session new my-agent --name "auth experiment"
cast session new my-agent --mode build --ui-mode dev
```

### `cast session resume`

```bash
cast session resume 19f6c…        # by id
cast session resume auth-exp      # by name
```

### `cast session fork`

```bash
cast session fork <id>
cast session fork <id> --name "alt approach"
```

### `cast session delete`

```bash
cast session delete <id>          # prints confirmation summary
cast session delete <id> --force  # actually deletes
```

### `cast session export` / `cast session import`

```bash
cast session export <id> --out ~/backup.json
cast session import ~/backup.json           # assigns a new id
cast session import ~/backup.json --keep-id # preserves original id
```

### `cast session prune`

```bash
cast session prune                # 30 days
cast session prune --days 7 --force
```

### `cast release` (unchanged)

```bash
cast release my-agent 1.6
cast release my-agent 1.6 --message "..."
```

Auto-changelog content is still pulled from the change log, so the
release-creation flow is unchanged.

---

## TUI Slash Commands

```
/undo [steps]               # back one (or N) changes
/redo [steps]               # forward one (or N) changes

/session [list|new|resume|rename|fork|delete]
/session-list               # modal picker (90%/80%/centered, per AGENTS.md)
/session-new [name]         # starts fresh and switches the chat
/session-resume [id|name]   # opens picker if no arg
/session-rename <id> <name>
/session-fork [name]        # fork current session
/session-delete [id|name]   # default: current
```

All session pickers follow the AGENTS.md design standards.

---

## Migration from the prior system

Users coming from a version prior to this revision see the following
breaking changes:

| Removed | Replacement |
|---|---|
| `cast changes` | `cast undo` (or read the log via Python) |
| `cast diff` | Compare two release tarballs with `tar -tzvf` |
| `cast revert` | `cast undo` |
| `cast restore --change N` | `cast undo --steps N` |
| `/changes` slash command | `/undo` / `/redo` |
| `/diff` slash command | (removed; use git or release comparison) |
| `/restore --change N` | `/undo` / `/redo` |

The underlying change log directory and tarballs are preserved. The
log is now an implementation detail, no longer surfaced as a
first-class concept.

---

## Open Questions / Future Work

1. **Per-session checkpointing.** Should `cast session` be able to
   fork the *agent* (not just the conversation) at a specific release
   version? Today the session records `agent_version_at_start` but
   doesn't rewind.

2. **Compaction.** Long sessions accumulate. Should sessions be
   auto-compacted above some threshold (e.g. > 500 messages) with a
   summary appended? A `cast session compact` command could match
   Claude Code's `/compact`.

3. **Sharing.** `cast session export` produces a JSON file. Should
   there be a `cast session share <id>` that uploads to a Cast cloud
   service and returns a URL? Out of scope for this revision.

4. **Multi-agent sessions.** A session is currently bound to a single
   `agent_name`. Multi-agent sessions (a conversation that hops
   between agents) would require a small schema change to allow
   `agent_name: string | null` and a per-message `agent` field.
