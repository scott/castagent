# Inference providers

An inference provider turns a model string into a LangChain chat model. The runtime agent, the builder, and memory reflection call `get_provider(model)`. They do not branch on a provider name.

OpenRouter and DigitalOcean serverless inference ship with Cast. Another provider can add itself without editing those callers.

This is not deployment. Droplets, MicroVMs, and `providers.digitalocean` are a different token. See `typescript/cast-cli/src/lib/deploy/README.md` when that file exists.

## How a model string picks a provider

Non-default providers match first. A provider matches when the model starts with one of its prefixes. The longest matching prefix wins. If none match, the default provider is used. OpenRouter is the only default.

| Model string | Provider |
|---|---|
| `digitalocean/llama3.3-70b-instruct` | DigitalOcean |
| `openrouter/anthropic/claude-sonnet-4.6` | OpenRouter |
| `anthropic/claude-sonnet-4.6` | OpenRouter |
| `openai/gpt-4o` | OpenRouter |
| `claude-sonnet-4` | OpenRouter, then the alias table |
| `example/my-model` | The external provider that registered `example/` |

`openai/`, `anthropic/`, `google/`, `meta-llama/`, `kimi/`, `minimax/`, `deepseek/`, `mistralai/`, `cohere/`, `x-ai/`, and `perplexity/` are OpenRouter model ids. Do not register them. A prefix has to be a provider key plus a slash, such as `example/`.

Both API keys may be set. The prefix wins. A provider is available when its environment variable is set, or `~/.cast/tokens/inference/<key>.token` exists, or its config key resolves to a real value. Environment values are trimmed. An unsubstituted `${VAR}` is missing. When `HOME` is unset, or `~/.cast/config.yaml` cannot be read, that file is treated as empty. `create_llm` uses `baseUrlEnv`, then config `base_url`, then the manifest `baseUrl`. If the selected provider's token is missing, Cast stays in echo mode and names that variable. It does not try the other provider.

## Add a built-in

1. Add `python/cast/providers/<key>.py` that exports `provider`.
2. Add one object to `manifest.json` with the same `key`, prefixes, environment variable, and config key.
3. Bind the module in the built-in registry.
4. Add tests for selection, a missing key, and `create_llm`.
5. Do not add a branch to the runtime, the builder, reflection, `cast update`, or the deploy commands.

A test fails when a manifest row has no module, or a module has no row.

## Add an external provider

Create the folder `~/.cast/inference-providers/example/`:

`provider.json`

```json
{
  "key": "example",
  "name": "Example Inference",
  "prefixes": ["example/"],
  "envVar": "EXAMPLE_API_KEY",
  "configKey": "providers.example.api_key",
  "baseUrl": "https://example.invalid/v1",
  "acceptsAnyModel": true,
  "knownModels": [],
  "displayName": "Example Inference",
  "modelsPath": "/models",
  "fallbackModels": ["my-model"],
  "defaultModel": "example/my-model"
}
```

`provider.py`

```python
import os
from langchain_openai import ChatOpenAI

class ExampleProvider:
    key = "example"
    env_var = "EXAMPLE_API_KEY"

    def is_available(self) -> bool:
        return bool(os.getenv(self.env_var))

    def create_llm(self, model: str, **kwargs) -> ChatOpenAI:
        if not self.is_available():
            raise ValueError("EXAMPLE_API_KEY environment variable is required")
        model_id = model[len("example/"):] if model.startswith("example/") else model
        return ChatOpenAI(
            model=model_id,
            api_key=os.environ["EXAMPLE_API_KEY"],
            base_url="https://example.invalid/v1",
            **kwargs,
        )

provider = ExampleProvider()
```

The directory name, `provider.json` `key`, and `provider.key` must match. Prefixes in the JSON and the prefixes the module claims must match.

`displayName`, `modelsPath`, `fallbackModels`, and `defaultModel` live on the catalog row. `cast model` and the TUI read them from `python -m cast.providers.catalog` (`cast provider --json`). A new provider sets those fields instead of editing the shared model list. `modelsPath` is fetched as `GET <base-url><modelsPath>`. A failed fetch uses `fallbackModels`, each prefixed with the provider's first prefix.

Or list a module in `~/.cast/config.yaml`:

```yaml
inferenceProviders:
  - ~/src/acme/provider.py
```

That module assigns `provider` to an object with the attributes below. A package can register the same object with an entry point:

```toml
[project.entry-points."cast.inference"]
example = "acme_cast.provider:provider"
```

Cast loads built-ins, then entry points by key, then `~/.cast/inference-providers/<key>/` by directory name, then `inferenceProviders` in the order written. A reused key or prefix fails at load and names both sources.

Set the key and select the provider with the prefix:

```bash
export EXAMPLE_API_KEY="..."
cast update demo-agent --model example/my-model
```

External providers are included in `python -m cast.providers.catalog` and in deploy env forwarding. They are not written into the docs site.

## Provider object

```python
class InferenceProvider:
    key: str
    name: str
    prefixes: tuple[str, ...]   # ("example/",) — empty only for the default
    default: bool               # True only for OpenRouter
    env_var: str                # EXAMPLE_API_KEY
    config_key: str             # providers.example.api_key
    base_url: str
    accepts_any_model: bool     # True: cast update does not warn on unknown ids
    known_models: tuple[str, ...]

    def is_available(self) -> bool: ...
    def create_llm(self, model: str, **kwargs): ...
```

`is_available` is true only when `env_var` is set in the process environment. A value that exists only in `~/.cast/config.yaml` does not count here. Deploy forwarding is the path that also reads `config_key`.

`create_llm` receives the raw model string, including the prefix. Strip your own prefix. Do not rewrite another provider's ids. Return a LangChain `BaseChatModel`. Raise `ValueError` naming `env_var` when the key is missing.

`known_models` for OpenRouter is the current `KNOWN_MODELS` list, moved verbatim. DigitalOcean sets `accepts_any_model` and an empty `known_models`. `cast update --model` then keeps today's messages: any `digitalocean/<id>` is accepted quietly, and an unknown OpenRouter id still warns about a 404 and still saves.

## What Cast does around the provider

The provider does not decide echo mode. Callers do:

1. `provider = get_provider(model)`.
2. If `provider.is_available()` is false, stay in echo mode and mention `provider.env_var`.
3. Otherwise call `provider.create_llm(model=model, ...)`.
4. On any exception, log a warning and stay in echo mode. The warning names that provider, not the other one.

The runtime, the builder, and reflection all use this sequence. Reflection keeps receiving the agent's raw model.

Deploy code calls `inferenceEnv()`, then keeps the entry whose prefix matches `brain.model` (the longest prefix wins, otherwise the default provider). `inferenceEnv()` runs `python -m cast.providers.catalog`, resolves each `envVar` from the environment and then from `configKey`, and returns the pairs that have a value. Docker, Railway, Fly, Droplets, Sprites, MicroVM, and `cast upgrade` send that one key plus the Cast runtime variables. The helper never reads `providers.digitalocean.token`. Secret values go to the provider on stdin or in the create request body.

`python -m cast.providers.catalog` prints:

```json
[
  {
    "key": "openrouter",
    "name": "OpenRouter",
    "default": true,
    "prefixes": ["openrouter/"],
    "envVar": "OPENROUTER_API_KEY",
    "configKey": "providers.openrouter.api_key",
    "baseUrl": "https://openrouter.ai/api/v1",
    "acceptsAnyModel": false,
    "displayName": "OpenRouter",
    "defaultModel": "openrouter/minimax/minimax-m2.5"
  }
]
```

`knownModels` stays out of this payload. The docs extract reads those from `manifest.json`.

## Rules

- `key` is stable and matches `[a-z0-9-]+`.
- A prefix is `<key>/`. Do not register a prefix that is the vendor segment of an OpenRouter known model.
- Exactly one provider has `default: true`.
- Do not apply OpenRouter aliases on any other provider.
- Do not log the API key.
- Do not read `providers.digitalocean` for inference.
- A provider file that fails to import is reported with its path. The built-ins still register.

## Built-in notes

| Key | Notes |
|---|---|
| `openrouter` | Default. Base URL `https://openrouter.ai/api/v1`. `MODEL_ALIASES` and the vendor-prefix rules stay in this module. `openrouter/` is stripped before the alias table. |
| `digitalocean` | Prefix `digitalocean/` only. Base URL `https://inference.do-ai.run/v1`. Catalog id passed through. Key `DIGITALOCEAN_MODEL_ACCESS_KEY`. Config key `providers.digitalocean_inference.api_key`. |

`openai.py`, `anthropic.py`, and `ollama.py` stay placeholders until a provider is actually implemented through this contract.