---
title: Architecture
section: development
order: 1
description: The components, how they fit together, and the key technical decisions.
ref: ['']
---

# Architecture

Cast is a monorepo with three runtime components and a small set of
supporting services. This page is the 10-minute tour; the full SPEC lives
at [`docs/SPEC.md`](https://github.com/scott/castagent/blob/master/docs/SPEC.md).

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   TypeScript CLI / TUI (oclif + OpenTUI)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  oclif   │  │ OpenTUI  │  │  Agent       │  │  MCP Manager           │  │
│  │  CLI     │  │  TUI     │  │  Supervisor  │  │  (keytar)              │  │
│  └──────────┘  └──────────┘  └──────────────┘  └────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
           │ stdio JSON-RPC              │ A2A over HTTP (local & deployed)
           ▼                             ▼
┌───────────────────────┐    ┌───────────────────────────────────────────────┐
│   Builder Agent       │    │          Runtime Agent                       │
│   (Python/LangChain)  │    │          (Python/LangChain)                  │
│                       │    │   A2A HTTP server (port 10000-65535)         │
│   Tools:              │    │   LangChain AgentExecutor                    │
│   - create_agent      │    │   AgentCard for discoverability              │
│   - update_config     │    │   Bearer token auth (deployed)               │
│   - install_mcp       │    │                                               │
│   - recommend_model   │    │                                               │
│   - list_agents       │    │                                               │
│   - get_agent_config  │    │                                               │
└───────────────────────┘    └───────────────────────────────────────────────┘
```

## Key decisions

| | Choice | Why |
|---|---|---|
| CLI language | TypeScript (oclif) | fast iteration, oclif's plugin model |
| TUI framework | OpenTUI (native Zig + TS bindings) | fast, well-supported on macOS and Linux |
| Agent language | Python (LangChain) | richest ecosystem for LLM tool use |
| Builder transport | stdio JSON-RPC | zero-config local IPC |
| Runtime transport | A2A over HTTP | standard, debuggable, language-agnostic |
| Local agent port | dynamic (10000-65535) | multiple agents on one host |
| Database | plain SQLite (no SQLCipher) | backups are a file copy |
| Token storage | `keytar` (system keychain) | no plaintext tokens on disk |
| LLM provider | OpenRouter v1 | one key, many models |
| Deployment | Railway, Fly.io, DigitalOcean, Sprites, Docker | one command per provider |

## Repo layout

```
castagent/
├── typescript/
│   ├── cast-cli/             # oclif CLI
│   │   ├── src/commands/     # one .ts per command (or per topic)
│   │   ├── src/lib/          # deploy/, builder/, a2a/, releases.ts, sqlite.ts
│   │   ├── bin/run
│   │   └── package.json
│   └── cast-tui/             # OpenTUI TUI
│       ├── src/commands/slash-registry.ts
│       ├── src/components/   # header, input, messages, modal, autocomplete, terminal
│       ├── src/screens/      # welcome, chat
│       └── package.json
├── python/
│   └── cast/
│       ├── __main__.py
│       ├── agent/            # base, builder, runtime
│       ├── tools/            # bash, read, glob
│       ├── harness/          # permissions, principles
│       └── providers/        # openrouter, anthropic, openai, ollama
├── tests/
│   ├── ts/                   # TypeScript CLI tests
│   └── python/               # Python agent tests
├── docs/
│   ├── SPEC.md               # the long-form spec
│   └── site/                 # this documentation site (Astro)
├── prds/                     # product requirement docs
├── .changeset/               # changesets
├── .github/workflows/        # CI: test, release, auto-changeset, docs
├── install.sh
├── setup.sh
├── cast                      # bash wrapper that calls typescript/cast-cli/bin/run
└── package.json              # root workspace (typescript/*, docs-site)
```

## Cast agent YAML at a glance

```yaml
description: "Email triage assistant"
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

runtime:
  python_version: "3.12"
  requirements:
    - requests
    - beautifulsoup4
```

The full schema is in
[SPEC.md](https://github.com/scott/castagent/blob/master/docs/SPEC.md#agent-yaml-reference);
a more user-friendly version is in [agent anatomy](agents/anatomy).

## The data model

Three SQLite tables plus per-agent tarballs:

- `agents(name, agent_yaml_path, created_at, updated_at)` — one row per
  `~/.cast/agents/<name>/`.
- `releases(agent_name, version, change_number, message, changelog,
  created_at, tarball_path)` — append-only; one row per `cast release`.
- `deployments(id, agent_name, provider, deployed_version,
  deployed_change, deployed_at, deployment_url, auth_token_hash,
  last_connected_at, volume_id, volume_config, deleted_at)` — one row
  per *deploy*, soft-deletable.

Tarballs:

- `~/.cast/agents/<name>/.cast/changes/NNN.tar.gz` — the internal undo
  log; one per modification. Consumed by `cast undo` / `cast redo`.
- `~/.cast/agents/<name>/.cast/releases/<semver>.tar.gz` — the
  intentional release log; one per release.
- `~/.cast/sessions/<id>.json` — one per saved conversation
  transcript.

## How deploys talk to providers

`cast deploy <name> --provider X` dispatches into
`typescript/cast-cli/src/lib/deploy/<x>.ts`. Each provider implements
the same shape: build a Docker image, push it, create or update the
remote resource, write a `deployments` row.

Provider-specific quirks live in those files. The high-level command
(`cast deploy`) doesn't know or care that Railway uses `railway up`,
Fly uses `flyctl deploy --detach`, and DigitalOcean SSHes into a
Droplet to `docker load` a streamed image.
