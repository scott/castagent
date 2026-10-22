---
title: cast provider
section: getting-started
order: 6
description: List inference providers, store a model access key, and switch the builder.
ref: ['cli:provider', 'slash:provider']
---

# cast provider

`{% ref "cli:provider" %}` shows or switches the inference provider the builder uses. `{% ref "slash:provider" %}` does the same inside the dev TUI. Neither command picks a deploy host. Deploy hosts are on the [deployment providers](deployment/providers) page. Prefixes, keys, and base URLs are on [Inference providers](getting-started/inference-providers).

The active provider is the one whose prefix matches `defaults.builder_model`. The longest registered prefix wins. `defaults.inference_provider` is only a hint when that model has no registered prefix. Otherwise the default is OpenRouter.

A running builder does not hot-swap. Start `cast dev`, `cast new`, or `cast edit` again after a switch.

## List providers

```bash
cast provider
cast provider --json
cast provider --current
cast provider --current --json
```

With no arguments, `cast provider` prints one line per registered provider: the key, the display name, the base URL it will call, and `enabled` or `not enabled`. The active row is marked `(current)`. `--json` prints the same rows as JSON. `--current` prints the active key. `--current --json` prints `{"key":"<key>"}`.

A provider is enabled when its environment variable is set, the keychain holds a token, `~/.cast/tokens/inference/<key>.token` exists, or its config key resolves to a real value. Values are trimmed. An unsubstituted `${VAR}` is not a token. A keyless provider such as Ollama is enabled with none of those.

The list is the built-in catalog plus any external provider that loaded. It is sorted by display name.

## Enable a provider

```bash
cast provider enable openai-api --token -
cast provider enable digitalocean --token - --url https://inference.do-ai.run/v1
cast provider enable ollama --url http://127.0.0.1:11434/v1
```

`--token -` reads the model access key from stdin. `--token` with no value prompts without echoing. A literal key on the command line is stored, and Cast warns that it is visible in process listings and shell history. Do not put a real key in the command. The key is not written to `~/.cast/config.yaml` and is not printed.

The token is stored in the system keychain (service `cast`, account `inference:<key>`). When the keychain cannot be loaded, Cast writes `~/.cast/tokens/inference/<key>.token` at mode 0600. The token directory is mode 0700. A successful keychain write removes that file.

`--url` is optional. It writes `base_url` next to that provider's `api_key` (`providers.openai.base_url` for `openai-api`, `providers.digitalocean_inference.base_url` for DigitalOcean, and the same pattern for the other rows). `default_base_url` in the install scaffold stays the shipped host. A URL must be `https`, or `http` on literal `127.0.0.1`, `::1`, or `localhost`, with a host and no userinfo, query, or fragment. That URL is for the builder on this machine. Deploy and upgrade do not copy `OPENROUTER_BASE_URL`, `DIGITALOCEAN_INFERENCE_BASE_URL`, `XAI_BASE_URL`, `GEMINI_BASE_URL`, `ANTHROPIC_BASE_URL`, or `OLLAMA_BASE_URL`.

`cast provider enable ollama` can omit `--token`. Ollama is keyless. An optional `OLLAMA_API_KEY` is only for `https://ollama.com`, and it is not copied onto a deployed agent. A provider that is not keyless needs `--token` or an existing token when you pass `--url` alone.

## Switch the builder

```bash
cast provider openrouter
cast provider xai
cast provider gemini
cast provider anthropic-api
cast provider openai-api
cast provider digitalocean
cast provider ollama
```

`cast provider <key>` switches to that provider when it is enabled. It sets `defaults.builder_model` to a model that provider serves, sets `defaults.inference_provider` to the key, and remembers the previous builder model under `defaults.provider_models`. A provider that is not enabled exits non-zero and tells you to run `cast provider enable <key> --token -`. It does not write the config.

The model it stores is the id remembered for that provider when that id is still accepted, otherwise the row's default model when the catalog includes it. For Ollama, a live server keeps `ollama/qwen3` only if that pull is present (`qwen3` and `qwen3:latest` match; `qwen3:8b` does not) and otherwise stores the first pulled chat model. When Ollama does not answer, the switch stores `ollama/qwen3` and prints `ollama pull qwen3`.

If the provider has no model to store, the command prints that the key needs a model and does not change the config:

```text
'<key>' needs a model before it becomes the builder provider.
  Set a model with: cast model <key>/<model-id>
```

On success:

```text
✓ Inference provider set to: xAI
  Builder model: xai/grok-4.7
  Restart the builder to take effect (run `cast dev <agent>` again).
```

`cast model <prefix>/<id>` also switches to an enabled provider. See [Changing the builder model](building-agents/builder-model).

## TUI: /provider

`/provider` is registered only in dev mode (`cast dev`, and the builder launched by `cast new` / `cast edit`). It is hidden from `/help` in production and on-host. See [Modes](building-agents/development-workflow/tui/modes).

Typing `/provider` opens a modal titled "Inference Provider". The list is `cast provider --json`, read again each time the modal opens, so enabling a provider does not require quitting the TUI. The selected row is marked `▸`. Up and down wrap. The current row starts selected.

Enter on a provider that is not enabled asks for a model access key, then a base URL. The key is masked and sent on stdin to `cast provider enable <key> --token -`. The URL is omitted when it is still the shipped base URL. Enter on another enabled provider runs `cast provider <key>`. Enter on the current provider does nothing. `e` edits the token and URL for the selected row. ESC on the list closes the modal and returns focus to the input. ESC on the token or URL field returns to the list.

A URL must be `https`, or `http` on `127.0.0.1`, `::1`, or `localhost`, with no userinfo or query. If `cast` is not on `PATH`, the modal shows `cast CLI not found in PATH.`

On success the chat shows the provider name and the builder model, and tells you to restart the builder. The process that is already running keeps the provider it started with.

## See also

- [Inference providers](getting-started/inference-providers)
- [Changing the builder model](building-agents/builder-model)
- [Global settings](getting-started/global-settings)
