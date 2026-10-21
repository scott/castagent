# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- xAI is a direct inference provider. `xai/<model>` calls `https://api.x.ai/v1` with `XAI_API_KEY`. `x-ai/` stays on OpenRouter. The model list keeps chat models and drops image, video, voice, embedding, multi-agent, and `latest` aliases. The builder sends temperature `0.7` and does not send `stop`, `presence_penalty`, or `frequency_penalty`. Deploy forwards `XAI_API_KEY` only for an `xai/` model and never forwards `XAI_BASE_URL`. ([#414](https://github.com/scott/castagent/pull/414))
- Direct OpenAI inference. `openai-api/<model>` uses `OPENAI_API_KEY` and `https://api.openai.com/v1`. The model list keeps chat ids and drops embedding, TTS, image, moderation, search, pro, deep-research, codex, and instruct ids. Reasoning models such as `o3` and `gpt-5` omit temperature. `openai/` stays on OpenRouter. Deploy forwards `OPENAI_API_KEY` only when that is the key `brain.model` needs. ([#415](https://github.com/scott/castagent/pull/415))
- Google Gemini is a builder and runtime inference provider. `gemini/<model>` calls `https://generativelanguage.googleapis.com/v1beta/openai` with `GEMINI_API_KEY`. `/model` lists chat models and strips a leading `models/` from ids the list endpoint returns, including a hand-typed `gemini/models/<id>`. Video ids such as `gemini-omni-1.1-flash` are excluded. Gemini 3 and 4 tool calls return `extra_content.google.thought_signature`, and Cast echoes that object on the next request. `google/...` stays on OpenRouter. Deploy forwards only `GEMINI_API_KEY`. The builder omits temperature so Gemini 3 thinking models keep the API default of 1.0. ([#416](https://github.com/scott/castagent/pull/416))
- OpenAI-compatible inference providers share one class filled in from `python/cast/providers/manifest.json`. A new provider is a row with `"impl": "openai-compatible"` (base URL, key, model list, keyless flag, curated models, and non-secret settings such as a region). A module is needed for a model-id rewrite or a custom `chat_factory`. Direct prefixes `anthropic-api/`, `bedrock/`, and `ollama/` are reserved in the manifest and are not registered yet. ([#413](https://github.com/scott/castagent/pull/413))

### Changed

- OpenRouter and DigitalOcean serverless inference use that shared class. Prefixes, environment variables, model lists, keychain and token-file lookup, and deploy forwarding are unchanged. `openai/`, `anthropic/`, `google/`, `x-ai/`, and the other OpenRouter vendor ids still use OpenRouter. A bare alias such as `claude-sonnet-4` still uses OpenRouter, including the memory reflection fallback `claude-haiku-latest`. ([#413](https://github.com/scott/castagent/pull/413))
- A reserved direct prefix, or a bare id OpenRouter does not already accept, is an error. `cast model not-a-real-model` names the prefix convention and does not list the catalog. `cast model qwen/qwen3-coder` is an unknown curated OpenRouter id and lists the available ids. Deploy forwards `OPENROUTER_API_KEY` for any slash prefix that is not registered and not reserved, including `qwen/` and `z-ai/`. Deploy forwards no inference key for a reserved prefix. `openai/gpt-4o` still uses OpenRouter. The runtime and reflection catch a routing error and stay in echo mode. ([#413](https://github.com/scott/castagent/pull/413))
- The builder takes sampling parameters from the provider row. OpenRouter and DigitalOcean still send temperature `0.7`. Models that match `omitTemperatureModels` omit temperature: reasoning-style ids such as `o1` and `gpt-5`, and Claude opus, sonnet, or haiku 4.7 and later (dotted or dashed, including 5.x). Explicit Claude 4.7 and later ids are sent as written. Earlier aliases such as `claude-opus-4` and `claude-sonnet-4` still pin to 4.5 and 4.6. A provider with no `defaultParams` no longer receives a hardcoded `0.7`. The runtime and reflection still pass no temperature. ([#413](https://github.com/scott/castagent/pull/413))

## [2.7.0] - 2026-10-20

### Added

- `cast provider` switches the builder's inference provider. The active provider follows the `defaults.builder_model` prefix. Model access keys are read with `--token -` and stored in the system keychain, or in `~/.cast/tokens/inference/<key>.token` (mode 0600) when the keychain cannot load. `cast model <prefix>/<id>` switches to another enabled provider, including a freeform catalog id. Inference URLs must be https, or http on 127.0.0.1, ::1, or localhost. ([#402](https://github.com/scott/castagent/pull/402))

### Changed

- A custom inference base URL stays on the builder. Deploy and upgrade env does not include `OPENROUTER_BASE_URL` or `DIGITALOCEAN_INFERENCE_BASE_URL`. Fly and Railway upgrades do not rewrite inference secrets stored at deploy time. ([#402](https://github.com/scott/castagent/pull/402))

## [2.6.0] - 2026-10-20

### Added

- CLI output snapshots for deploy wording and agent.yaml version messages, and a PR-versus-main compare that lists new failures separately from tests that already fail on the main tip. ([#398](https://github.com/scott/castagent/pull/398))

### Changed

- `CAST_PROVIDER_HTTP_BASE` is a loopback-only testing override for Droplet DigitalOcean API calls and Fly agent-card checks. The value is literal `127.0.0.1` or `::1`. Fly checks it before creating an app, and `cast connect` rewrites the stored URL only for Fly. The path and query stay the same. The override is not stored as the deployment URL. MicroVM calls to api.digitalocean.com are unchanged. Provider CLIs stay on `PATH`. ([#397](https://github.com/scott/castagent/pull/397), [#398](https://github.com/scott/castagent/pull/398))
- The agent image no longer includes gcc. Docker deploys now use `python:3.11-slim-bookworm` instead of `python:3.11-slim`. ([#391](https://github.com/scott/castagent/pull/391))

### Removed

- `cast migrate` is removed. It was a one-time upgrade for agents created before 1.1.0. Opening `cast.db` still creates the `releases` table, and new agents still get a default `memory/config.yaml`. Agents still on a pre-1.1 layout should run `cast migrate` from 2.5.1 before upgrading. ([#389](https://github.com/scott/castagent/pull/389))

### Fixed

- Deploy fails when a `runtime.requirements` pin or upper bound cannot meet the floor. A malformed line fails the same way. Direct references are kept with one warning. Hash options are removed. URL userinfo is masked in messages. Local version segments follow PEP 440 order. ([#393](https://github.com/scott/castagent/pull/393))
- `cast deploy` records `1.0` when agent.yaml has no version. A version that contains whitespace is refused, and a version that is not MAJOR.MINOR or MAJOR.MINOR.PATCH is recorded with one warning. ([#392](https://github.com/scott/castagent/pull/392))
- TUI `/release` suggests the next patch of the current release. For demo-agent, current `1.4.1` suggests `1.4.2`, and a two-part version such as `1.10` suggests `1.10.1`. `/deploy` lists releases newest first and marks the row matching `current.version` as latest ([#390](https://github.com/scott/castagent/pull/390)).
- TUI release and version helpers run in the mocha suite. The disabled subprocess harness is removed ([#390](https://github.com/scott/castagent/pull/390)).

### Security

- Locked `certifi` is 2026.10.19, which fixes GHSA-6q48-6c7w-9gw2. The deploy fallback floor is `certifi>=2026.10.19`. ([#399](https://github.com/scott/castagent/pull/399))

## [2.5.1] - 2026-10-14

### Fixed

- `cast session resume` opens the TUI on the saved session. It launches cast-tui with `--agent`, `--url`, `--mode`, and `--session` ([#179](https://github.com/scott/castagent/pull/179)).
- Inside `cast new`, `/git`, `/undo`, `/redo`, `/describe`, and `/releases` act on the agent the wizard just created. Before an agent exists they say no agent is loaded. `/undo` and `/redo` show the CLI reason in the chat, and child stderr is not painted over the input ([#169](https://github.com/scott/castagent/pull/169)).
- `cast undo` and `cast redo` run in Cast's Python environment. A Python failure is reported as an error instead of "Nothing to undo" ([#171](https://github.com/scott/castagent/pull/171)).

## [2.5.0] - 2026-10-13

### Added

- The docs site searches with Pagefind. A box in the header and a `/search` page filter prose, CLI, slash-command, and provider pages as you type ([#111](https://github.com/scott/castagent/pull/111)).
- `/` and `/help` list the commands for the current UI mode, grouped by category and alphabetized ([#110](https://github.com/scott/castagent/pull/110)).
- An unnamed session shows a one-line topic from that agent's model in the sessions picker and in `cast session list`. The first user message remains the fallback until a topic is stored ([#114](https://github.com/scott/castagent/pull/114)).
- `cast registry` and `/registry` list every live deployment. Release history stays on `cast releases` ([#109](https://github.com/scott/castagent/pull/109)).

### Fixed

- The docs version picker button shows only the version, so the Cast Agent wordmark stays on one line. The open menu still marks the current release as Latest ([#108](https://github.com/scott/castagent/pull/108)).
- Add-skill fields accept a cursor and paste, and a failed install keeps the error inside the modal ([#113](https://github.com/scott/castagent/pull/113)).
- A release from the CLI, the TUI, or the builder writes the SQLite `releases` row as well as `releases.json`. JSON releases missing from SQLite are inserted and existing rows are left as they are ([#112](https://github.com/scott/castagent/pull/112)).

## [2.4.0] - 2026-10-12

### Added

- The docs site shows a version picker beside the logo. Each published release that contains the docs is frozen at `/vX.Y.Z/`. The current release stays at the site root ([#92](https://github.com/scott/castagent/pull/92)).
- `/import` and `cast clone` copy a Cast agent from GitHub or a local directory into `~/.cast/agents/` ([#88](https://github.com/scott/castagent/pull/88)).
- `/shutdown` lists deployments and runs `cast shutdown` for the selected one ([#85](https://github.com/scott/castagent/pull/85)).
- `cast model` and `/model` write `defaults.builder_model`. The builder reads that value when it starts ([#89](https://github.com/scott/castagent/pull/89)).
- Inference providers register by model prefix. Deployed agents receive the API keys that registry declares ([#91](https://github.com/scott/castagent/pull/91)).
- Deployment providers register by key. Built-ins stay railway, fly, digitalocean, microvm, sprites, docker, and local ([#93](https://github.com/scott/castagent/pull/93)).

### Changed

- Connecting to an agent starts a new session. Resuming a previous session stays an explicit action ([#90](https://github.com/scott/castagent/pull/90)).

### Fixed

- Chat streams send an SSE keepalive every 5 seconds so a quiet tool step survives the MicroVM edge timeout ([#83](https://github.com/scott/castagent/pull/83)).
- Folded and literal YAML skill descriptions load as one line ([#86](https://github.com/scott/castagent/pull/86)).
- Skill install accepts `SKILL.md` or `skill.md`, an empty body, and optional license and metadata fields ([#87](https://github.com/scott/castagent/pull/87)).

## [2.3.0] - 2026-10-11

### Added

- DigitalOcean serverless inference is a peer LLM provider. A `digitalocean/<model-id>` model uses `DIGITALOCEAN_MODEL_ACCESS_KEY` and `https://inference.do-ai.run/v1`. OpenRouter stays the default. Deploy paths forward the inference key when it is set ([#74](https://github.com/scott/castagent/pull/74)).
- `/skills` and `cast skills` install a skill directory on the user agent open in the TUI. The runtime appends each `SKILL.md` to that agent's prompt and AgentCard. Scripts in the skill are copied and not run ([#75](https://github.com/scott/castagent/pull/75)).
- `/builder-skills` and `cast builder-skills` install skills the builder reads from `~/.cast/builder/skills/` when creating or editing an agent ([#76](https://github.com/scott/castagent/pull/76)).

## [2.2.0] - 2026-10-11

### Added

- Highlighting text in the TUI copies that selection on mouse-up, in dev, production, and on-host. On-host reaches the local clipboard through OSC 52 ([#69](https://github.com/scott/castagent/pull/69)).
- A reply shows an animated "Working" indicator until the first token arrives, including elapsed seconds after one second ([#71](https://github.com/scott/castagent/pull/71)).
- The TUI opens on the chat screen. The startup splash is gone. A `--welcome` string is still shown as the first chat message when one is passed ([#70](https://github.com/scott/castagent/pull/70)).
- The chat cursor stays in the input after send, slash commands, modal close, and mouse-up. Pressing `/` jumps there when focus is elsewhere ([#72](https://github.com/scott/castagent/pull/72)).

### Fixed

- DigitalOcean image streaming timeouts, with gzip on the image stream, an opt-in on-host TUI, and a larger default droplet ([#44](https://github.com/scott/castagent/pull/44)).
- Deploys wait until Docker is ready on a fresh DigitalOcean droplet ([#42](https://github.com/scott/castagent/pull/42)).
- The docs site uses the GitHub Pages project base path so styles and links resolve ([#50](https://github.com/scott/castagent/pull/50)).
- `install.sh` removes a stale pre-TypeScript `cast` binary that could shadow the TypeScript CLI ([#54](https://github.com/scott/castagent/pull/54)).

## [2.1.0] - 2026-07-17

### Added

- **Docs site restructured into three top-level categories**: Getting
  Started, Building Agents, and Configuration. Building Agents is
  split into three sub-headings: Development Workflow (walkthrough,
  sessions, TUI, slash commands, CLI reference), Versioning
  (overview, undo, Git), and Deployment (overview, releases,
  lifecycle, providers). The Configuration category collects Custom
  tools, MCP servers, and Persistent memory.

- **`building-agents/development-workflow/workflow.md`** — a new
  end-to-end walkthrough from `cast new` to a deployed agent. Each
  step is one command and a link to the reference page that
  documents the depth, plus a "Where to go next" navigation index.

- **`building-agents/versioning/git.md`** — a new reference page for
  `cast git` (init, status, commit, log, diff, push, remote). Covers
  how `cast git` relates to the undo log and to releases, the
  `.castignore` defaults, and the TUI's `/git` slash command.

- **`/sessions` slash command** — opens a modal that lists saved
  sessions for the current agent. Replaces the previous
  `/session-list` form. `Enter` and `R` resume, `F` forks, `N`
  renames, and `D` deletes. Those actions are not separate slash
  commands.

### Changed

- **Session slash surface simplified.** The parent `/session`
  command now accepts only `new` and `resume` as subcommands
  (e.g. `/session new`, `/session resume [id|name]`). The
  hyphenated forms (`/session-list`, `/session-new`,
  `/session-resume`, `/session-rename`, `/session-fork`,
  `/session-delete`) are removed. The CLI subcommands
  (`cast session list|new|resume|...`) are unchanged.

- **Docs section structure:** the old `agents/`, `versioning/`,
  `deployment/`, `tui/`, `cli/`, `configuration/`, `development/`,
  and `guides/` top-level prose sections are folded into the three
  new top-level categories. The contributor pages
  (`docs-site/content/development/architecture.md` and
  `building.md`) are removed from the docs site. The
  `getting-started/configuration` page is renamed to
  `getting-started/global-settings` to disambiguate from the new
  per-agent Configuration category.

- **Versioning overview rewritten** as a 2-column comparison of the
  undo log and the optional `cast git` history. The 3-column
  "Undo log / Releases / Sessions" table is gone — sessions live
  with Development Workflow, and releases live with Deployment.

## [2.0.0] - 2026-07-16

### Added

- **Sessions**: A new first-class concept for saved conversations tied
  to an agent. `cast session list|show|new|resume|rename|fork|delete|export|import|prune`,
  plus matching TUI slash commands (`/session`, `/session-list`,
  `/session-new`, `/session-resume`, `/session-rename`,
  `/session-fork`, `/session-delete`). The TUI auto-creates a session
  on the first chat turn and appends every user/agent message. JSON
  content lives at `~/.cast/sessions/<id>.json`; a metadata index
  lives in `cast.db` for fast listing.

- **Undo/redo**: `cast undo <agent> [--steps N]` and
  `cast redo <agent> [--steps N]` walk an internal change log
  backward and forward. TUI slash commands `/undo` and `/redo` shell
  out to the CLI. A new edit clears the redo stack (standard editor
  behavior). The change log itself is unchanged on disk — it just
  isn't a first-class user concept any more.

### Changed

- **Removed the "changes" first-class surface.** `cast changes`,
  `cast diff`, `cast revert`, and the matching TUI slash commands
  (`/changes`, `/diff`) are gone. The change log at
  `~/.cast/agents/<name>/.cast/changes/` is still on disk and still
  feeds `cast release`'s auto-changelog, but users interact with it
  exclusively through `cast undo` / `cast redo`. `cast restore` no
  longer accepts `--change`; it now requires `--release`.

- The `releases` table's `change_number` field is still populated
  (it points at the most recent undo-log entry at release time), so
  no data migration is required. Existing change tarballs continue to
  work; they are just no longer reachable via a user-facing command.

## [1.1.0] - 2026-06-11

### Added

- **On-Host TUI (`cast-tui`)**: Agents deployed to DigitalOcean now bundle a
  TUI inside the container. SSH into the droplet, `docker exec -it cast-agent bash`,
  and type `cast-tui` to open a chat session that talks directly to the agent
  on `localhost:8080` — identical to `cast connect` but without public network
  exposure or bearer token transport. Falls back to a Python A2A REPL if the
  JS runtime or TUI bundle is unavailable.
  ([#28](https://github.com/scott/castagent/issues/28))

## [1.0.0] - 2026-06-11

### Added

- **Agent Builder**: Full agent creation pipeline with instructions, system prompt, and tool management
- **Deployment Tools**: Deploy agents to Railway, Fly.io, DigitalOcean, Sprites, Docker, and local environments
- **Agent Template**: Starter template for new agents with configurable model, runtime, and tools
- **Versioning System**: Semantic release creation (`cast release`), version listing (`cast releases`), and automatic change tracking (`cast changes`)
- **TUI Slash Commands**: Interactive modal-based commands (`/release`, `/deploy`, `/upgrade`, `/restore`, `/diff`, `/changes`, `/releases`, `/registry`, `/connect`) with keyboard navigation
- **Git Integration**: Built-in Git support for agents (`/git init`, `status`, `add`, `commit`, `push`, `log`, `diff`)
- **Memory System**: Persistent agent memory across sessions
- **Test Coverage Workflow**: Automated CI with TypeScript and Python test suites
- **Migration System**: Tools to migrate agents between environments and configurations

### Deprecated

- `cast versions` command renamed to `cast releases`. The old command still works for one release cycle via a deprecated alias but prints a warning to stderr. Use `cast releases` instead. ([#25](https://github.com/scott/castagent/pull/26))

### Changed

- First official stable release (v1.0.0)

## [0.1.0] - 2026-06-07

### Added
- Initial semantic versioning setup
