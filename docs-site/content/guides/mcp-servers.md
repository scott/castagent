---
title: MCP servers
section: guides
order: 2
description: Configuring Model Context Protocol servers (Gmail, Slack, etc.) in an agent.
ref: ['cli:new', 'cli:edit']
---

# MCP servers

Cast agents can use [Model Context Protocol](https://modelcontextprotocol.io)
servers to add capabilities — sending email, reading Slack, querying a
database, anything an MCP server exposes.

## What the agent sees

An MCP server adds a set of tools to the agent at runtime. The LLM sees
the tool names, descriptions, and schemas, and can call them as part of
its reasoning. From the agent's point of view, an MCP tool is just
another tool in its toolbox.

## Configuration

MCP servers are configured per-agent under `~/.cast/agents/<name>/mcp/`.
One YAML file per server:

```yaml
# ~/.cast/agents/email-assistant/mcp/gmail.yaml
server: gmail
command: npx -y @gongrzhe/server-gmail-autoauth-mcp
env:
  GMAIL_CREDENTIALS_PATH: ~/.cast/vault/email-assistant/gmail-oauth.json
```

The `server` key is the MCP server's identifier (used in `agent.yaml`).
The `command` is what the runtime spawns; the MCP protocol runs over
stdio between the agent and the server process. `env` is passed through.

The runtime is responsible for keeping the MCP server process alive and
proxying tool calls.

## Wiring into agent.yaml

After the YAML is in place, list the server in `agent.yaml`:

```yaml
tools:
  mcp:
    - server: gmail
      config: mcp/gmail.yaml
```

Or, equivalently, use the Builder during `cast edit`:

> "Add the Gmail MCP server to this agent."
>
> "Authenticate with my Google account."

The Builder writes the YAML and walks you through the OAuth flow if the
server needs it.

## OAuth credentials

Some MCP servers need an OAuth login. Cast stores the resulting tokens
in `~/.cast/vault/<agent-name>/<server>-oauth.json` (mode 0600). On
deploy, these files are bundled into the image and re-mounted at the
same path inside the container.

For Gmail, the Builder uses Google's OAuth flow with a callback on
`http://localhost:3000/oauth/callback`. The CLI prints the URL when it's
time to authorize.

## Hot-reload during development

`cast dev` watches the `mcp/` directory. Drop a new YAML in, and the
runtime restarts the MCP server and registers the new tools. Bad YAML
makes the runtime log the parse error and continue with the previously
working server list.

## Deploying with MCP

MCP server images must be available in the deployment environment.
Some MCP servers (`npx -y ...`) require Node.js in the image; Cast's
default runtime image includes Node 20 and Bun so most MCP servers
work out of the box.

If your MCP server needs a long-lived state (e.g. a local index), put
that state under `~/.cast/agents/<name>/mcp-data/` so the volume mount
includes it.

## Adding a custom MCP server

If you want to add an MCP server that's not in the Builder's
catalogue:

1. Create `~/.cast/agents/<name>/mcp/<server-name>.yaml` with the
   `server:`, `command:`, and any `env:` keys.
2. Add the entry to `agent.yaml` under `tools.mcp`.
3. `cast dev` to load it; check the TUI header for any startup errors.
4. When the agent calls one of the new tools, the runtime proxies the
   call to your MCP server and returns the result.
