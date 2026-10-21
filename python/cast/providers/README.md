# Inference providers

An inference provider turns a model string into a LangChain chat model. The runtime agent, the builder, and memory reflection call `get_provider(model)`. They do not branch on a provider name.

OpenRouter, DigitalOcean serverless inference, OpenAI, xAI, and Google Gemini ship with Cast. Another provider can add itself without editing those callers.

This is not deployment. Droplets, MicroVMs, and `providers.digitalocean` are a different token. See `typescript/cast-cli/src/lib/deploy/README.md` when that file exists.

## How a model string picks a provider

Non-default providers match first. A provider matches when the model starts with one of its prefixes. The longest matching prefix wins. If none match, the default provider is used. OpenRouter is the only default.

| Model string | Provider |
|---|---|
| `digitalocean/llama3.3-70b-instruct` | DigitalOcean |
| `gemini/gemini-3.8-flash` | Google Gemini |
| `openrouter/anthropic/claude-sonnet-4.6` | OpenRouter |
| `anthropic/claude-sonnet-4.6` | OpenRouter |
| `openai/gpt-4o` | OpenRouter |
| `google/gemini-2.5-pro` | OpenRouter |
| `x-ai/grok-2` | OpenRouter |
| `xai/grok-4.7` | xAI. `x-ai/` stays on OpenRouter. |
| `claude-sonnet-4` | OpenRouter, then the alias table |
| `example/my-model` | The external provider that registered `example/` |
| `qwen/qwen3-coder`, `z-ai/glm-4.6`, `unknown/model` | OpenRouter. Any slash prefix that is not registered and not reserved uses the default. |
| `openai-api/gpt-4o` | OpenAI. `openai/gpt-4o` still uses OpenRouter. |
| `openai-api/o3`, `openai-api/gpt-5` | OpenAI, with temperature omitted |
| `gpt-5` | Error. A bare id OpenRouter does not already rewrite needs a prefix. |

`vendor-prefixes.json` lists vendor prefixes an external provider must not claim (`openai/`, `anthropic/`, `google/`, `x-ai/`, and the rest of that file). It does not limit which slash ids OpenRouter can serve. `qwen/`, `z-ai/`, `moonshotai/`, and any later vendor still route to OpenRouter.

`anthropic-api/`, `bedrock/`, and `ollama/` are reserved in `manifest.json` with `"impl": "reserved"`. They are not providers. An external cannot claim one. Using one raises `InferenceProviderError` and, when the row sets `openrouterVendor`, names the OpenRouter id (`anthropic/claude-sonnet-4.6` for `anthropic-api/claude-sonnet-4.6`). The runtime and reflection catch that error and stay in echo mode.

`openai-api/` is registered. An external cannot claim that prefix either. `xai/` is registered. It is not the OpenRouter vendor prefix `x-ai/`. `xai/grok-4.7` calls xAI. `x-ai/grok-2` still calls OpenRouter. `gemini/` is registered. A bare alias such as `gemini-2.5-pro` still uses OpenRouter and is rewritten to `google/gemini-2.5-pro`.

A bare alias such as `claude-sonnet-4`, a known OpenRouter id, a date suffix, or a dashed Claude id such as `claude-3-7-sonnet` still uses OpenRouter. A bare id OpenRouter does not already rewrite, such as `gpt-5`, is an error in `cast model` and `cast update`. The runtime and reflection catch it and stay in echo mode.

Several API keys may be set. The prefix wins. A provider is available when its environment variable is set, or `~/.cast/tokens/inference/<key>.token` exists, or its config key resolves to a real value. Environment values are trimmed. An unsubstituted `${VAR}` is missing. When `HOME` is unset, or `~/.cast/config.yaml` cannot be read, that file is treated as empty. `create_llm` uses `baseUrlEnv`, then config `base_url`, then the manifest `baseUrl`. If the selected provider's token is missing, Cast stays in echo mode and names that variable. It does not try the other provider.

## Add an OpenAI-compatible provider

OpenRouter and DigitalOcean both use `OpenAICompatibleProvider`. The row is the provider. A new OpenAI-compatible provider adds itself:

1. Add one object to `manifest.json` with `"impl": "openai-compatible"`, a `key`, prefixes, `envVar`, `configKey`, and `baseUrl`.
2. Set model-list fields only when you need them: `modelsPath`, `modelsFilter`, `modelsHeaders` (`${token}`), `curatedModels`, `stripModelIdPrefix`, `keyless`, `placeholderKey`, `fallbackModels`, `defaultModel`.
3. Set `defaultParams` for sampling values such as `{"temperature": 0.7}`. Leave it out to send no temperature. `omitTemperatureModels` is a list of regexes. A match drops `temperature` for that model.
4. Non-secret settings go in `settings` as `{"env": "EXAMPLE_REGION", "configKey": "providers.example.region"}`. A name containing `BASE_URL` is dropped and is never forwarded on deploy.
5. Add tests for selection, a missing key, and `create_llm`. Do not add a branch to the runtime, the builder, reflection, `cast update`, or the deploy commands.

No module is required. The registry builds the shared class for every `openai-compatible` row that is not already bound. TypeScript reads the same catalog, so model listing and deploy forwarding follow the row.

A rewrite of model ids needs a module. That module subclasses `OpenAICompatibleProvider`, passes the rewrite and a call-time `chat_factory`, exports `provider`, and is listed in `BUILTIN_MODULES`. OpenRouter does this for `MODEL_ALIASES`. DigitalOcean's module exists so tests can still patch `digitalocean_inference.ChatOpenAI`. It does not rewrite catalog ids.

A test fails when a module exports `provider` but has no manifest row, or a live manifest row is neither a module nor `impl: openai-compatible`. Reserved rows are not providers.

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
    prefixes: tuple[str, ...]   # ("example/",). Empty only for the default
    default: bool               # True only for OpenRouter
    env_var: str                # EXAMPLE_API_KEY
    config_key: str             # providers.example.api_key
    base_url: str
    accepts_any_model: bool     # True: cast update does not warn on unknown ids
    known_models: tuple[str, ...]

    def is_available(self) -> bool: ...
    def create_llm(self, model: str, **kwargs): ...
```

The shared class treats a provider as available when `resolve_token` finds a value: the environment variable, then `~/.cast/tokens/inference/<key>.token`, then `config_key`. A keyless row is available with no token and sends `placeholderKey` (default `ollama`). Deploy forwarding uses the same token order and also reads non-secret `settings`. It never forwards a name containing `BASE_URL`.

`create_llm` receives the raw model string, including the prefix. The shared class strips the longest prefix, then runs the optional rewrite. Do not rewrite another provider's ids. Return a LangChain `BaseChatModel`. Raise `ValueError` with the row's `missingKeyMessage` when the key is missing. The builder passes `llm_params(model)` (the row's `defaultParams`, with `temperature` removed when the model matches `omitTemperatureModels`). The runtime and reflection pass no temperature.

`known_models` for OpenRouter is the current `KNOWN_MODELS` list, moved verbatim. DigitalOcean sets `accepts_any_model` and an empty `known_models`. `cast update --model` then keeps today's messages: any `digitalocean/<id>` is accepted quietly, and an unknown OpenRouter id still warns about a 404 and still saves.

## What Cast does around the provider

The provider does not decide echo mode. Callers do:

1. `provider = get_provider(model)`.
2. If `provider.is_available()` is false, stay in echo mode and mention `provider.env_var`.
3. Otherwise call `provider.create_llm(model=model, ...)`.
4. On any exception, log a warning and stay in echo mode. The warning names that provider, not the other one.

The runtime, the builder, and reflection all use this sequence. Reflection keeps receiving the agent's raw model.

Deploy code calls `inferenceEnv()`, then keeps the entry whose prefix matches `brain.model` (the longest prefix wins, otherwise the default provider). `inferenceEnv()` runs `python -m cast.providers.catalog`, resolves each `envVar` from the environment, keychain, token file, and then `configKey`, and returns API keys only. It does not return `baseUrlEnv`. A custom base URL stays on the builder (`primeInferenceProcessEnv` and `create_llm`). Docker, Droplets, Sprites, MicroVM, and `cast upgrade` for those hosts send that one key plus the Cast runtime variables. Railway and Fly set the key at deploy time and do not rewrite it on upgrade. The helper never reads `providers.digitalocean.token`. Secret values go to the provider on stdin or in the create request body.

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
| `openrouter` | Default. Shared class plus `rewrite_openrouter_model`. Base URL `https://openrouter.ai/api/v1`. `openrouter/` is stripped before the alias table. Builder temperature is `0.7` unless the model matches `omitTemperatureModels`. |
| `digitalocean` | Shared class. Prefix `digitalocean/` only. Base URL `https://inference.do-ai.run/v1`. Catalog id passed through. Key `DIGITALOCEAN_MODEL_ACCESS_KEY`. Config key `providers.digitalocean_inference.api_key`. Model list is `GET /models`, with fallbacks `llama3.3-70b-instruct` and `deepseek-v3.2`. Builder temperature is `0.7` unless the model matches `omitTemperatureModels`. |
| `openai-api` | Shared class. No module. Prefix `openai-api/` only. Base URL `https://api.openai.com/v1`. Catalog id passed through. Key `OPENAI_API_KEY`. Config key `providers.openai.api_key`. Cast does not read `OPENAI_BASE_URL`. A builder-only URL is `providers.openai.base_url` from `cast provider enable openai-api --url`. Model list is `GET /models`, filtered to chat ids. Embedding, TTS, image, moderation, realtime, audio, transcribe, search, pro, deep-research, codex, and instruct ids are left out. Search-preview models reject temperature, so they are not listed. Fallbacks are `gpt-4o` and `gpt-4o-mini`. Builder temperature is `0.7` unless the model matches `omitTemperatureModels` (`o1`, `o3`, `gpt-5`, and the same families). Deploy forwards `OPENAI_API_KEY` only when `brain.model` uses this prefix. |
| `xai` | Shared class, no module. Prefix `xai/` only. Base URL `https://api.x.ai/v1`. Key `XAI_API_KEY`. Config key `providers.xai.api_key`. `XAI_BASE_URL` overrides the base URL on the builder and is not deployed. Model list is `GET /models`. `modelsFilter` keeps chat ids and drops `latest`, `*-latest`, and ids that contain `imagine`, `image`, `video`, `voice`, `embed`, `tts`, or `multi-agent`. Fallbacks are `grok-4.7`, `grok-4.20-0309-non-reasoning`, and `grok-4.20-0309-reasoning`. Builder `defaultParams` send temperature `0.7`, including reasoning ids. The row does not send `stop`, `presence_penalty`, `frequency_penalty`, or `reasoning_effort`. |
| `gemini` | Shared class, no module. Prefix `gemini/` only. Base URL `https://generativelanguage.googleapis.com/v1beta/openai`. Key `GEMINI_API_KEY`. Config key `providers.gemini.api_key`. `GET /models` returns ids like `models/<id>`; `stripModelIdPrefix` removes that before `/model` stores `gemini/<id>`. `modelsFilter` keeps Gemini chat ids and drops image, TTS, live, embedding, and other non-chat rows. Fallbacks are `gemini-3.8-flash` and `gemini-3.1-pro-preview`. The row has no `defaultParams`, so the builder omits temperature and Gemini 3 keeps its API default of 1.0. A lower temperature can loop on those thinking models. `google/` stays on OpenRouter. |

`anthropic.py` and `ollama.py` stay placeholders until a provider is actually implemented through this contract. OpenAI and xAI do not have a module.