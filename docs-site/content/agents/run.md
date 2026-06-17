---
title: Run an agent locally
section: agents
order: 3
description: cast dev, the A2A server lifecycle, and the TUI vs. headless modes.
ref: ['cli:dev', 'cli:stop', 'cli:logs', 'cli:connect']
---

# Run an agent locally

`{% ref 'cli:dev" %}` is the local-day-to-day command. It boots the runtime
agent as an A2A server on a local port, registers the local run in
`~/.cast/cast.db`, and (by default) attaches the TUI.

## Start

```bash
cast dev email-assistant
```

On success, you'll see:

```
Starting email-assistant in development mode...
Agent running on http://localhost:21357
Launching OpenTUI...
```

The port is allocated dynamically (10000–65535) and recorded in the SQLite
database so `cast list` and `cast describe` can show "[local: running on
port 21357]".

## Headless mode

To run without the TUI — useful for scripts, CI, or remote dev over SSH —
use `--no-tui`:

```bash
cast dev email-assistant --no-tui
```

The A2A endpoint is printed and the process stays in the foreground. Press
Ctrl+C to stop.

## Fixed port

If you need a stable port (e.g. for `curl http://localhost:8080/...`):

```bash
cast dev email-assistant --port 8080
```

The runtime fails with a clear error if the port is in use.

## Stop

```bash
cast stop email-assistant
```

`{% ref 'cli:stop" %}` sends SIGTERM to the recorded PID and removes the
local-agent row from the database. Use `cast list` to confirm.

## Logs

`{% ref 'cli:logs" %}` tails the runtime's stdout/stderr. It works for
both local runs and (where the provider supports it) for deployed agents.

```bash
cast logs email-assistant
```

## The TUI lifecycle

When you launch with the TUI:

1. Cast starts the Python runtime as a child process.
2. The runtime prints `Agent ready on port N` to stdout.
3. Cast captures the port, stores it, then spawns the TUI process
   (Bun + OpenTUI) with `--url http://localhost:N` and `--mode dev`.
4. The TUI takes over the terminal with a fullscreen chat interface.
5. When the TUI exits, Cast tears down the runtime and you land back at
   the shell.

Inside the TUI, `{% ref 'slash:stop" %}` does the same thing as
`cast stop` from the CLI — it tears down the runtime and exits.

## When the agent doesn't exist yet

```bash
cast dev brand-new-agent
```

If `brand-new-agent` doesn't exist at `~/.cast/agents/brand-new-agent/`,
`cast dev` first launches the Builder Agent to create it (same flow as
`cast new`). When the conversation ends, the runtime boots and the TUI
attaches.

This is convenient but for the first-time experience we recommend running
`cast new` separately, then `cast dev`, so the two phases are easy to
understand.
