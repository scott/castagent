---
title: Concepts
section: getting-started
order: 3
description: 'The mental model behind Cast: Builder, Runtime, A2A, and the two version tracks.'
ref: ['cli:new', 'cli:dev', 'cli:deploy']
---

# Concepts

Cast is a small set of cooperating pieces. Once you have the model in your
head, the rest of the documentation is just a list of which knob does what.

## The agent lifecycle

```
  describe   create   run locally   ship   chat with deploy
   ┌──┐  ┌──┐  ┌──┐  ┌──┐  ┌──┐  ┌──┐
   │  │  │  │  │  │  │  │  │  │  │  │
   ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼
 user prompt
        |
        v
  Builder Agent  (interactive, LangChain over stdio JSON-RPC)
        |
        | creates scaffold at ~/.cast/agents/<name>/
        v
  Runtime Agent  (A2A over HTTP, runs locally or in a container)
```

1. You describe what the agent should do in plain English.
2. The **Builder Agent** (a Python/LangChain process) talks back, asks
   clarifying questions, and writes the agent scaffold to
   `~/.cast/agents/<name>/`.
3. The **Runtime Agent** (also Python/LangChain) loads that scaffold and
   exposes an A2A server on a local port.
4. The TUI (or any A2A client) chats with the runtime.
5. When you're happy, `cast deploy` packages the agent and ships it to a
   hosting provider.

## Builder vs. Runtime

| | Builder | Runtime |
|---|---|---|
| **Purpose** | Helps you *create* agents | *Runs* the agents you've created |
| **Transport** | stdio JSON-RPC | A2A over HTTP (port 10000–65535 locally) |
| **Tools** | `create_agent`, `update_config`, `install_mcp`, `recommend_model`, `list_agents` | `bash`, `read`, `glob`, plus MCP servers you've added. `tools.custom` is printed by `cast describe` and is not imported |
| **Auth** | none (local only) | bearer token in production, none locally |
| **User interface** | the TUI you see during `cast new` / `cast edit` | the TUI you see during `cast dev` / `cast connect` |
| **Skills** | `~/.cast/builder/skills/<name>/SKILL.md` is appended to the builder prompt. These skills guide creation and editing. They apply on the next `cast new` or `cast edit`. | Builder skills are not runtime skills. The runtime agent does not load them. |

## A2A, briefly

A2A is the [Agent-to-Agent protocol](https://github.com/anthropics/agent-card) —
a JSON-RPC-flavoured HTTP interface that lets any client talk to any agent.
Every runtime agent exposes an `AgentCard` describing its name, skills, and
endpoints; the TUI discovers the card on connect and uses it for
`/help`-style introspection.

For Cast, this means:

- Your agent is not locked to Cast's TUI — any A2A client can talk to it.
- The same agent runs locally, on Railway, on Fly, on DigitalOcean
  Droplets, on DigitalOcean MicroVMs, on Sprites, or in a plain Docker
  container.
- Bearer-token auth is added only when the agent is deployed.

## Undo log, Releases, and Sessions

Cast tracks **three independent concepts** for an agent. This is the
single most important idea to internalise.

- The **undo log** is automatic. Every time the Builder or `cast update`
  modifies an agent, Cast snapshots the working tree as a tarball in
  `~/.cast/agents/<name>/.cast/changes/`. They are sequential (v1,
  v2, v3…) and are consumed by `cast undo` / `cast redo` (or
  `/undo` / `/redo` in the TUI) and by `cast release`'s auto-changelog
  generator. See [Versioning overview](building-agents/versioning/overview).
- **Releases** are intentional. You create a release with
  `cast release <agent> 1.6` and the agent's tarball is stamped with a
  semantic version. Releases are the *deployment artifact* — when you
  `cast deploy`, you're shipping a release. See [Releases](building-agents/deployment/releases).
- **Sessions** are saved conversations. Connecting to an agent
  (`cast connect`, `/connect`, or the on-host TUI) starts a new
  session with an empty model context. Cast auto-saves every chat
  turn into that session. Continuing an old conversation is an
  explicit resume: `cast session resume` (or `/session resume`, or
  `Enter` / `R` in `/sessions`) loads that transcript back into the
  model. `cast session fork` branches into a parallel thread, and
  `cast session export` backs up the transcript. See
  [Sessions](building-agents/development-workflow/sessions).

## Multi-deployment and the deployment SHA

An agent can be deployed to many places at once (Railway + Fly, multiple
versions for A/B testing, etc.). Cast identifies each deployment with a
6-character SHA so commands can target a specific instance:

```bash
cast deploy email-agent --provider railway
cast deploy email-agent --provider fly
cast connect abc123        # the railway one
cast connect def456        # the fly one
cast shutdown abc123
```

The SHA is generated from `SHA256(agentName + timestamp + randomBytes)` and
is stable for the life of that deployment.

## Where things live

```
~/.cast/
├── config.yaml                # global config
├── cast.db                    # SQLite: agents, releases, deployments
├── vault/<agent>/             # OAuth credentials (filesystem, mode 0600)
├── tokens/<agent>.token       # bearer tokens (keychain)
├── builder/                   # Builder Agent's instructions and tools
│   ├── instructions.md        # builder system prompt
│   ├── tools/
│   └── skills/                # skills that guide creation; not runtime skills
│       └── <name>/SKILL.md
└── agents/<name>/
    ├── agent.yaml             # the agent's config
    ├── instructions.md        # the agent's system prompt
    ├── tools/                 # custom Python tools
    ├── mcp/                   # MCP server configs
    ├── tests/                 # cli + agent test scenarios
    └── .cast/
        ├── changes/           # automatic snapshots (changes.json + *.tar.gz)
        └── releases/          # semantic releases (releases.json + *.tar.gz)
```

That layout is stable; treat it as Cast's data model.
