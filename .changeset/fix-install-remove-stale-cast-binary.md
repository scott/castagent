---
"cast-cli": patch
"cast-tui": patch
---

fix(install): remove stale Go binary from pre-TypeScript installs

Older (pre-TypeScript-rewrite) versions of Cast installed a Go binary
at `~/.cast/bin/cast`. If `~/.cast/bin` appeared in `$PATH` before
`~/.local/bin`, that binary silently shadowed the new TypeScript CLI
even after `install.sh` set up the correct symlinks. The shadowed
binary looked for agents at `~/cast-agents` (a path that no longer
exists) instead of `~/.cast/agents/`, so users would see "No agents
found" and the wrong version banner.

`install.sh` now removes `~/.cast/bin/cast` on every run, so the
freshly-built TypeScript CLI always wins in `$PATH`. Re-running
`./install.sh` from the project root is a safe, idempotent way to
clear the conflict if a user hits it.

Docs: added a Troubleshooting section to
`docs-site/content/getting-started/install.md` documenting the
symptom and fix.
