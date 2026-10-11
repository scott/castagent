---
title: Create an agent
section: building-agents
order: 2
description: 'Two ways to bring a new agent into existence: the Builder wizard, or cast clone.'
ref: ['cli:new', 'cli:clone', 'cli:dev', 'cli:edit']
---

# Create an agent

There are two paths to a new agent on disk: the **Builder** (interactive,
conversational, scaffolds from a description) and **`cast clone`** (pulls
an existing agent from a Git repository).

## With the Builder

```bash
cast new
```

The Builder Agent asks four things in order:

1. **What should the agent do?** A free-form description. The Builder uses
   this to pick a name, write initial instructions, and recommend a model.
2. **A name.** The Builder suggests one based on your description; you can
   override.
3. **MCP integrations.** For each integration (Gmail, Slack, GitHub, …) the
   Builder writes the YAML config and asks you to authenticate via OAuth
   or API token.
4. **Model.** Defaults to `openrouter/minimax/minimax-m2.5` (configurable
   in `~/.cast/config.yaml`); the Builder recommends alternatives based on
   the agent's likely workload.

When the conversation ends, the agent lives at `~/.cast/agents/<name>/`
with everything wired up. Cast prints a final summary and offers to start
the agent in dev mode.

If you just want to write a one-line description and have Cast pick a name:

```bash
echo "Summarises incoming email and drafts replies." | cast new
```

The Builder reads stdin if no TTY is available.

## From an existing Git repository

```bash
cast clone https://github.com/you/email-agent
cast clone https://github.com/you/email-agent my-local-copy
```

`{% ref "cli:clone" %}` is the right path when:

- You want to ship an agent to teammates via a Git repo.
- You're forking an existing Cast agent.
- You're restoring an agent whose local copy was deleted but the tarballs
  in `.cast/releases/` are still on disk (commit the agent dir, then
  `cast clone` it back into a fresh `~/.cast`).

The clone validates that the repo contains an `agent.yaml` and refuses
non-Cast repositories. After clone, `repository` is added to the local
`agent.yaml` so `cast git push` knows where to send future commits.

## Editing an existing agent

Both `cast new` and `cast edit <name>` are powered by the same Builder. The
only difference is that `cast edit` loads the current `agent.yaml` and
welcomes you back into the conversation with what's already there.

```bash
cast edit email-assistant
```

Inside the TUI you can also use `{% ref "slash:edit" %}` to jump straight
into edit mode without dropping the chat session.

## Naming rules

Agent names must match `[a-zA-Z0-9-]+` and must be unique within
`~/.cast/agents/`. Names become:

- The directory name (`~/.cast/agents/<name>/`)
- The A2A `AgentCard.name` field
- The default Docker container name (`cast-<name>`)
- Part of the deployment SHA seed

Pick something stable — renaming later (`cast rename`) is supported but
the deployment history is keyed by the original name.
