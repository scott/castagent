---
title: Agent anatomy
section: building-agents
order: 1
description: What the files inside ~/.cast/agents/<name>/ actually mean.
ref: ['cli:new', 'cli:edit', 'cli:describe', 'cli:update']
---

# Agent anatomy

Every agent created by Cast lives at `~/.cast/agents/<name>/`. The directory
is both the agent's source of truth and its working tree — when you edit an
agent with `{% ref "cli:edit" %}` and the Builder writes changes, those
changes show up as files on disk.

```
~/.cast/agents/email-assistant/
├── agent.yaml             # the agent's config
├── instructions.md        # the agent's system prompt ("the brain")
├── tools/                 # custom Python tools
│   └── summarize_thread.py
├── mcp/                   # MCP server configs (one YAML per server)
│   └── gmail.yaml
├── tests/
│   ├── cli/               # TypeScript CLI tests
│   └── agent/             # Python agent tests
│       └── scenarios/
│           └── triage.yaml
├── .cast/                 # Cast-managed metadata (do not hand-edit)
│   ├── changes/           # automatic snapshots
│   │   ├── changes.json
│   │   ├── 001.tar.gz
│   │   └── 002.tar.gz
│   └── releases/          # semantic releases
│       ├── releases.json
│       ├── 1.0.tar.gz
│       └── 1.6.tar.gz
├── .git/                  # if cast git init was run
├── Dockerfile             # written by cast deploy --provider docker
├── requirements.txt       # written by cast deploy
└── README.md              # written by cast git init
```

## The files you own

- **`agent.yaml`** — the agent's configuration. Edit it with
  `{% ref "cli:update" %}` or by hand; Cast will re-read it on the next
  change/release.
- **`instructions.md`** — the system prompt the runtime sends to the LLM.
  This is where the agent's "personality" and capabilities live.
- **`tools/`** — drop in `.py` files that define new LangChain tools. Cast
  picks them up automatically; no registration step.
- **`mcp/`** — one YAML file per MCP server. The Builder Agent scaffolds
  these during `cast new`/`cast edit`.
- **`tests/`** — TypeScript tests for the CLI integration and Python tests
  for agent behaviour. `cast meta test` runs the meta-builder against these.

## The files Cast owns

- **`.cast/changes/`** — the internal change log (undo log). You don't
  touch this directly. The `changes.json` manifest is the source of
  truth for "v3 was created at <timestamp> because <reason>". Cast
  consumes it through `cast undo` / `cast redo` and through
  `cast release`'s auto-changelog generator.   See
  [Undo and redo](versioning/undo).
- **`.cast/releases/`** — the intentional release log. Same idea but for
  semantic versions; `cast release` writes here. See
  [Releases](deployment/releases).
- **`Dockerfile`**, **`requirements.txt`**, **`docker-compose.yml`** — generated
  on each `cast deploy` (or `cast upgrade`) and overwritten on the next
  deploy. Do not hand-edit.
- **`.git/`** — present if you ran `cast git init`. `cast git commit` and
  `cast git push` operate on it.

## What `agent.yaml` controls

| Section | Controls |
|---|---|
| `description` | one-line summary shown in `cast list` and the TUI |
| `version` | current semantic version; `cast release` writes here |
| `repository` | git remote, used by `cast git push` |
| `brain.model` | the LLM the runtime agent calls |
| `brain.instructions_file` | relative path to the system prompt |
| `tools.builtin` | which of `bash` / `read` / `glob` to expose |
| `tools.mcp` | list of MCP server YAMLs to load |
| `tools.custom` | list of `tools/*.py` modules to load |
| `harness.permissions` | per-tool permission level (`always-allow` / `ask` / `deny`) |
| `harness.principles` | constitutional principles appended to the system prompt |
| `runtime.python_version` | Python version in the deployment image |
| `runtime.requirements` | extra pip packages to install in the image |

Use `cast describe <name>` to see the full rendered file with defaults
filled in. Use `cast update <name> --<flag> ...` to mutate it from the CLI
without opening a text editor.
