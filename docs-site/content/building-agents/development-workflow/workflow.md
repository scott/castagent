---
title: Build an agent end-to-end
section: building-agents
group: development-workflow
order: 1
description: A guided tour from idea to a deployed agent. Each step links to the reference page for the depth.
ref: ['cli:new', 'cli:edit', 'cli:dev', 'cli:release', 'cli:deploy', 'cli:connect', 'cli:upgrade']
---

# Build an agent end-to-end

A worked example: you go from "I want an agent" to "I'm chatting
with the deployed version" in seven steps. Each step is one command
and a link to the page that documents the depth.

## 1. Scaffold the agent

```bash
cast new
```

`cast new` launches the Builder wizard. Tell it what the agent
should do, and it writes the scaffold to
`~/.cast/agents/<name>/`.

See [Create an agent](building-agents/create) for the wizard reference and
[Agent anatomy](building-agents/anatomy) for the resulting directory layout.

## 2. Refine it

```bash
cast edit <name>
```

`cast edit` re-opens the Builder against an existing agent. Adjust
the model, instructions, tools, and permissions until the agent
behaves the way you want.

See [Edit an agent](building-agents/edit).

## 3. Test it in the TUI

```bash
cast dev <name>
```

`cast dev` boots the runtime locally and drops you into the TUI.
Chat with the agent, try `/mode` to switch between PLAN and BUILD,
and use `/undo` / `/redo` if it goes off the rails.

See [TUI overview](building-agents/development-workflow/tui/overview),
[TUI modes](building-agents/development-workflow/tui/modes), and
[Slash commands](tui/slash-commands).

## 4. Make a release

```bash
cast release <name> 1.0
```

`cast release` snapshots the current state into
`releases/1.0.tar.gz` and updates `agent.yaml`'s `version`. The
auto-generated changelog is your record of what changed since the
last release.

See [Releases](building-agents/deployment/releases).

## 5. Ship it

```bash
cast deploy <name> --version 1.0
```

`cast deploy` packages the release tarball into a container and
pushes it to your provider. A unique deployment SHA is returned.

See [Deployment overview](building-agents/deployment/overview).

## 6. Chat with the deployed agent

```bash
cast connect <name>
```

`cast connect` opens the TUI against the deployed A2A server. The
header shows the deployed version (e.g. `v1.0`).

See [Connect, shutdown, upgrade](building-agents/deployment/lifecycle).

## 7. Iterate

```bash
cast edit <name>            # tweak
cast release <name> 1.1     # snapshot
cast upgrade <name> --version 1.1   # redeploy in place
```

Edit the agent locally, make a new release, and push it without
losing any persistent memory — `cast upgrade` redeploys but keeps
the same volume mount.

See [Connect, shutdown, upgrade](building-agents/deployment/lifecycle).

## Where to go next

You now have the full loop. The reference pages you'll come back to:

- **Capabilities** — add [Custom tools](configuration/custom-tools)
  and [MCP servers](configuration/mcp-servers) when the agent
  needs to do more than chat.
- **Memory** — [Persistent memory](configuration/persistent-memory)
  explains the volume that survives deploys and upgrades.
- **Sessions** — [Sessions](building-agents/development-workflow/sessions)
  covers resume, fork, and auditing conversations.
- **History** — [Versioning overview](building-agents/versioning/overview)
  ties together the undo log and
  [versioning with Git](building-agents/versioning/git).
- **Full CLI** — [Command reference](cli/reference) lists every
  `cast <subcommand>` with flags and examples.
