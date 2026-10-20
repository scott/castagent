---
title: Create an agent
section: building-agents
order: 2
description: 'Bring an agent into existence with the Builder, cast clone, or /import.'
ref: ['cli:new', 'cli:clone', 'cli:dev', 'cli:edit', 'slash:import']
---

# Create an agent

There are three paths to a new agent on disk: the **Builder** (interactive,
conversational, scaffolds from a description), **`cast clone`** (copies an
existing agent from Git or a local directory), and
`{% ref "slash:import" %}` in the TUI.

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
   the agent's likely workload. That recommendation is the new agent's
   model, not the model the Builder itself runs on. To change the Builder,
   see [Changing the builder model](building-agents/builder-model).

When the conversation ends, the agent lives at `~/.cast/agents/<name>/`
with everything wired up. Cast prints a final summary and offers to start
the agent in dev mode. The new agent is also recorded in `~/.cast/cast.db`,
which is what a later deploy attaches its deployment row to.

Inside the same TUI, `{% ref "slash:git" %}`, `{% ref "slash:undo" %}`,
`{% ref "slash:redo" %}`, `{% ref "slash:describe" %}`, and
`{% ref "slash:releases" %}` act on the agent the wizard just created.
Before that agent exists, those commands reply `No agent is loaded.`
`/undo` and `/redo` print the CLI's failure reason in the chat. That
text is not written over the input line.

If you just want to write a description and have Cast pick a name, pipe it
when stdin is not a terminal:

```bash
echo "Summarises incoming email and drafts replies." | cast new
```

`cast new` reads that text and writes the scaffold to
`~/.cast/agents/<name>/`. A `Name: my-agent` label sets the agent name.
Otherwise Cast derives one from the description, so an email assistant
becomes `email-agent`. It records that name in
`~/.cast/cast.db` and prints the agent name and path.
It does not open the TUI. A blank pipe is an error. If the builder
fails, `cast new` prints the builder's own error, including when the
builder exits before it reads the description. On a terminal, the same
command still opens the Builder wizard and asks you to confirm the
name.

You can start the same flow for a name you already chose:

```bash
cast dev email-assistant
```

If `~/.cast/agents/email-assistant` does not exist, the builder asks what
the agent should do and creates that name. `cast new` still picks the
name from your description.

## From an existing Git repository

```bash
cast clone https://github.com/you/email-agent
cast clone https://github.com/you/email-agent my-local-copy
cast clone you/email-agent
```

`you/email-agent` is shorthand for `https://github.com/you/email-agent.git`.

`{% ref "cli:clone" %}` is the right path when:

- You want to ship an agent to teammates via a Git repo.
- You're forking an existing Cast agent.
- You're restoring an agent whose local copy was deleted but the tarballs
  in `.cast/releases/` are still on disk (commit the agent dir, then
  `cast clone` it back into a fresh `~/.cast`).

The clone validates that the repo contains an `agent.yaml` and refuses
non-Cast repositories. After clone, `repository` is added to the local
`agent.yaml` so `cast git push` knows where to send future commits.

A name argument sets the directory under `~/.cast/agents/` and the `name`
field in `agent.yaml`. The runtime and the A2A agent card read that field,
so `cast clone <source> my-local-copy` publishes `my-local-copy` instead of
the source agent's name. Leave the name off and `agent.yaml` keeps the name
from the source.

## From a local directory

A filesystem path is copied into `~/.cast/agents/<name>/`. The name
defaults to the directory's basename.

```bash
cast clone ./path/to/local-agent
cast clone /absolute/path/to/local-agent my-local-name
```

Passing `my-local-name` also sets `name` in the copied `agent.yaml`.

The directory must contain `agent.yaml`. If it does not, clone stops with
`Directory does not contain a Cast agent (missing agent.yaml).` A missing
path reports `Path '<path>' does not exist.` An existing agent is left
unchanged unless you pass `--force`.

If the copy has no git repository, Cast initializes one. Registration is
the directory under `~/.cast/agents/` — `{% ref "cli:list" %}` picks it
up with no separate catalog entry.

Inside a dev or production TUI session, `{% ref "slash:import" %}` opens
a modal titled "Import Cast Agent". Source takes a GitHub URL, `user/repo`,
or a local path (`./relative` or `/absolute`). Name is optional. Enter
submits and ESC closes, returning focus to the chat input. `/import <source>`
skips the modal, and a second argument sets the local name in the directory
and in `agent.yaml`.

On success the TUI reports the agent name and suggests `cast dev`,
`cast edit`, and `cast deploy <name> --provider docker`.

## Check the builder

`cast meta test` runs the scenarios in `~/.cast/meta/scenarios/`. The first
run writes the defaults there, including `create-simple`.

```bash
cast meta test
cast meta test --scenario create-simple
cast meta test --verbose
```

The command starts the Builder with this checkout's virtualenv
(`python/.venv`). It sets `CAST_BUILDER_ECHO=1`, so the scenarios stay on
the offline echo builder even when an API key is configured. A missing
virtualenv falls back to `python3` on `PATH` and prints a warning.

The builder is initialized in harness mode. Scenario text is the user
message. It is not treated as a description of a new agent named
`meta-test`. If the builder process exits, the scenario reports that
exit, including `No module named cast`, instead of waiting and then
printing `Request timeout`.

Each run creates a temporary agents directory and deletes it when the
command finishes, including when a scenario fails. Agents are not written
to `~/.cast/agents/`. Scenario files still refer to paths such as
`~/.cast/agents/email-agent/agent.yaml`. The harness checks those paths
inside the temporary directory. If that file was already present before
the scenario ran, the scenario fails. A leftover agent does not count as
a successful create.

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
