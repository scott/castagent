---
title: Global settings
section: getting-started
order: 4
description: '~/.cast/config.yaml, environment variables, and the secrets model.'
ref: ['']
---

# Global settings

This page covers the **global** layer of Cast configuration — the
settings that apply to every agent on this machine. For
per-agent configuration (tools, MCP servers, memory, etc.), see the
[Configuration](configuration/custom-tools) section.

There are two layers of configuration in Cast: the **global** layer
covered here, and the **per-agent** layer that lives in each
agent's `agent.yaml`.

## Global config: `~/.cast/config.yaml`

```yaml
cast:
  version: "1.0"

defaults:
  agent_storage: ~/.cast/agents
  builder_model: openrouter/minimax/minimax-m2.5
  deployment_'provider: docker

providers:
  openrouter:
    api_key: ${OPENROUTER_API_KEY}
    default_base_url: https://openrouter.ai/api/v1
  digitalocean_inference:
    api_key: ${DIGITALOCEAN_MODEL_ACCESS_KEY}
    default_base_url: https://inference.do-ai.run/v1
  railway:
    api_token: ${RAILWAY_API_TOKEN}
  fly:
    api_token: ${FLY_API_TOKEN}
  digitalocean:
    token: ${DIGITALOCEAN_API_TOKEN}
```

The file is re-read when a command or a new builder process starts.
`defaults.builder_model` does not hot-swap into a builder that is already
running. Start `cast dev`, `cast new`, or `cast edit` again to apply it.
See [Changing the builder model](building-agents/builder-model).

`cast provider` lists inference providers. The active provider is the
one whose prefix matches `defaults.builder_model`.
`defaults.inference_provider` is only a hint when that model has no
registered prefix.

```bash
cast provider enable digitalocean --token -
cast provider enable digitalocean --token - --url https://inference.do-ai.run/v1
```

`--token -` reads the model access key from stdin. `--token` with no
value prompts without echoing. A literal key on the command line is
stored, and Cast warns that it is visible in process listings and shell
history. The key is not written to this file and is not printed. It is
stored in the system keychain. When the keychain cannot be loaded, the
key is written to `~/.cast/tokens/inference/<key>.token` at mode 0600.
`--url` writes `base_url` next to that provider's `api_key`.
`default_base_url` stays the shipped host. A URL must be `https`, or
`http` on literal `127.0.0.1`, `::1`, or `localhost`, with a host and no
userinfo or query. That URL is for the builder on this machine. Deploy
and upgrade do not copy `OPENROUTER_BASE_URL`,
`DIGITALOCEAN_INFERENCE_BASE_URL`, or `XAI_BASE_URL` onto the agent. A provider is enabled when its environment variable,
that stored token, or a real config value is set. An unsubstituted
`${VAR}` is not a token. Values are trimmed.

`providers.digitalocean` is the **deploy** token for Droplets and MicroVMs.
It is not an inference credential. Serverless inference uses
`providers.digitalocean_inference` (or `DIGITALOCEAN_MODEL_ACCESS_KEY`).
Set an agent's model to `digitalocean/llama3.3-70b-instruct` or
`digitalocean/deepseek-v3.2` to call `https://inference.do-ai.run/v1`.
OpenRouter stays the default when the model is `openrouter/...`, any
other slash prefix that is not registered or reserved (`openai/`,
`x-ai/`, `qwen/`, `z-ai/`, and the rest), or a bare alias such as `claude-sonnet-4`.
`openai-api/`, `anthropic-api/`, `gemini/`, `bedrock/`, and
`ollama/` are reserved and are not providers yet. `xai/<model-id>` is
direct xAI (`XAI_API_KEY`, `https://api.x.ai/v1`). `defaults.builder_model` can be
`digitalocean/<model-id>` or `xai/<model-id>`. The default remains
`openrouter/minimax/minimax-m2.5`. Change the
curated OpenRouter ids with `cast model` or `/model` in the builder TUI.
The running builder keeps its current model until the next launch.

## External inference providers

`inferenceProviders` in `~/.cast/config.yaml` lists extra LLM providers.
Each entry is a path to a `provider.py` or an importable module name:

```yaml
inferenceProviders:
  - ~/src/acme/provider.py
```

A folder at `~/.cast/inference-providers/<key>/` with `provider.json` and
`provider.py` is loaded the same way, as is a package entry point group
named `cast.inference`. The model prefix (for example `example/my-model`)
selects that provider. Deploy forwards the API key for the provider
selected by the agent's `brain.model`, including an external provider.
`providers.digitalocean.token` is the Droplet and MicroVM deploy token.

## Environment variables

| Variable | Used for |
|---|---|
| `OPENROUTER_API_KEY` | Default LLM provider auth. |
| `DIGITALOCEAN_MODEL_ACCESS_KEY` | DigitalOcean serverless inference. Not the deploy token. |
| `XAI_API_KEY` | xAI inference for `xai/<model>`. Deploy sends it only when the agent uses that prefix. |
| `XAI_BASE_URL` | Optional builder override for the xAI base URL. Not deployed. |
| `RAILWAY_API_TOKEN` | Railway deploys (alternative to `railway login`). |
| `FLY_API_TOKEN` | Fly.io deploys (alternative to `flyctl auth login`). Not a Sprites token. |
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean deploys (also accepts `DIGITALOCEAN_API_TOKEN`, `DIGITALOCEAN_API_KEY`). MicroVM passes this value to `doctl` through the child environment, not as `--access-token`. |
| `SPRITES_TOKEN` | Sprites deploys. Create the token at [sprites.dev/account](https://sprites.dev/account) in the `org-slug/org-id/token-id/token-value` format. `sprite login` is an alternative. The sprite CLI reads `SPRITE_TOKEN`, not `SPRITES_TOKEN`. When `SPRITE_TOKEN` is unset, Cast copies `SPRITES_TOKEN` into `SPRITE_TOKEN` for sprite child processes. The token is not placed on a command line. `FLY_API_TOKEN` is not a Sprites token. |
| `CAST_DEPLOYMENT_SHA` | Set automatically during `cast deploy`; useful for child processes. |

Anything in `config.yaml` can use `${VAR}` interpolation, and the
interpolation falls through to the environment if not set in YAML.

Sprites needs the `sprite` CLI. Set `SPRITES_TOKEN` to a token created at
[sprites.dev/account](https://sprites.dev/account) in the
`org-slug/org-id/token-id/token-value` format, or run `sprite login`.
`FLY_API_TOKEN` is not a Sprites token. Cast copies `SPRITES_TOKEN` to
`SPRITE_TOKEN` for sprite child processes when `SPRITE_TOKEN` is unset.

## Testing override

`CAST_PROVIDER_HTTP_BASE` is a loopback-only testing override. The value
must be an `http` or `https` origin of literal `127.0.0.1` or `::1`,
with no path, query, user, or hash. `localhost` is rejected because it is
resolved through the hosts file. When it is set, Droplet DigitalOcean
API calls and Fly agent-card checks use that origin and keep the official
path and query. Fly checks the value before it creates an app. `cast connect`
rewrites the stored URL only for Fly. Cast stores the official provider URL in the registry.
MicroVM calls to `api.digitalocean.com` are not redirected. Leave it unset
for a normal deploy. Provider CLIs stay on `PATH`. Any other host is an
error, so a bearer token is not sent to that origin.

## Secrets

- **API keys** go in `~/.cast/config.yaml` or the environment. They are never
  written to per-agent files.
- **OAuth credentials** (e.g. Gmail) go in `~/.cast/vault/<agent>/`. The
  directory is mode `0700` and each credential file is mode `0600`. The
  Builder Agent writes them during MCP install. The callback listens on
  `127.0.0.1` and checks the OAuth state before it stores tokens.
- **Bearer tokens** for deployed agents are stored in the system keychain
  (`keytar`). When the machine has no Secret Service, Cast writes the same
  token to `~/.cast/tokens/<agent>.token` and the per-deployment token to
  `~/.cast/tokens/deployments/<sha>.token`. The token directory is mode
  `0700` and each file is created mode `0600`. Those files sit outside
  the agent directory, so `cast git` cannot publish them.
  Docker deploy passes the token and the API key for `brain.model` to the
  container as environment variables, through an env file on the Docker
  CLI's stdin. It does not write them into `docker-compose.yml` or any
  other file in the agent directory. Fly, Railway, Sprites, Droplets, and
  MicroVMs use the same rule: stdin or the provider request body, and only
  the key that model needs.
- **Per-agent state** that is safe to share (deploy URLs, deployment SHAs)
  lives in `~/.cast/cast.db` (SQLite). The database file is created mode
  `0600`. It stores token hashes, not raw bearer tokens.
- **Session transcripts** live in `~/.cast/sessions/` (mode `0700`). Each
  transcript file is created mode `0600`.

## Per-agent: `agent.yaml`

Every agent's config is a single file at
`~/.cast/agents/<name>/agent.yaml`. The Builder Agent creates this when you
run `cast new`, and `cast update` mutates it. The high-level shape is:

```yaml
description: "Drafts and triages incoming email."
version: "1.6"
repository:
  remote: origin
  url: https://github.com/you/email-agent.git
  branch: main

brain:
  model: openrouter/anthropic/claude-sonnet-4.6
  instructions_file: instructions.md

tools:
  builtin: [bash, read, glob]
  mcp:
    - server: gmail
      config: mcp/gmail.yaml
  custom:
    - email_tools
    - path: tools/summarize.py

harness:
  permissions:
    bash: ask
    read: always-allow
    glob: always-allow
  principles:
    - "Always ask before sending email."
    - "Summarize threads in three bullets or fewer."

runtime:
  python_version: "3.12"
  requirements:
    - requests
    - beautifulsoup4
```

A `tools.custom` entry is a module name string or an object with `path`.
`cast describe` prints the string or the path. The runtime loads
`tools.builtin` and leaves `tools.custom` unloaded. The Builder rejects
a flat `tools` list, a top-level `model`, a top-level `permissions`
block, and a top-level `memory` block, and it leaves `agent.yaml`
unchanged. See
[Custom tools](configuration/custom-tools) and the
[agent anatomy](building-agents/anatomy) page.
