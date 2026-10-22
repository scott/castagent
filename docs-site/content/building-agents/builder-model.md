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
cast model openai-api/gpt-4o
cast model xai/grok-4.7
cast model gemini/gemini-3.8-flash
cast model anthropic-api/claude-sonnet-5-5
cast model digitalocean/llama3.3-70b-instruct
cast model ollama/qwen3
cast model --list
cast model --list --json
cast model --current --json
```

`anthropic/claude-sonnet-4.6` and `openrouter/minimax/minimax-m2.5` stay on
OpenRouter. `openai/`, `anthropic/`, `google/`, and `x-ai/` do too.
`openai-api/`, `xai/`, `gemini/`, `anthropic-api/`, `digitalocean/`, and
`ollama/` call that provider directly. Keys, base URLs, and what deploy
forwards are on [Inference providers](getting-started/inference-providers).
Switch the active provider with [cast provider](getting-started/provider).

`cast model --list` and `/model` list the **active** provider's models, not
every provider at once. OpenRouter shows the curated ids. A provider with a
live catalog loads `GET <base-url><modelsPath>` and shows that row's fallback
ids when the request fails. A freeform provider accepts any `<prefix>/<id>`
once it is enabled. The list is read again each time `/model` opens.

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
[Inference providers](getting-started/inference-providers).

## Prefixes

The model id selects the provider. The longest registered prefix wins.

`openai/gpt-4o`, `anthropic/claude-sonnet-4.6`, `google/gemini-2.5-pro`,
`x-ai/grok-2`, `qwen/qwen3-coder`, and `z-ai/glm-4.6` stay on OpenRouter.
Any slash prefix that is not a registered provider and not reserved uses
OpenRouter too, including vendors that are not in the curated list.
A bare alias such as `claude-sonnet-4` also stays on OpenRouter.
`openai/gpt-4o` stays on OpenRouter when `OPENAI_API_KEY` is set.

`openai-api/gpt-4o` is direct OpenAI. Enable it with
`cast provider enable openai-api --token -`. The key is `OPENAI_API_KEY`.
Requests go to `https://api.openai.com/v1`. Cast does not read
`OPENAI_BASE_URL`. A builder-only URL is
`cast provider enable openai-api --token - --url <https-url>`, stored as
`providers.openai.base_url`. Deploy does not send that URL.
`/model` and `cast model` list chat ids from `GET /models` (gpt-4, gpt-5,
o-series, and chatgpt ids, including fine-tunes). Embedding, TTS, image,
moderation, realtime, audio, transcribe, search, pro, deep-research,
codex, and instruct ids are left out. Search-preview models reject
temperature, so they are not listed. When the
list cannot be loaded, the picker shows `gpt-4o` and `gpt-4o-mini`.
Any other `openai-api/<id>` is accepted. Reasoning models (`o1`, `o3`,
`o4`, `gpt-5`, and the same families) omit temperature. Other OpenAI chat
models use `0.7`.

This prefix is reserved for a direct provider and is not registered
yet: `bedrock/`. `ollama/` is registered and keyless.
`xai/grok-4.7` is direct xAI. `x-ai/grok-2` still uses OpenRouter.
A bare id
OpenRouter does not already accept, such as `gpt-5` or `not-a-real-model`,
is also an error. That error names the prefix convention. It does not
list the OpenRouter catalog. `cast model qwen/qwen3-coder` and
`cast model openrouter/not-a-real-model` are unknown curated ids, and
those messages include the available ids. The config is not written.

Claude 4.7 and later on OpenRouter (opus, sonnet, or haiku, dotted or
dashed, and 5.x) are sent as written and omit temperature. Earlier
aliases such as `claude-opus-4` and `claude-sonnet-4` still pin to 4.5
and 4.6.

OpenRouter, DigitalOcean, OpenAI, xAI, Google Gemini, and Ollama use one OpenAI-compatible provider.
A new provider of that kind is a row in `python/cast/providers/manifest.json`
with `"impl": "openai-compatible"`. The builder requests temperature `0.7`
from each row's `defaultParams`, and omits temperature for models that match
`omitTemperatureModels`.

`xai/<model>` calls `https://api.x.ai/v1` with `XAI_API_KEY`.
`cast provider enable xai --token -` stores that key.
`/model` loads `GET <base-url>/models` and keeps chat ids. Image, video,
voice, embedding, multi-agent, and `latest` aliases are dropped. When the live list
cannot be loaded, the picker shows `grok-4.7`,
`grok-4.20-0309-non-reasoning`, and `grok-4.20-0309-reasoning`.
xAI reasoning ids still receive temperature `0.7`. The row does not send
`stop`, `presence_penalty`, or `frequency_penalty`. `XAI_BASE_URL` is a
builder setting and is not copied onto a deployed agent. Deploy forwards
`XAI_API_KEY` only when `brain.model` uses `xai/`.

`gemini/<model>` is Google Gemini on the same shared class. The key is
`GEMINI_API_KEY` (`cast provider enable gemini --token -`). Requests go to
`https://generativelanguage.googleapis.com/v1beta/openai`. `/model` loads
`GET /models`, drops a leading `models/` from each id, and keeps chat
models (video ids such as `gemini-omni-1.1-flash` are left out). A
hand-typed `gemini/models/<id>` drops that `models/` prefix before the
request. When that list cannot be loaded, the picker shows
`gemini-3.8-flash` and `gemini-3.1-pro-preview`. The builder does not
send temperature. Gemini 3 thinking models are tuned for the API default
of 1.0, and a lower value can loop. Gemini 3 and 4 tool calls include
`extra_content.google.thought_signature`, and Cast echoes that object
from the assistant message on the next request. Concurrent streams on
one client keep their own signatures. `google/gemini-2.5-pro` and the bare
alias `gemini-2.5-pro` stay on OpenRouter. Deploy forwards
`GEMINI_API_KEY` and does not forward `GEMINI_BASE_URL`.

`anthropic-api/<model>` is direct Anthropic. It is not the OpenAI-compatible
class. `cast.providers.anthropic` builds `ChatAnthropic` from the manifest
row. The key is `ANTHROPIC_API_KEY`
(`cast provider enable anthropic-api --token -`). The catalog base URL is
`https://api.anthropic.com/v1`. `ChatAnthropic` receives the host root,
because its SDK appends `/v1/messages`. An exported `ANTHROPIC_BASE_URL`
routes builder calls through that proxy. The value may include `/v1` or
omit it. Chat strips a trailing `/v1`. The model list adds `/v1` when it
is missing, so a Claude Code style host still loads `/v1/models` instead
of the offline ids. `/model` loads
`GET /v1/models?limit=1000&lifecycle=active` with `x-api-key` and
`anthropic-version: 2023-06-01`. If the host returns HTTP 400 or 422
for that query, the list is requested again without it. A timeout or
401 does not retry. Rows that report another lifecycle are
dropped. Rows with no lifecycle field are kept. Ids that start with
`claude-` are kept. Anything else is left out. One response is the whole
list, capped at 1000 ids. When that list cannot be loaded, the picker shows
`claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`.
The builder sends temperature `0.7`. A langchain-anthropic profile that
does not accept temperature omits it. When the profile has no row, the
manifest pattern is the fallback: opus, sonnet, haiku, fable, and mythos
4.7 and later, including `claude-sonnet-5-5`. Earlier ids such as
`claude-sonnet-4-6` still receive `0.7` unless their profile says
otherwise. A known profile supplies `max_tokens`. An unknown id uses
`max_tokens` from `GET /v1/models/{id}` when that field is present, and
otherwise a family floor. Opus 4 and Opus 4.1, including dated
snapshots, use 32000. Claude 3 Haiku and Claude 3 Opus use 4096, which
is their published cap. Other unknown Claude ids use a higher floor so
a long tool-call write is not cut off at 4096. The client
uses a 600 second request timeout. Cast does not force `tool_choice`.
Direct ids are not rewritten: `anthropic-api/claude-sonnet-4` is sent as
`claude-sonnet-4`. `anthropic/claude-sonnet-4.6` and the bare alias
`claude-sonnet-4` stay on OpenRouter. `ANTHROPIC_BASE_URL` is a builder
setting and is not copied onto a deployed agent. Deploy forwards
`ANTHROPIC_API_KEY` only when `brain.model` uses `anthropic-api/`.

`ollama/<model>` is local Ollama on the same shared class. No key is
required, and `cast provider ollama` does not ask for one.
`cast provider enable ollama` with no token is enough to store an optional
URL. Requests go to `http://localhost:11434/v1`. `OLLAMA_BASE_URL` on the
builder can point at another loopback port or at `https://ollama.com/v1`.
Set `OLLAMA_API_KEY` only for Ollama cloud. The chat client sends the
placeholder `ollama` when that key is absent, so the request does not use
an empty Bearer token. `/model` loads `GET <base-url>/models` (Ollama's
OpenAI-compatible `/v1/models`) with no token and lists the ids Ollama
reports, including a tag such as `llama3.1:8b`. Embedding names such
as `nomic-embed`, `mxbai-embed`, `paraphrase-multilingual`, `all-minilm`, and
`snowflake-arctic-embed` are left out of the chat list. A `bge` name is
left out when it starts with `bge` or contains `-bge-` or `bge-m3`. When Ollama
answers, `cast provider ollama` keeps `ollama/qwen3` only if that pull is
present (`qwen3` and `qwen3:latest` are the same pull; `qwen3:8b` is not)
and otherwise stores the first pulled chat model. When Ollama does not
answer, it stores `ollama/qwen3` and prints `ollama pull qwen3`. `qwen3`,
`llama3.1`, and `gpt-oss` are starting points. Tool calling depends on
the model you pull. Ollama's default context length is 4096 tokens, and
the builder prompt starts near 1.8k tokens, so raise it with
`OLLAMA_CONTEXT_LENGTH` (for example `16384`) or `num_ctx` in a Modelfile.
The builder sends temperature `0.7`. Deploy does not forward `OLLAMA_API_KEY`
or `OLLAMA_BASE_URL`. `cast deploy` to Fly, Railway, Sprites,
DigitalOcean, or MicroVM refuses an `ollama/` agent model, because that
host cannot reach Ollama on this machine. `cast deploy --provider docker`
rewrites a loopback URL to `http://host.docker.internal:<port>/v1` and
adds a host-gateway mapping. A builder URL that is not loopback is refused
for Docker too.

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

- [Inference providers](getting-started/inference-providers)
- [cast provider](getting-started/provider)
- [Create an agent](building-agents/create)
- [Global settings](getting-started/global-settings)
- [Run an agent locally](building-agents/run)
