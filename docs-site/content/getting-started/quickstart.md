---
title: Quick start
section: getting-started
order: 2
description: Create your first agent, run it, and deploy it in under five minutes.
ref: ['cli:new', 'cli:dev', 'cli:list', 'cli:deploy', 'cli:connect', 'cli:describe']
---

# Quick start

This walks through the four most common Cast actions: create, run, deploy, and
inspect. Each step links to a longer page if you want the full story.

## 1. Set your OpenRouter key

Cast ships with OpenRouter as the default LLM provider. Set the API key in
your shell or in `~/.cast/config.yaml`:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## 2. Create an agent

The `{% ref "cli:new" %}` command launches an interactive wizard that talks to
the Builder Agent. Describe what you want in plain language and the wizard
scaffolds a complete agent.

```bash
cast new
```

The wizard will:

1. Ask what the agent should do.
2. Suggest a name (you can override).
3. Create the scaffold (`agent.yaml`, `instructions.md`, `tools/`, `mcp/`,
   `tests/`).
4. Write meaningful initial instructions.
5. Optionally configure MCP integrations and pick a model.

## 3. Run it locally

`{% ref "cli:dev" %}` boots the agent as an A2A server on a local port and
attaches the TUI chat. Without arguments, this is the same as `cast new` for a
freshly created agent.

```bash
cast dev email-assistant
```

You should see the TUI welcome screen. Type a message and press Enter — the
agent replies over streaming A2A. Slash commands are available in the input
(`/help` for the list).

Want a headless run without the TUI?

```bash
cast dev email-assistant --no-tui
```

## 4. List and inspect

`{% ref "cli:list" %}` shows every agent on this machine along with whether
it is running locally or deployed. `{% ref "cli:describe" %}` shows the full
configuration of a single agent.

```bash
cast list
cast describe email-assistant
```

## 5. Deploy

Pick a provider and `{% ref "cli:deploy" %}` does the rest — build, ship, and
record a unique deployment SHA you can target with later commands.

```bash
cast deploy email-assistant --provider railway
cast deploy email-assistant --provider fly
cast deploy email-assistant --provider digitalocean
cast deploy email-assistant --provider docker
```

Each provider has its own prerequisites; see the [deployment overview](../building-agents/deployment/overview)
or the per-provider pages.

## 6. Connect to the running deploy

`{% ref "cli:connect" %}` opens a TUI chat session against the deployed
agent. Pass a deployment SHA to disambiguate when an agent has been deployed
to multiple places.

```bash
cast connect email-assistant
cast connect abc123        # by deployment SHA
```

## What's next

- [Concepts](concepts) — the Builder / Runtime model, A2A, and how
  Cast tracks agent state.
- [Global settings](global-settings) — `~/.cast/config.yaml`, env vars,
  secrets.
- [Build an agent end-to-end](../building-agents/development-workflow/workflow)
  — the dev loop, from `cast new` to a deployed agent.
- [Versioning](../building-agents/versioning/overview) — the undo log
  and `cast git`, and when to use which.
- [Deployment](../building-agents/deployment/overview) — multi-deployment,
  SHAs, providers.
