# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
