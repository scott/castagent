---
title: Versioning overview
section: building-agents
group: versioning
order: 1
description: How Cast tracks agent state — the undo log and the optional Git history.
ref: ['cli:undo', 'cli:redo', 'cli:git-init', 'cli:git-status', 'cli:git-commit', 'cli:git-log', 'cli:git-diff', 'cli:git-push', 'cli:git-remote', 'slash:git']
---

# Versioning overview

Cast offers **two complementary version tracks** for an agent. They are
deliberately independent. Mixing them up — or assuming one replaces the
other — is the most common source of confusion.

| | Undo log | Git history |
|---|---|---|
| **Created by** | Cast, automatically, on every modification | You, explicitly, via `cast git commit` |
| **Identified by** | sequential id (1, 2, 3…) | Git commit hash (and optional `cast git tag`) |
| **Stored in** | `~/.cast/agents/<name>/.cast/changes/` | `~/.cast/agents/<name>/.git/` |
| **User-facing?** | no — internal to `cast undo` | yes — shareable, durable, browsable |
| **Purpose** | step backwards through in-development edits | backup, sharing, code-level history |
| **Visible via** | `cast undo`, `cast redo`, `/undo`, `/redo` | `cast git log`, `cast git diff`, `cast git push` |
| **Network required?** | no | no (push is optional) |

## The mental model

- The **undo log** is "what I just edited". It happens automatically
  whenever the Builder or `cast update` saves a new state. The log is
  internal — you don't manage it directly. You interact with it through
  `cast undo` and `cast redo` (or `/undo` and `/redo` in the TUI).

- **Git history** is "what I want to keep and share". You choose to
  initialise a repo with `cast git init` and commit checkpoints with
  `cast git commit`. The repo lives at `~/.cast/agents/<name>/.git/`
and can be pushed to any Git host. The undo log is intentionally
excluded from the repo. `cast git init` records those paths in
`.castignore` and `.gitignore`.

## When to use which

| You want to… | Use |
|---|---|
| Step back one edit while iterating | undo log + `cast undo` |
| Recover from a "this used to work" moment after several edits | undo log + `cast undo --steps 5` |
| Share the agent with another machine or collaborator | Git (`cast git push`) |
| Keep a permanent, named version of the agent | [Releases](building-agents/deployment/releases) (a separate concept) |
| Audit who changed what, when | Git (`cast git log`) |
| Operate on a single machine, no sharing needed | undo log only; skip Git |

## Lifecycle of a single feature

```
  edit in Builder (or cast update)
        |
        v
  +-----------+   cast undo
  | undo log  | <---------  (step back through edits)
  | v6, v7,   |
  | v8, v9    | --------->  cast redo (bring them back)
  +-----------+
        |
        |  cast git commit -m "..."
        v
  +-----------+   cast git push
  |  .git/    | ------------------------->  GitHub / GitLab / ...
  +-----------+
```

You typically develop with the undo log (it's free and automatic), then
`cast git commit` periodically to checkpoint work you want to keep
long-term, then `cast git push` to back it up or share it.

## How they interact

The two tracks **never share state**. A `cast git init` does not import
the undo log; a `cast git commit` does not consume or clear undo
entries; `cast undo` does not touch `.git/`. You can use either
independently, both, or neither.

The one cross-cut is `cast release`: when you make a release, Cast
reads the undo log to auto-generate the changelog. The release's
tarball is self-contained and independent of both the undo log and
the Git history.

## Related concepts

- [Releases](building-agents/deployment/releases) — the deployment artifact, a
  semver'd tarball that `cast deploy` ships.
- [Sessions](building-agents/development-workflow/sessions) — saved conversations,
  independent of agent state and of both version tracks.
- [Build an agent end-to-end](building-agents/development-workflow/workflow) — a
  walkthrough that uses the undo log and Git together with the rest
  of the dev loop.
