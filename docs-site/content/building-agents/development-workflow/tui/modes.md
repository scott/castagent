---
title: Modes (dev, production, on-host)
section: building-agents
group: development-workflow
order: 4
description: How the three UI modes change the look, feel, and available commands.
ref: ['cli:dev', 'cli:connect', 'slash:help', 'slash:connect', 'slash:upgrade']
---

# Modes

The TUI has one *chat mode* (PLAN / BUILD) and three *UI modes* (dev /
production / on-host). They are independent: a production-mode TUI can
still be in PLAN chat mode, and so on.

## dev

Triggered by `cast dev <agent>`. The TUI connects to a local runtime on
a dynamic port. The header is **purple** and shows just the agent name.

```
+---------------------------------------------------------------+
| . email-assistant                                  [PLAN]      |
+---------------------------------------------------------------+
```

- The runtime is killed when you quit the TUI.
- `/undo`, `/redo`, `/sessions`, `/session …`, `/releases`, `/release`,
  `/deploy`, `/upgrade`, `/import`, and `/shutdown` are all available — you're
  working on the agent on this machine. `/import` is also available in production.
- `/connect` switches to a *different* deployed agent (useful for
  comparing local behaviour to production).
- No bearer token is required.

## production

Triggered by `cast connect <agent-or-sha>`. The TUI connects to a
deployed A2A server over HTTPS. The header is **green** and includes the
deployed version.

```
+---------------------------------------------------------------+
| . email-assistant (v1.6)                       [● LIVE  v1.6] |
+---------------------------------------------------------------+
```

- Bearer-token auth is added by `cast connect`; the TUI does not display
  the token, but the underlying A2A client carries it.
- The same slash commands work, but the destructive ones
  (`/release`, `/deploy`, `/upgrade`) are scoped to the
  *currently-connected* deployment's agent. `/shutdown` lists every
  active deployment and can tear one down.
- `/connect` lets you jump to a different deployment or to a different
  agent's deployment without exiting the TUI.

## on-host

Triggered by running `cast-tui` inside a DigitalOcean container
(see [on-host TUI](building-agents/development-workflow/tui/on-host-tui)). The header is also green, but
**no version badge** appears because the TUI is talking to a local A2A
server inside the same container.

```
+---------------------------------------------------------------+
| . email-assistant                                 [● LIVE]     |
+---------------------------------------------------------------+
```

The available commands are intentionally trimmed:

- `/help` — show the trimmed help (no `agent`-category commands).
- `/clear` — clear the chat.
- `/copy` — copy the last reply.
- `/quit`, `/exit` — exit the TUI.

There is no network exposure, no bearer token crossing a wire, and no
chance of accidentally targeting a different deployment. The chat is
effectively a local REPL against the deployed container's runtime.

## What the modes are NOT

- A *security* boundary. A production-mode TUI can still be tricked
  into running a destructive slash command if the agent's prompt allows
  it. The mode is a visual cue and a UX contract, not a sandbox.
- *Persistent*. The mode is per-session. Each new TUI process starts in
  the default for that mode (PLAN in dev, PLAN in production).
- *Configurable*. There are no flags to change the default mode or the
  header colors. The header colors are part of the visual language.
