---
title: Run an agent locally
section: building-agents
order: 5
description: cast dev, the A2A server lifecycle, and the TUI vs. headless modes.
ref: ['cli:dev', 'cli:stop', 'cli:logs', 'cli:connect']
---

# Run an agent locally

`{% ref "cli:dev" %}` is the local-day-to-day command. It boots the runtime
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

## When the agent does not exist yet

`cast dev <name>` runs an agent that is already on disk. If
`~/.cast/agents/<name>/` is missing, dev mode starts the new-agent flow
for that name. The builder asks what the agent should do, then creates
`~/.cast/agents/<name>/`. It does not claim a configuration was loaded.

`cast update`, `cast deploy`, and `cast upgrade` do not create agents.
When the directory is missing they tell you to run `cast new`.

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

`{% ref "cli:stop" %}` stops the run that is active on this machine.

For a local agent started with `{% ref "cli:dev" %}`, it sends SIGTERM to
the recorded PID and removes the local-agent row from the database. Use
`cast list` to confirm. `--force` sends SIGKILL instead.

For a Docker deployment, it runs `docker stop` on the container
`cast-<name>` when that container is running. The deployment stays in
the registry, and the memory volume stays in place. `{% ref "cli:shutdown" %}`
removes the container, the `cast-<name>:latest` image, and the volume. `--force` stops that container
with no grace period (`docker stop --time 0`). `docker stop` marks the
container as stopped, so a restart policy of `unless-stopped` does not
start it again.

If the recorded local PID is already gone, `cast stop` still stops a
running Docker container for that agent.

## Logs

`{% ref "cli:logs" %}` prints the runtime's stdout and stderr.

For a local agent, `{% ref "cli:dev" %}` and `cast session resume` record
that output in `~/.cast/logs/<name>.log` while the runtime is running.
`cast logs` prints the file, including a crash from a run that already
exited.

For a Docker deployment, `cast logs` prints the output of
`docker logs cast-<name>`, including a container that has already exited.
When the agent has more than one live deployment, pass the deployment SHA.
Other providers are not read by this command.

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

Inside the TUI, `{% ref "slash:stop" %}` stops the local runtime the
same way `{% ref "cli:stop" %}` does from another shell. The TUI stays
open and shows that the agent stopped. Leave with `/quit` or Ctrl+C.

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
