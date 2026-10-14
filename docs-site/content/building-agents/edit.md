---
title: Edit an agent
section: building-agents
order: 3
description: Modifying an existing agent in the Builder, with cast update, or by hand.
ref: ['cli:edit', 'cli:update', 'slash:update', 'cli:dev']
---

# Edit an agent

There are three ways to modify an agent after the initial `cast new`:

1. **The Builder** (`cast edit`, `{% ref "slash:edit" %}`) — interactive,
   conversational, best for substantial changes to instructions, tools,
   or MCP integrations.
2. **`{% ref "cli:update" %}`** and `{% ref "slash:update" %}`, for precise, atomic
   mutations of `agent.yaml` (model, permissions, requirements, etc.).
3. **Hand edit** — `vim agent.yaml` then `cast dev` to reload. Best for
   one-off tweaks you understand.

## Builder

```bash
cast edit email-assistant
```

Inside the TUI, the Builder loads the current `agent.yaml` and welcomes
you with a summary of what's there. Every save writes a new entry to
the internal change log at
`~/.cast/agents/<name>/.cast/changes/`, so the agent state is
fully recoverable via [cast undo / cast redo](building-agents/versioning/undo).

`/edit` is also a slash command — use it inside any TUI session (during
`cast dev` or `cast connect`) to drop into the Builder without losing
your chat context.

## `cast update`

For atomic changes, `cast update` is faster and scriptable:

```bash
# Change the model
cast update email-assistant --model openrouter/anthropic/claude-sonnet-4.6

# Add a tool, remove another
cast update email-assistant --add-tool bash --remove-tool glob

# Tighten a permission
cast update email-assistant --permission bash=ask --permission glob=deny

# Replace the system prompt
cast update email-assistant --instructions-text "You are a concise email assistant."

# Or load the prompt from a file
cast update email-assistant --instructions ./new-prompt.md

# Add a Python requirement (used by the next cast deploy)
cast update email-assistant --add-requirement requests

# See what would change without writing
cast update email-assistant --model openrouter/openai/gpt-4o --dry-run
```

`cast update` rejects a value it cannot store, prints the error, and exits
non-zero. `agent.yaml` is left unchanged, including when `--dry-run` is set.

- Permission levels are `always-allow`, `ask`, and `deny`.
- Model ids use the same known list and the same error text as `cast model`.
  A leading `openrouter/` prefix is still accepted, including the shipped
  default `openrouter/minimax/minimax-m2.5`. Providers that accept any model
  id, such as `digitalocean/`, are still accepted.
- Python versions are `3.11` and `3.12`.

Every `cast update` call writes a new entry to the agent's internal
change log with an "Updated: …" message describing what changed. The
log is internal. To step backward or forward through it, use
[cast undo / cast redo](building-agents/versioning/undo) (or `/undo` / `/redo` in the
TUI).

## TUI

`{% ref "slash:update" %}` updates the agent open in this TUI. In `cast dev`
and `cast edit` that is the agent on screen. In `cast new`, it is the agent
the wizard just created. Before an agent exists, the command replies
`No agent is loaded.`

With no arguments, `/update` opens a modal titled `Update: <agent>`. Up and
down wrap through the fields. The selected row starts with `▸`. Enter opens
a text prompt or a choice list (tools, Python version, permission level).
Enter again runs `cast update <agent>` with that one flag. ESC steps back,
and from the field list it closes the modal and returns focus to the input.

You can also pass the CLI flags directly:

```text
/update --model openrouter/anthropic/claude-sonnet-4.6
/update --description A short summary
/update --add-tool bash --permission bash=ask
```

A value `cast update` cannot store is shown in the modal, or in the chat
when the flags were typed. `agent.yaml` is left unchanged. The running
process keeps the configuration it started with, so restart it with
`cast dev <agent>` after a successful write. `/update` is hidden on-host.
It does not redeploy a live agent.

## Hand edit

```bash
cd ~/.cast/agents/email-assistant
$EDITOR agent.yaml
cast dev email-assistant     # reloads on next start
```

Cast does not parse `agent.yaml` and offer structural validation when you
hand-edit, so be careful with YAML syntax. A bad file makes the agent
fail to start; the runtime will print the YAML error in the TUI header
and refuse to load. Fix and re-run.

For a quick syntax check:

```bash
python3 -c "import yaml; yaml.safe_load(open('agent.yaml'))"
```

## When the Builder prompts for a release

If the agent is [deployed](building-agents/deployment/overview) and the Builder detects
that your edit materially changes the agent (model, instructions, tools,
permissions), it will offer to create a [release](building-agents/deployment/releases)
after the save. That's the recommended path if you intend to deploy
the new state.

If you say "Skip" the changes are saved locally only — they're in
`changes/` but not in `releases/`. Run `cast release <name> <ver>` later
when you're ready.
