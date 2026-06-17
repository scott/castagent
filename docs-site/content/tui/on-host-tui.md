---
title: On-host TUI
section: tui
order: 3
description: SSH into a deployed DigitalOcean container and chat without going over the public network.
ref: ['cli:deploy', 'cli:connect']
---

# On-host TUI

`cast-tui` is the TUI binary bundled *inside* the deployed container. You
reach it by SSHing into the DigitalOcean droplet and running `cast-tui`
inside the agent container. It is functionally identical to
`cast connect` — streaming responses, slash commands, full chat
experience — with two important differences:

1. **No public network exposure.** The chat traffic stays on the
   container's loopback to the A2A server on `localhost:8080`. The
   bearer token never leaves the container.
2. **No bearer token over the wire.** The agent's `AUTH_TOKEN` is
   inherited from the container's environment, so the TUI uses it
   locally without any HTTPS round-trip.

## When to use it

- You want to chat with a deployed agent but don't want to expose its
  A2A port publicly (or you don't want to authenticate over the
  network).
- You're debugging a deploy and want to talk to the agent exactly as it
  runs in production, not as it runs on your laptop.
- You're operating in an environment where the only ingress is SSH
  (locked-down VPC, restricted egress, etc.).

The trade-off is you need shell access to the droplet, which means
possession of the SSH key at `~/.ssh/cast_do_key`.

## Opting in

The on-host TUI is **off by default** because the bundle is large
(~100 MB: Node deps + Bun). To opt in, deploy with `--with-tui`:

```bash
cast deploy email-assistant --provider digitalocean --with-tui
```

You can also pass `--with-tui` to `cast upgrade` to add the TUI to an
existing DigitalOcean deployment without redeploying. Removing the flag
and re-deploying strips the TUI from the image on the next deploy.

## Using it

```bash
# 1. Find the droplet IP from the deploy output
ssh -i ~/.ssh/cast_do_key root@<droplet-ip>

# 2. Enter the agent container
docker exec -it cast-agent bash

# 3. Launch the on-host TUI
cast-tui
```

The MOTD that the deploy writes to `/etc/motd` advertises the TUI when
it's bundled — it tells you the A2A URL, the agent name, and the
`cast-tui` command in one line. If the TUI is not bundled the MOTD
omits the hint so you don't run a command that isn't there.

## Fallback: Python REPL

If the on-host TUI binary is missing *or* the container has no Node/Bun
runtime, `cast-tui` falls back to a Python A2A REPL — plain readline
input, no TUI. Functionally it can do anything the TUI can; you just
lose syntax highlighting, modals, and slash-command autocompletion.

The deploy flow decides which mode to advertise in the MOTD by
SSH'ing into the droplet and running
`docker exec cast-agent test -e /usr/local/bin/cast-tui` after the
image is loaded. If that returns success, the MOTD shows the TUI
command; otherwise it stays silent.

## Security model

The on-host TUI is *not* a stronger privilege boundary than
`cast connect` — it's a different one. With `cast connect` you need
the bearer token. With `cast-tui` you need the SSH key. Both let you
talk to the agent.

The MOTD is also a privilege cue: it tells you which mode you're in
and which path you took to get there. Read it.

> **Note:** Anyone with the SSH key and droplet IP who can
> `docker exec` into the container can also run `cast-tui` with the
> agent's `AUTH_TOKEN` (inherited from the container environment). Keep
> the key at `~/.ssh/cast_do_key` secured. This matches the existing
> privilege model — the SSH key already grants full root access to
> the droplet.
