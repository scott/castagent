---
title: Versioning overview
section: versioning
order: 1
description: Why Cast has two version tracks — automatic changes and intentional releases.
ref: ['cli:changes', 'cli:releases', 'cli:release', 'cli:diff', 'cli:restore', 'cli:upgrade', 'cli:deploy']
---

# Versioning overview

Cast tracks every agent with **two parallel version tracks**. This is
deliberate; mixing them up is the most common source of confusion for new
users.

| | Changes | Releases |
|---|---|---|
| **Created by** | Cast, automatically, on every modification | You, explicitly, via `cast release` |
| **Identified by** | sequential integer (`v3`, `v4`, `v5`…) | semantic version (`1.0`, `1.6`, `2.0`) |
| **Stored in** | `~/.cast/agents/<name>/.cast/changes/` | `~/.cast/agents/<name>/.cast/releases/` |
| **Purpose** | debugging, diff, rollback during development | production deploys, external API |
| **Visible via** | `cast changes <name>`, `{% ref "slash:changes" %}` | `cast releases <name>`, `{% ref "slash:releases" %}` |
| **Deletable** | no — append-only | no — releases are permanent |

## The mental model

- A **change** is "what I just edited". You don't choose to make a change —
  it happens whenever the Builder or `cast update` saves a new state of
  `agent.yaml` or `instructions.md`. Changes are cheap, automatic, and
  internal.
- A **release** is "what I'm shipping". You choose to make a release when
  the agent is good enough to deploy. Releases are deliberate, semver'd,
  and they are the artifact `cast deploy` ships.

If you've used `git commit` vs. `git tag`, the analogy is exact:
changes are commits, releases are tags.

## Lifecycle of a single feature

```
  edit in Builder (or cast update)
        |
        v
  +-----------+   cast release 1.6
  | changes/  | -------------------> +-----------+
  | v6, v7,   |                      | releases/ |
  | v8, v9    |                      | 1.5, 1.6  |
  +-----------+                      +-----------+
                                           |
                                           | cast deploy --version 1.6
                                           v
                                     +-----------+
                                     |  deploy   |
                                     |  v1.6     |
                                     +-----------+
```

1. You edit the agent. Cast records v6, v7, v8 in `changes/`.
2. You're ready to ship. `cast release email-agent 1.6` snapshots the
   current state into `releases/1.6.tar.gz`, updates `agent.yaml`'s
   `version: "1.6"`, and auto-generates a changelog from v6..v8.
3. `cast deploy email-agent --version 1.6` ships `1.6.tar.gz` to your
   chosen provider. A deployment SHA is recorded.
4. Tomorrow you keep editing — v9, v10 land in `changes/`. The deployment
   is still on `1.6` until you `cast upgrade <sha> --version 1.7`.

## How `cast deploy` chooses a version

`{% ref "cli:deploy" %}` without `--version` deploys the *current working
state* — literally the files in `~/.cast/agents/<name>/` right now, whether
or not they correspond to a release. This is recorded as `deployed_version:
"latest"` in the database.

If you pass `--version 1.6`, Cast extracts the `1.6.tar.gz` from
`releases/` over the working tree before building. The deployment is
recorded as `deployed_version: "1.6"`.

## When to create a release

A release is right when **at least one of these is true**:

- The agent is going to be deployed to a long-lived environment.
- You want to talk about "version 1.6" in conversation, in a CHANGELOG, or
  in a rollback plan.
- You're going to A/B test this version against the next one.

A release is overkill for:

- A throwaway scratch agent you'll delete in an hour.
- A local-only workflow where the working state *is* the artifact.

## The migration from the old system

If you have agents from before 1.0, you may have a `versions/` directory
instead of `changes/`, and a `cast versions` alias that prints releases.
`{% ref "cli:migrate" %}` converts the old format in place. The
`cast versions` alias still works but prints a deprecation warning — use
`cast changes` for automatic history and `cast releases` for semantic
versions.
