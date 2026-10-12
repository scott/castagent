---
title: Changing the builder model
section: building-agents
order: 6
description: Swap the model the Builder Agent uses. A running builder does not hot-swap.
ref: ['cli:model', 'slash:model', 'cli:dev']
---

# Changing the builder model

The Builder Agent is the model behind `{% ref "cli:new" %}`,
`{% ref "cli:edit" %}`, and `{% ref "cli:dev" %}`. It reads
`defaults.builder_model` from `~/.cast/config.yaml` when that process
starts.

This is not the model stored on an agent you are creating. That lives in
the agent's `agent.yaml` under `brain.model` and is changed with
`{% ref "cli:update" %}` or by asking the Builder to edit the agent.

A running builder does not hot-swap. `cast model` writes the config, and
the next `cast dev`, `cast new`, or `cast edit` uses the new id. The
welcome banner shows the display form (a leading `openrouter/` is
stripped). The API call uses the raw stored id.

## CLI

```bash
cast model
cast model anthropic/claude-3.5-sonnet
cast model --list
cast model --list --json
cast model --current --json
```

With no arguments, `cast model` prints the current raw id, a numbered
list of available models, and `Set with: cast model <model-id>`.

Setting an id updates `defaults.builder_model` and leaves every other key
in `~/.cast/config.yaml` alone. If the file is missing, Cast creates the
same default scaffold `install.sh` writes before `cast new`. The write is
atomic (a temp file, then rename) and the file is read back to confirm.

```text
✓ Builder model set to: anthropic/claude-3.5-sonnet
  Restart the builder to take effect (run `cast dev <agent>` again).
```

`--list` prints one model id per line. `--list --json` prints the same
records as the docs model catalog: `id`, `provider`, and `family`.
`--current --json` prints the raw id, for example
`{"id":"openrouter/minimax/minimax-m2.5"}`.

Only ids from that curated list are accepted. An unknown id exits
non-zero and the message includes the available ids. There is no
custom-id escape hatch. If `~/.cast/config.yaml` is not valid YAML, the
command exits non-zero and tells you to fix the file or delete it. It
does not overwrite a broken file. If the file cannot be written, the OS
error is printed.

`OPENROUTER_API_KEY` is still required for a live OpenRouter call. Without
it, the builder stays in echo mode. A stored id such as
`anthropic/claude-3.5-sonnet` is sent to
`https://openrouter.ai/api/v1/chat/completions`.

An existing `digitalocean/<model-id>` value in the file still selects
DigitalOcean serverless inference. Those catalog ids are not in the
curated `cast model` list, so changing to one means editing the file
directly. See [Global settings](getting-started/global-settings).

## TUI

`/model` is registered only in dev mode (`cast dev`, and the builder
launched by `cast new` / `cast edit`). It is hidden from `/help` in
production and on-host. See
[Modes](building-agents/development-workflow/tui/modes).

Typing `/model` opens a modal titled "Builder Model". The list comes from
`cast model --list --json`, sorted alphabetically by the full id. The
modal shows a window of that list and keeps the selected row on screen.
The current row is marked `(current)` and starts selected. A stored id
with a leading `openrouter/` matches the same catalog id, so the default
`openrouter/minimax/minimax-m2.5` selects `minimax/minimax-m2.5`. Up and
down wrap. Enter on a different model runs `cast model <id>`. Enter on
the current model does nothing. ESC closes the modal and returns focus
to the input.

On success the chat shows:

```text
Builder model changed to anthropic/claude-3.5-sonnet.
Restart the builder to apply: cast dev email-assistant
```

If `cast` is not on `PATH`, the modal stays open and shows
`cast CLI not found in PATH.` If the CLI returns an error, that error is
shown in the chat and the modal stays open.

The builder process that is already running keeps the model it started
with. Start it again to apply the change.

## See also

- [Create an agent](building-agents/create)
- [Global settings](getting-started/global-settings)
- [Run an agent locally](building-agents/run)
