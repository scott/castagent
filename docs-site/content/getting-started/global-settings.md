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

`providers.digitalocean` is the **deploy** token for Droplets and MicroVMs.
It is not an inference credential. Serverless inference uses
`providers.digitalocean_inference` (or `DIGITALOCEAN_MODEL_ACCESS_KEY`).
Set an agent's model to `digitalocean/llama3.3-70b-instruct` or
`digitalocean/deepseek-v3.2` to call `https://inference.do-ai.run/v1`.
OpenRouter stays the default when the model is `openrouter/...` or has no
provider prefix. `defaults.builder_model` can be a `digitalocean/<model-id>`
string; the default remains `openrouter/minimax/minimax-m2.5`. Change the
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
| `RAILWAY_API_TOKEN` | Railway deploys (alternative to `railway login`). |
| `FLY_API_TOKEN` | Fly.io deploys (alternative to `flyctl auth login`). Not a Sprites token. |
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean deploys (also accepts `DIGITALOCEAN_API_TOKEN`, `DIGITALOCEAN_API_KEY`). MicroVM passes this value to `doctl` through the child environment, not as `--access-token`. |
| `SPRITES_TOKEN` | Sprites deploys. Create the token at [sprites.dev/account](https://sprites.dev/account) in the `org-slug/org-id/token-id/token-value` format. `sprite login` is an alternative. The sprite CLI reads `SPRITE_TOKEN`, not `SPRITES_TOKEN`. When `SPRITE_TOKEN` is unset, Cast copies `SPRITES_TOKEN` into `SPRITE_TOKEN` for sprite child processes. The token is not placed on a command line. `FLY_API_TOKEN` is not a Sprites token. |
| `CAST_DEPLOYMENT_SHA` | Set automatically during `cast deploy`; useful for child processes. |
| `CAST_PROVIDER_HTTP_BASE` | Optional http or https origin. When set, Cast uses it as the origin for provider HTTP calls and keeps the official path and query. Unset, those calls use the official origin. Provider CLIs stay on `PATH`. |

Anything in `config.yaml` can use `${VAR}` interpolation, and the
interpolation falls through to the environment if not set in YAML.

Sprites needs the `sprite` CLI. Set `SPRITES_TOKEN` to a token created at
[sprites.dev/account](https://sprites.dev/account) in the
`org-slug/org-id/token-id/token-value` format, or run `sprite login`.
`FLY_API_TOKEN` is not a Sprites token. Cast copies `SPRITES_TOKEN` to
`SPRITE_TOKEN` for sprite child processes when `SPRITE_TOKEN` is unset.

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
