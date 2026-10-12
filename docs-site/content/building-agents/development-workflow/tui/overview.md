---
title: TUI overview
section: building-agents
group: development-workflow
order: 3
description: The chat screen, header modes, and the difference between dev / production / on-host.
ref: ['cli:dev', 'cli:connect']
---

# TUI overview

The Cast terminal UI is a fullscreen chat client built on OpenTUI. You see
it whenever you run `{% ref "cli:dev" %}` (local) or
`{% ref "cli:connect" %}` (deployed). The TUI is also what
[`cast-tui`](building-agents/development-workflow/tui/on-host-tui) runs when launched inside a deployed
container.

## Anatomy

```
+-----------------------------------------------------------------+
| . email-assistant (v1.6)                            [PLAN]       |  <- header
+-----------------------------------------------------------------+
|                                                                 |
|  agent:    Hi! I'm email-assistant. I help triage               |
|            incoming mail. What's on your mind?                  |
|                                                                 |
|  you:      What did I get from alice@acme.com yesterday?        |
|                                                                 |
|  agent:    You got two messages:                                |  <- messages
|            - "Re: design review" — about the new layout         |     (scrolls)
|            - "Quarterly numbers" — the Q1 deck                   |
|                                                                 |
+-----------------------------------------------------------------+
| > _                                                            |  <- input
+-----------------------------------------------------------------+
```

Three regions, top to bottom: a 1-line **header**, a scrollable
**messages** area, and the **input** line. The header color and contents
change based on the [UI mode](building-agents/development-workflow/tui/modes).

## Two chat modes: PLAN and BUILD

Inside the chat you can switch between two modes with `{% ref "slash:mode" %}`
(or by clicking the badge in the header):

- **PLAN** (green) — the agent proposes actions, shows its reasoning,
  and asks for confirmation before doing anything destructive. The
  default for new sessions.
- **BUILD** (yellow) — the agent executes immediately without
  confirmation. Faster, but be careful.

The mode is purely a runtime hint; the agent's `instructions.md` may
treat the two modes differently (some agents are stricter in PLAN, some
encourage autonomy in BUILD).

## Three UI modes: dev, production, on-host

The header bar reflects which *environment* the TUI is connected to:

| Mode | Header color | When |
|---|---|---|
| `dev` | purple | `cast dev` (local runtime) |
| `production` | green | `cast connect` to a deployed agent |
| `on-host` | green | `cast-tui` inside a DigitalOcean container |

In dev and production the header shows the deployed version (e.g.
`email-assistant (v1.6)`); in dev without a deployment the version is
hidden. See the [modes page](building-agents/development-workflow/tui/modes) for the details and screenshots.

## Streaming

The TUI streams A2A responses as the agent produces them. The message
bubble grows in place rather than appearing all at once; long responses
scroll automatically while you read.

A reply shows an animated "Working" indicator until the first token arrives.

## Slash commands

The input line accepts `/` commands. The full list is on the
[slash commands page](tui/slash-commands); the most useful ones to know
on day one:

- `{% ref "slash:help" %}` — list all commands available in the current mode.
- `{% ref "slash:mode" %}` — toggle PLAN/BUILD.
- `{% ref "slash:save" %}` — save the transcript to a Markdown file.
- `{% ref "slash:copy" %}` — copy the last agent reply to the clipboard.
- `{% ref "slash:clear" %}` — clear the chat (keeps the agent connection).

Highlighting text with the mouse copies that selection to the clipboard
in dev, production, and on-host. On-host reaches the local clipboard
through OSC 52.

Slash commands that need input (a version, a name, a SHA) open a modal
instead of requiring flag syntax. You don't need to memorise anything;
type `/` and autocomplete kicks in. The cursor stays in the input, and
`/` jumps there when focus is elsewhere.
