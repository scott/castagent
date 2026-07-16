---
title: Versioning overview
section: versioning
order: 1
description: How Cast tracks agent state — undo log, releases, and sessions.
ref: ['cli:undo', 'cli:redo', 'cli:release', 'cli:releases', 'cli:session', 'cli:deploy', 'cli:upgrade']
---

# Versioning overview

Cast tracks an agent with **three independent concepts**, each
deliberately separated. Mixing them up is the most common source of
confusion for new users.

| | Undo log | Releases | Sessions |
|---|---|---|---|
| **Created by** | Cast, automatically, on every modification | You, explicitly, via `cast release` | Cast, automatically, on every chat turn |
| **Identified by** | sequential id (1, 2, 3…) | semantic version (`1.0`, `1.6`, `2.0`) | session id (sortable ULID) + optional name |
| **Stored in** | `~/.cast/agents/<name>/.cast/changes/` | `~/.cast/agents/<name>/.cast/releases/` | `~/.cast/sessions/<id>.json` + `cast.db` |
| **User-facing?** | no — internal to `cast undo` | yes — the deployment artifact | yes — saved conversations |
| **Purpose** | undo/redo the agent's files | deploy a known-good snapshot | resume, fork, and audit conversations |
| **Visible via** | `{% ref "cli:undo" %}`, `{% ref "cli:redo" %}` | `{% ref "cli:releases" %}`, `{% ref "cli:release" %}` | `{% ref "cli:session" %}` |

## The mental model

- The **undo log** is "what I just edited". It happens automatically
  whenever the Builder or `cast update` saves a new state. The log is
  internal — you don't manage it directly. You interact with it through
  `cast undo` and `cast redo` (or `/undo` and `/redo` in the TUI).

- A **release** is "what I'm shipping". You choose to make a release
  when the agent is good enough to deploy. Releases are deliberate,
  semver'd, and they are the artifact `cast deploy` ships.

- A **session** is a saved conversation. Cast creates a session the
  first time you chat with an agent, and appends every user/agent
  message to it. You can resume, rename, fork, or delete sessions with
  `cast session …` (or `/session …` in the TUI). Sessions are
  independent of agent state — restoring the agent to an older state
  does not invalidate existing sessions.

## Lifecycle of a single feature

```
  edit in Builder (or cast update)
        |
        v
  +-----------+   cast undo
  | undo log  | <---------  (step back through edits)
  | v6, v7,   |
  | v8, v9    | --------->  cast redo (bring them back)
  +-----------+   (or cast release 1.6)
        |
        v
  +-----------+   cast deploy --version 1.6
  | releases/ | -------------------------> +-----------+
  | 1.5, 1.6  |                              |  deploy   |
  +-----------+                              |  v1.6     |
                                             +-----------+
```

1. You edit the agent. Cast records an entry in the undo log.
2. You're ready to ship. `cast release email-agent 1.6` snapshots the
   current state into `releases/1.6.tar.gz`, updates `agent.yaml`'s
   `version: "1.6"`, and auto-generates a changelog from the changes
   since the last release.
3. `cast deploy email-agent --version 1.6` ships `1.6.tar.gz` to your
   chosen provider. A deployment SHA is recorded.
4. Tomorrow you keep editing — more entries land in the undo log. The
   deployment is still on `1.6` until you `cast upgrade <sha> --version 1.7`.

Meanwhile, every chat you have with the agent is being saved into a
**session**. When you want to pick up where you left off (or fork off
in a new direction), you open a session:

```
  open `cast` or run `cast session list`
        |
        v
  pick a session (or create a new one)
        |
        v
  +-----------+   /session fork   +-----------+
  | session A | -------------->  | session B |
  | 12 msgs   |                  | 12 msgs   |  (same history, can diverge)
  +-----------+                  +-----------+
```

## How `cast deploy` chooses a version

`{% ref "cli:deploy" %}` without `--version` deploys the *current working
state* — literally the files in `~/.cast/agents/<name>/` right now,
whether or not they correspond to a release. This is recorded as
`deployed_version: "latest"` in the database.

If you pass `--version 1.6`, Cast extracts the `1.6.tar.gz` from
`releases/` over the working tree before building. The deployment is
recorded as `deployed_version: "1.6"`.

## When to create a release

A release is right when **at least one of these is true**:

- The agent is going to be deployed to a long-lived environment.
- You want to talk about "version 1.6" in conversation, in a
  CHANGELOG, or in a rollback plan.
- You're going to A/B test this version against the next one.

A release is overkill for:

- A throwaway scratch agent you'll delete in an hour.
- A local-only workflow where the working state *is* the artifact.

## Undo/redo vs. release rollback

`cast undo` and `cast restore --release 1.6` are different tools:

- `cast undo` walks the undo log backward one step at a time. It is
  designed for *in-development* iteration. A new edit clears the redo
  path (standard editor behavior).

- `cast restore --release 1.6` extracts a known release tarball over
  the working tree. It is designed for *going back to a known good
  state* in production.

A release can be undone too, but the audit trail of an undo is more
forgiving: it's an entry in the log, not a separate tarball.

## Sessions vs. releases

Sessions and releases are **independent**. A session is the
conversation; a release is the agent definition. Restoring the agent
to a different release does not delete or modify any session. Sessions
are scoped by `agent_name` (not by release), and `agent_version_at_start`
is recorded when a session is created for reference.

When you `cast delete <agent>`, all of that agent's sessions are
cascade-deleted (along with releases, deployments, MCP configs, and
the local agent row). The `~/.cast/sessions/<id>.json` files are
removed at the same time.
