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
cast model anthropic/claude-sonnet-4.6
cast model openrouter/minimax/minimax-m2.5
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
✓ Builder model set to: anthropic/claude-sonnet-4.6
  Restart the builder to take effect (run `cast dev <agent>` again).
```

`--list` prints one model id per line. `--list --json` prints the same
records as the docs model catalog: `id`, `provider`, and `family`.
`--current --json` prints the raw id, for example
`{"id":"openrouter/minimax/minimax-m2.5"}`.

OpenRouter accepts only ids from that curated list. A single leading
`openrouter/` on one of those ids is also accepted and stored as given.
`cast model openrouter/minimax/minimax-m2.5` writes the shipped default
back, which is the id `cast model --current` prints on a fresh install.
`cast model minimax/minimax-m2.5` writes the catalog id without that
prefix. Both select the same model, and either stored string can be
passed to `cast model` again. An unknown OpenRouter id exits non-zero and
the message includes the available ids. There is no custom-id escape hatch
for OpenRouter.
If `~/.cast/config.yaml` is not valid YAML, the
command exits non-zero and tells you to fix the file or delete it. It
does not overwrite a broken file. If the file cannot be written, the OS
error is printed.

`OPENROUTER_API_KEY` is still required for a live OpenRouter call. Without
it, the builder stays in echo mode. A stored id such as
`anthropic/claude-sonnet-4.6` is sent to
`https://openrouter.ai/api/v1/chat/completions`.

The active provider follows the prefix on `defaults.builder_model`.
`cast model digitalocean/llama3.3-70b-instruct` switches to DigitalOcean
when that provider is enabled, and a freeform provider accepts any
`<prefix>/<id>`. A provider that is not enabled exits non-zero and tells
you to run `cast provider enable <key> --token -`. It does not write the
config.

`cast provider digitalocean` switches the builder to DigitalOcean
serverless inference when that provider is enabled. `cast model` and
`/model` then list that provider's models. The list is loaded from
`GET <base-url>/models`. A custom base URL comes from
`cast provider enable digitalocean --token - --url <api-url>`.
`--token -` reads the key from stdin. When the live list cannot be loaded,
the picker shows `llama3.3-70b-instruct` and `deepseek-v3.2`. See
[Global settings](getting-started/global-settings).

## Prefixes

The model id selects the provider. The longest registered prefix wins.

`openai/gpt-4o`, `anthropic/claude-sonnet-4.6`, `google/gemini-2.5-pro`,
and `x-ai/grok-2` stay on OpenRouter, as do the other OpenRouter vendor
ids (`meta-llama/`, `kimi/`, `minimax/`, `deepseek/`, `mistralai/`,
`cohere/`, `perplexity/`). A bare alias such as `claude-sonnet-4` also
stays on OpenRouter.

These prefixes are reserved for a direct provider and are not registered
yet: `openai-api/`, `anthropic-api/`, `gemini/`, `bedrock/`, `ollama/`,
and `xai/`. `cast model openai-api/gpt-4o` exits non-zero. The message
says that prefix is reserved and that `openai/gpt-4o` still uses
OpenRouter. `xai/grok-2` names `x-ai/grok-2` the same way. An unknown
prefix such as `unknown/model`, and a bare id OpenRouter does not already
accept such as `gpt-5` or `not-a-real-model`, is also an error. That
error names the prefix convention. It does not list the OpenRouter
catalog. `cast model openrouter/not-a-real-model` is still an unknown
OpenRouter id, and that message includes the available ids. The config
is not written.

OpenRouter and DigitalOcean both use one OpenAI-compatible provider.
Their prefixes, keys, and model lists are unchanged. A future
OpenAI-compatible provider is a row in `python/cast/providers/manifest.json`.
The builder still requests temperature `0.7` for both current providers,
and omits temperature for models that reject it.

## TUI

`/model` is registered only in dev mode (`cast dev`, and the builder
launched by `cast new` / `cast edit`). It is hidden from `/help` in
production and on-host. See
[Modes](building-agents/development-workflow/tui/modes).

Typing `/model` opens a modal titled "Builder Model". The list comes from
`cast model --list --json`, sorted alphabetically by the full id. The
modal shows a window of that list and keeps the selected row on screen.
Each catalog id is one row. The window is short enough to fit in the
modal, so Up and Down reach every id from `cast model --list` without
skipping a row or leaving characters from the previous frame on the
next id. The current row is marked `(current)` and starts selected. A stored id
with a leading `openrouter/` matches the same catalog id, so the default
`openrouter/minimax/minimax-m2.5` selects `minimax/minimax-m2.5`. Up and
down wrap. Enter on a different model runs `cast model <id>`. Enter on
the current model does nothing. ESC closes the modal and returns focus
to the input.

On success the chat shows:

```text
Builder model changed to anthropic/claude-sonnet-4.6.
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
