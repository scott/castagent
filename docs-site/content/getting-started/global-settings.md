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
[Configuration](../configuration/custom-tools) section.

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
  railway:
    api_token: ${RAILWAY_API_TOKEN}
  fly:
    api_token: ${FLY_API_TOKEN}
  digitalocean:
    token: ${DIGITALOCEAN_API_TOKEN}
```

The file is re-read on every command, so changes take effect without
restarting anything.

## Environment variables

| Variable | Used for |
|---|---|
| `OPENROUTER_API_KEY` | Default LLM provider auth. |
| `RAILWAY_API_TOKEN` | Railway deploys (alternative to `railway login`). |
| `FLY_API_TOKEN` | Fly.io deploys (alternative to `flyctl auth login`). |
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean deploys (also accepts `DIGITALOCEAN_API_TOKEN`, `DIGITALOCEAN_API_KEY`). |
| `SPRITES_TOKEN` | Sprites deploys (alternative to `sprite login`). |
| `CAST_DEPLOYMENT_SHA` | Set automatically during `cast deploy`; useful for child processes. |

Anything in `config.yaml` can use `${VAR}` interpolation, and the
interpolation falls through to the environment if not set in YAML.

## Secrets

- **API keys** go in `~/.cast/config.yaml` or the environment. They are never
  written to per-agent files.
- **OAuth credentials** (e.g. Gmail) go in `~/.cast/vault/<agent>/` with
  mode `0600`. The Builder Agent writes them during MCP install.
- **Bearer tokens** for deployed agents are stored via the system keychain
  (`keytar`) at `~/.cast/tokens/<agent>.token` as a fallback.
- **Per-agent state** that is safe to share (deploy URLs, deployment SHAs)
  lives in `~/.cast/cast.db` (SQLite).

## Per-agent: `agent.yaml`

Every agent's config is a single file at
`~/.cast/agents/<name>/agent.yaml`. The Builder Agent creates this when you
run `cast new`, and `cast update` mutates it. The full schema lives in the
[configuration](configuration/schema) reference (TODO: link once written),
but the high-level shape is:

```yaml
description: "Drafts and triages incoming email."
version: "1.6"
repository:
  remote: origin
  url: https://github.com/you/email-agent.git
  branch: main

brain:
  model: openrouter/anthropic/claude-3.7-sonnet
  instructions_file: instructions.md

tools:
  builtin: [bash, read, glob]
  mcp:
    - server: gmail
      config: mcp/gmail.yaml
  custom:
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

See the [agent anatomy](../building-agents/anatomy) page for a tour
of the surrounding directory.
