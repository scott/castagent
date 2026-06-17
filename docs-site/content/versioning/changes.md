---
title: Changes
section: versioning
order: 2
description: Automatic change history — what every edit looks like on disk.
ref: ['cli:changes', 'cli:diff', 'cli:restore']
---

# Changes

Every time the Builder Agent or `cast update` mutates an agent, Cast writes
a new tarball to `~/.cast/agents/<name>/.cast/changes/` and appends a row
to `changes.json`. The result is a complete, append-only history of "what
the agent looked like at v3, v4, v5, …".

## Listing changes

```bash
cast changes email-assistant
```

Output:

```
Agent: email-assistant
Current change: 8

Change History:
─────────────────────────────────────────────────────────────
  v1   5/9/2026 6:26:28 PM   [CREATED]    Initial version
  v2   5/9/2026 6:26:52 PM   [BUILDER]    Updated agent configuration
  v3   5/9/2026 6:28:02 PM   [BUILDER]    Updated agent configuration
  v4   5/9/2026 6:28:12 PM   [BUILDER]    Updated instructions
  v5   5/9/2026 9:35:20 PM   [BUILDER]    Updated agent configuration
  v6   5/11/2026 8:12:05 AM  [BUILDER]    Updated: model: minimax/minimax-m2.5
  v7   5/12/2026 1:04:00 PM  [BUILDER]    Updated: tool: gmail
  v8   5/12/2026 1:08:33 PM  [BUILDER]    Updated: permissions: bash=ask
─────────────────────────────────────────────────────────────
```

The `[SOURCE]` column tells you *who* created the change:

- `CREATED` — initial scaffold from the Builder.
- `BUILDER` — a `cast edit` conversation.
- `CLI` — `cast update --…` from the command line.
- `GIT` — `cast git commit` (if you've initialized a repo).

## Diffs

```bash
cast diff email-assistant --change 3 --change 5
```

`{% ref 'cli:diff" %}` shows the file-level difference between two changes.
This is the fastest way to answer "what did I actually change between
yesterday and today?".

In the TUI, `{% ref 'slash:diff" %}` opens a modal that walks you through
the kind (Changes or Releases), then the two items, then renders the diff
inline.

## Restore

```bash
cast restore email-assistant --change 5
cast restore email-assistant --release 1.4
```

`{% ref 'cli:restore" %}` extracts the tarball over the working tree.
**Your current state is preserved first** — Cast snapshots the working
tree as a new change before doing anything, so a `restore` is always
reversible by restoring again.

> Restore does **not** deploy. After restoring, your local files are
> updated but the deployed version is still whatever's running. Run
> `cast deploy` or `cast upgrade` to push the restored state.

In the TUI, `{% ref 'slash:restore" %}` opens a picker (Changes vs
Releases) with a confirmation modal.

## When to look at changes

- "Did my last edit actually save?"
- "What did the agent look like before I started fiddling with the model?"
- "I want to compare two iterations of my system prompt."
- "I want to roll back a bad edit before I ship a release."

## When to ignore changes

Changes are noisy. You don't need to curate them — Cast will keep
appending to `changes/` automatically. If disk space becomes a concern,
delete `~/.cast/agents/<name>/.cast/changes/*.tar.gz` by hand; the
`changes.json` index will keep working.
