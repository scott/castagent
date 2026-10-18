# Cast: Agent Building & Deployment Platform — Specification

## Overview

Cast is a CLI+TUI application that helps developers create, test, and deploy AI agents. It consists of:

- **TypeScript CLI/TUI**: User-facing interface built with oclif and OpenTUI
- **Builder Agent**: Python/LangChain agent that helps users create new agents (stdio JSON-RPC)
- **Runtime Agents**: Python/LangChain agents created by users (A2A over HTTP)
- **Meta-Builder**: Test harness that verifies the Builder Agent works correctly

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    TypeScript CLI / TUI (oclif + OpenTUI)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  oclif   │  │ OpenTUI  │  │  Agent       │  │  MCP Manager           │  │
│  │  CLI     │  │  TUI     │  │  Supervisor  │  │  (keytar)              │  │
│  └──────────┘  └──────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                              │
│  Responsibilities:                                                           │
│  - CLI commands: cast dev/test/deploy/connect/meta                          │
│  - OpenTUI rendering and user interaction                                    │
│  - Spawn Builder Agent via stdio JSON-RPC (local development)               │
│  - Spawn Runtime Agent via A2A HTTP (dynamic port allocation)              │
│  - MCP server lifecycle management                                           │
│  - SQLite state management (plain SQLite)                                   │
│  - Deployment to Railway, Fly.io, DigitalOcean, Docker, Local              │
│  - Token storage via keytar (system keychain)                              │
│  - A2A client for runtime agent communication                              │
└──────────────────────────────────────────────────────────────────────────────┘
           │ stdio JSON-RPC              │ A2A over HTTP (local & deployed)
           ▼                             ▼
┌───────────────────────┐    ┌──────────────────────────────────────────────────┐
│   Builder Agent       │    │          Runtime Agent                            │
│   (Python/LangChain)  │    │          (Python/LangChain)                       │
│                       │    │                                                   │
│   Tools:              │    │   Tools:                                          │
│   - create_agent      │    │   - bash, read, glob                              │
│   - update_config     │    │   - MCP integrations                              │
│   - install_mcp       │    │   - Custom user tools                             │
│   - recommend_model   │    │                                                   │
│   - list_agents       │    │   A2A HTTP Server (dynamic port 10000-65535)      │
│   - get_agent_config  │    │   LangChain AgentExecutor                         │
│                       │    │   AgentCard for discoverability                   │
│   stdin/stdout        │    │   Bearer token auth (deployed)                    │
│   JSON-RPC            │    │                                                   │
└───────────────────────┘    └──────────────────────────────────────────────────┘
```

---

## Key Decisions

| Decision | Choice |
|----------|--------|
| CLI Language | TypeScript (oclif) |
| TUI Framework | OpenTUI (native Zig core + TS bindings) |
| Agent Language | Python (LangChain) |
| Builder Agent Communication | stdio JSON-RPC |
| Runtime Agent Communication | A2A over HTTP |
| Local Agent Port | Dynamic allocation (10000-65535) |
| Database | Plain SQLite (no SQLCipher) |
| Token Storage | keytar (system keychain) |
| LLM Provider | OpenRouter v1, others extensible |
| Agent Framework | LangChain `AgentExecutor` + `@tool` decorators |
| Deployment Providers | Railway, Fly.io, DigitalOcean, Docker, Local |
| Production Auth | Bearer token (deployed), none (local) |
| Production TUI | Green theme, hidden thought process, no auto-reconnect |
| Meta-builder | TypeScript CLI + Python test scenarios |

---

## Directory Structure

```
~/.cast/                           # Cast global state
├── config.yaml                    # Global configuration
├── cast.db                        # Plain SQLite database
├── vault/                         # Credential storage (unencrypted, rely on filesystem)
│   └── <agent-name>/
│       └── gmail-oauth.json
├── providers.yaml                 # Deployment provider API keys
├── tokens/                        # Agent auth tokens (keytar-backed)
│   └── <agent-name>.token
└── builder/
    ├── instructions.md            # Builder Agent system prompt
    ├── tools/                     # Builder Agent's tools (Python)
    └── skills/                    # Skills the builder follows while creating or editing agents
        └── <skill-name>/
            └── SKILL.md           # name, one-line description, and instructions

~/.cast/agents/                    # User's agents
└── <agent-name>/
    ├── agent.yaml                 # Agent definition
    ├── instructions.md            # Agent's brain (system prompt)
    ├── skills/                    # Installed skills (SKILL.md at each skill root)
    │   └── <skill-name>/
    │       └── SKILL.md
    ├── tools/                     # Custom Python tools
    │   └── my_tool.py
    ├── tests/
    │   ├── cli/                   # TypeScript CLI tests
    │   └── agent/                 # Python agent tests
    │       └── scenarios/         # Test cases
    ├── mcp/                       # MCP server configs
    │   └── gmail.yaml
    └── .cast/                     # Agent-specific overrides
        └── provider.yaml          # Agent-specific LLM override

castagent/                        # Project repo
├── typescript/                    # TypeScript CLI/TUI
│   ├── cast-cli/                  # oclif CLI
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   │   ├── list.ts
│   │   │   │   ├── dev.ts
│   │   │   │   ├── test.ts
│   │   │   │   ├── deploy.ts
│   │   │   │   ├── connect.ts
│   │   │   │   ├── logs.ts
│   │   │   │   ├── update.ts
│   │   │   │   ├── delete.ts
│   │   │   │   └── meta/
│   │   │   │       └── test.ts
│   │   │   └── lib/
│   │   │       ├── opentui.ts         # OpenTUI integration
│   │   │       ├── sqlite.ts          # State management
│   │   │       ├── keychain.ts        # Token storage (keytar)
│   │   │       ├── mcp.ts             # MCP manager
│   │   │       ├── a2a/
│   │   │       │   ├── client.ts      # A2A client implementation
│   │   │       │   └── protocol.ts    # A2A type definitions
│   │   │       ├── builder/
│   │   │       │   └── stdio.ts       # stdio JSON-RPC bridge for Builder
│   │   │       └── deploy/
│   │   │           ├── railway.ts
│   │   │           ├── fly.ts
│   │   │           ├── digitalocean.ts
│   │   │           └── docker.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cast-tui/                  # OpenTUI TUI
│       ├── src/
│       │   ├── index.ts
│       │   ├── screens/
│       │   │   └── chat.ts            # Chat screen
│       │   └── components/
│       │       ├── header.ts
│       │       ├── messages.ts
│       │       └── input.ts
│       └── package.json
├── python/                        # Python runtime
│   └── cast/
│       ├── __main__.py           # CLI entry point
│       ├── agent/
│       │   ├── __init__.py
│       │   ├── base.py           # LangChain AgentExecutor base class
│       │   ├── builder.py        # Builder Agent (stdio JSON-RPC)
│       │   └── runtime.py        # Runtime Agent (A2A HTTP server)
│       ├── tools/
│       │   ├── __init__.py
│       │   ├── bash.py           # Built-in bash tool
│       │   ├── read.py           # Built-in file read tool
│       │   └── glob.py           # Built-in file glob tool
│       ├── harness/
│       │   ├── permissions.py    # Permission checker
│       │   └── principles.py     # Constitutional principles
│       └── providers/
│           ├── registry.py       # get_provider(model)
│           ├── manifest.json     # Built-in catalog rows
│           ├── catalog.py        # python -m cast.providers.catalog
│           ├── openrouter.py     # Default inference provider
│           ├── digitalocean.py   # digitalocean/ prefix binding
│           ├── digitalocean_inference.py  # Serverless inference client
│           ├── anthropic.py      # Placeholder
│           ├── openai.py         # Placeholder
│           └── ollama.py         # Placeholder
├── tests/                         # Test suites
│   ├── ts/                       # TypeScript CLI tests
│   │   ├── commands/
│   │   └── lib/
│   └── python/                   # Python agent tests
│       ├── unit/
│       └── integration/
├── docs/
│   └── SPEC.md                   # This document
└── README.md                      # Project readme
```

---

## CLI Commands

```
cast --help                         # Show general help
cast list                           # List all agents in ~/.cast/agents/
cast <agent-name>                   # Run agent (dev if exists, else builder)
cast <agent-name> dev               # Development mode (local A2A server)
cast <agent-name> test              # Run test scenarios
cast <agent-name> deploy            # Deploy to hosting provider
cast <agent-name> shutdown          # Shut down deployed agent (destroy remote resources)
cast <agent-name> connect           # Connect to deployed agent
cast <agent-name> logs              # View runtime logs
cast <agent-name> update            # Update agent configuration
cast <agent-name> delete            # Delete agent
cast meta test                      # Run meta-builder tests
```

### `cast --help` Output

```
Cast - Agent Building & Deployment Platform

Usage:
  cast list                      List all agents
  cast <agent>                  Start/create agent
  cast <agent> dev              Development mode
  cast <agent> test             Run test scenarios
  cast <agent> deploy           Deploy to provider
  cast <agent> shutdown         Shut down deployed agent
  cast <agent> connect          Connect to deployed agent
  cast meta test                Run meta-builder tests

Examples:
  cast list                       List all agents
  cast email-agent dev           Start email-agent locally
  cast email-agent deploy        Deploy to cloud
  cast email-agent shutdown      Tear down cloud deployment
  cast email-agent connect       Chat with deployed agent

For more help: cast <command> --help
```

### `cast list` Output

```
Agents in ~/.cast/agents/

  email-agent     [deployed: railway]
  slack-bot       [local]
  data-pipeline   [deployed: fly]

Run 'cast <agent-name> dev' to start an agent.
```

---

## File Formats

### `agent.yaml`

```yaml
name: email-agent
version: "1.0"
description: "Automates email triage and draft replies"

brain:
  model: openrouter/anthropic/claude-3-5-sonnet
  model_override: null
  instructions_file: instructions.md

harness:
  permissions:
    gmail.read: always-allow
    gmail.classify: always-allow
    email.draft: approve-once
    filesystem.read: always-allow
    filesystem.write: block
  principles:
    - "When uncertain, ask the user"
    - "Prefer drafting over sending"

tools:
  builtin:
    - bash
    - read
    - edit
  mcp:
    - server: gmail
      config: mcp/gmail.yaml
  custom:
    - email_tools
    - path: tools/my_tool.py

runtime:
  python_version: "3.11"
  requirements: []

deployment:
  provider: railway
  schedule: "*/15 * * * *"
  webhook: null
  resources:
    memory: 512Mi
    cpu: 0.5
```

`tools.custom` entries are module name strings or objects with `path`. `cast describe` prints the string or the path. The runtime loads `tools.builtin` and leaves `tools.custom` unloaded.

### `~/.cast/config.yaml`

```yaml
cast:
  version: "1.0"

defaults:
  agent_storage: ~/.cast/agents
  builder_model: openrouter/anthropic/claude-4-sonnet
  deployment_provider: railway

providers:
  openrouter:
    api_key: ${OPENROUTER_API_KEY}
    default_base_url: https://openrouter.ai/api/v1
  digitalocean_inference:
    api_key: ${DIGITALOCEAN_MODEL_ACCESS_KEY}
    default_base_url: https://inference.do-ai.run/v1
  # Future:
  # anthropic:
  #   api_key: ${ANTHROPIC_API_KEY}
  # ollama:
  #   base_url: http://localhost:11434
  #   model: llama3

deployment:
  railway:
    api_token: ${RAILWAY_API_TOKEN}
    project_id: ${RAILWAY_PROJECT_ID}
  digitalocean:
    api_token: ${DO_API_TOKEN}
    app_id: ${DO_APP_ID}
  fly:
    api_token: ${FLY_API_TOKEN}
  docker:
    registry: localhost:5000
```

### `~/.cast/cast.db` (SQLite Schema)

```sql
-- Builder Agent state
CREATE TABLE builder_sessions (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    current_agent_name TEXT,
    conversation_history TEXT
);

-- Created agents metadata
CREATE TABLE agents (
    name TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    agent_yaml_path TEXT,
    last_run_at DATETIME,
    run_count INTEGER DEFAULT 0
);

-- MCP connections per agent
CREATE TABLE agent_mcp (
    agent_name TEXT,
    server_name TEXT,
    config_path TEXT,
    credentials_path TEXT,
    PRIMARY KEY (agent_name, server_name)
);

-- LLM provider configurations
CREATE TABLE provider_configs (
    provider TEXT PRIMARY KEY,
    config_json TEXT
);

-- Deployed agents
CREATE TABLE deployments (
    agent_name TEXT PRIMARY KEY,
    provider TEXT,
    deployment_url TEXT,
    auth_token_hash TEXT,
    deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_connected_at DATETIME
);

-- Local agent processes (dynamic port tracking)
CREATE TABLE local_agents (
    agent_name TEXT PRIMARY KEY,
    pid INTEGER,
    port INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME
);
```

---

## Builder Agent

### Purpose
Conversational agent that helps users create new agents through interactive TUI conversation. Communicates via stdio JSON-RPC with the TypeScript CLI.

### Communication Pattern

The TypeScript CLI spawns the Builder Agent as a subprocess:

```typescript
// TypeScript CLI spawns Builder Agent
const builder = spawn('python', ['-m', 'cast.builder'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// Send JSON-RPC messages via stdin
builder.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { agent_name: "email-agent" }
}) + "\n");

// Receive JSON-RPC messages via stdout
builder.stdout.on('data', (data) => {
  const message = JSON.parse(data.toString());
  // Handle response
});
```

### Conversation Flow

```
User: cast email-agent

[Agent doesn't exist - launch Builder Agent]

Builder Agent: "What should email-agent do?"
User: "I want it to read my gmail inbox, categorize emails as spam/medium/high importance, and draft replies for high importance ones"

Builder Agent: "Got it! Let me create that agent for you."

[Builder Agent uses tools:]
1. create_agent(name="email-agent")
2. update_instructions(<<EOF
You are an email automation assistant that...
EOF)
3. update_agent_config(<<EOF
harness:
  permissions:
    gmail.read: always-allow
    ...
tools:
  mcp:
    - server: gmail
install_mcp(server="gmail")
  --> "This requires OAuth. Should I open your browser?"

User: "Yes"
  --> OAuth flow in browser
  --> Credentials stored in ~/.cast/vault/email-agent/

Builder Agent: "Your email-agent is ready!
Recommended model: openrouter/anthropic/claude-3-5-sonnet
You can change this in agent.yaml."

[Builder Agent exits, TypeScript CLI spawns Runtime Agent]
```

### Builder Agent Tools

| Tool | Description |
|------|-------------|
| `create_agent` | Creates `~/.cast/agents/<name>/` scaffold |
| `update_agent_config` | Modifies `agent.yaml` |
| `update_instructions` | Updates `instructions.md` |
| `install_mcp` | Installs MCP server + handles OAuth |
| `list_agents` | Lists existing agents |
| `get_agent_config` | Reads existing agent config |
| `recommend_model` | Suggests model based on requirements |

### Model Recommendation Logic

| Task Type | Recommended Model |
|-----------|-------------------|
| Simple automation, classification | `claude-3-haiku`, `gpt-4o-mini` |
| General coding/development | `claude-3-5-sonnet`, `gpt-4o` |
| Complex reasoning, long context | `claude-4-sonnet`, `claude-4-opus` |
| Local (no API) | `llama3`, `mistral` |

### System Prompt

```markdown
# Cast Builder Agent

You are the Cast Builder Agent, designed to help users create AI agents.

## Your Mission

Through conversation, understand what the user wants their agent to do, then:
1. Create the agent scaffold in ~/.cast/agents/<agent-name>/
2. Configure MCP integrations they need
3. Recommend appropriate models
4. Ensure the agent is ready to run

## Your Personality

- **Curious but focused**: Ask clarifying questions
- **Helpful and proactive**: Suggest useful tools
- **Transparent**: Explain what you're doing
- **Security-conscious**: Recommend appropriate permissions

## Security Guidelines

- Never suggest always-allow for destructive operations
- Recommend ask for sending or deleting
- Be explicit about what data the agent will access

## agent.yaml shape

Write brain.model, tools.builtin, and harness.permissions. Do not set a
top-level model, a tools list, top-level permissions, or memory.
Permission levels are always-allow, ask, and deny. Tell the user a
setting changed only when the tool result lists it under Applied.
```

---

## Runtime Agent

### Architecture

Runtime Agents use **LangChain** with the `AgentExecutor` pattern:

```python
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_openai import ChatOpenAI

class RuntimeAgent:
    def __init__(self, config: AgentConfig):
        self.llm = ChatOpenAI(
            model=config.model,
            temperature=0.7,
            api_key=config.api_key,
            base_url=config.base_url,
        )
        
        self.tools = self._load_tools(config.tools)
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", config.instructions),
            MessagesPlaceholder(variable_name="chat_history"),
            ("user", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ])
        
        agent = create_tool_calling_agent(self.llm, self.tools, prompt)
        self.executor = AgentExecutor(
            agent=agent,
            tools=self.tools,
            verbose=True,
            max_iterations=25,
            handle_parsing_errors=True,
        )
    
    async def process_message(self, message: str, chat_history: list) -> str:
        result = await self.executor.ainvoke({
            "input": message,
            "chat_history": chat_history,
        })
        return result["output"]
```

### Tool Definition Pattern

Tools use the `@tool` decorator with docstrings for schema generation:

```python
from langchain_core.tools import tool

@tool
def search_web(query: str) -> str:
    """
    Search the web for research material on a given topic.
    Returns the top 5 results with titles, snippets, and URLs.
    Use short, simple queries (2-4 words) for best results.
    
    Args:
        query: The search query to research. Keep it short and simple.
    """
    # Implementation
    return results

@tool
def publish_to_blog(title: str, content: str = "", tags: str = "") -> str:
    """
    Publish a blog post to the configured blog.
    
    Args:
        title: The title of the blog post.
        content: The article body in HTML.
        tags: Comma-separated list of tags.
    """
    # Implementation
    return result
```

### AgentCard.json

Each agent includes an `AgentCard.json` for A2A discoverability:

```json
{
  "protocolVersion": "0.2.9",
  "name": "Email Agent",
  "description": "Automates email triage and draft replies",
  "url": "http://localhost:10007/",
  "preferredTransport": "JSONRPC",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true,
    "chat_agent": true
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "email-triage",
      "name": "Email Triage",
      "description": "Read and categorize incoming emails"
    },
    {
      "id": "draft-replies",
      "name": "Draft Replies",
      "description": "Draft responses for important emails"
    }
  ]
}
```

---

## Python ↔ TypeScript Protocol

### Builder Agent: stdio JSON-RPC

```json
// TypeScript → Python: Initialize
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "agent_name": "email-agent",
    "agent_path": "/Users/scott/.cast/agents/email-agent"
  }
}

// Python → TypeScript: Output
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "output",
  "params": {
    "type": "text",
    "content": "I'll help you..."
  }
}

// Python → TypeScript: Tool Call
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tool_call",
  "params": {
    "tool": "create_agent",
    "args": {"name": "email-agent"},
    "call_id": "call_abc123"
  }
}

// TypeScript → Python: Tool Result
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "call_id": "call_abc123",
    "output": "Agent created successfully"
  }
}

// Python → TypeScript: Approval Request
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "approval_request",
  "params": {
    "tool": "install_mcp",
    "description": "Install Gmail MCP server (requires OAuth)"
  }
}

// TypeScript → Python: Approval Response
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "approved": true,
    "modified_content": null
  }
}
```

### Runtime Agent: A2A over HTTP

```typescript
// TypeScript A2A Client
import { A2AClient } from './lib/a2a/client';

const client = new A2AClient({
  baseUrl: 'http://localhost:10007',  // Dynamic port
  headers: {
    'Authorization': `Bearer ${authToken}`  // Only for deployed
  }
});

// Send message
const response = await client.sendMessage({
  role: 'user',
  parts: [{ kind: 'text', text: 'Check my inbox' }]
});
```

```json
// A2A Request
POST http://localhost:10007/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "Check my inbox"
        }
      ],
      "messageId": "9229e770-767c-417b-a0b0-f0741243c589"
    },
    "metadata": {}
  }
}

// A2A Response
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "parts": [
      {
        "kind": "text",
        "text": "Found 3 important emails. Here are the subjects..."
      }
    ]
  }
}
```

---

## TUI Architecture

### Overview

The Cast TUI uses **OpenTUI** — a native Zig core with TypeScript bindings, powering the UI layer.

### Screen States

The TUI opens on the chat screen as soon as the renderer starts. `dev`, `production`, and `on-host` all do this.

```
┌─────────────┐
│    Chat     │
│    Screen   │
└─────────────┘
       │
  Tab key toggles
       │
┌──────┴──────────────────┐
▼                         ▼
[PLAN MODE]          [BUILD MODE]
(read-only, no exec)  (full execution)
```

### Screen State Machine

| State | Description |
|-------|-------------|
| `ScreenChat` | Main interaction screen with agent. Shown immediately; there is no screen before it. |

### Chat Modes

| Mode | Description | Behavior |
|------|-------------|----------|
| `ModePlan` | Plan mode (read-only) | Tool execution disabled, agent explains what it would do |
| `ModeBuild` | Build mode (default) | Full tool execution enabled |

### Welcome Screen

Removed. There is no splash before the chat. `dev`, `production`, and `on-host` open on the chat screen as soon as the renderer starts, with the input focused and ready to type.

A `--welcome` string is still the first agent message in the chat when one is passed. On-host mode still shows the agent introduction. Those are chat messages, not a separate screen.

### Chat Screen

**Header Bar:**
```
┌──────────────────────────────────────────────────────────────┐
│ ● email-agent                    [PLAN] [BUILD]  [ctrl+c] quit│
├──────────────────────────────────────────────────────────────┤
```

**Message Display:**
- User messages: Blue `▸` prefix
- Builder/Agent: Colored `▹` prefix (amber for builder, green for agent)
- Tool calls: Collapsible with `●` indicator
- Thinking blocks: Toggleable with `/thinking` command

**Input Area:**
- `▸` prompt for user input
- Blinking cursor `█`
- `/commands` parsed when input starts with `/`

### Slash Commands

| Command | Description | Keybind |
|---------|-------------|---------|
| `/help` | Show help dialog | `ctrl+x h` |
| `/new` | Start new session | `ctrl+x n` |
| `/exit` | Exit application | `ctrl+x q` or `q` |
| `/thinking` | Toggle thinking display | `ctrl+x t` |
| `/undo` | Undo last change | `ctrl+x u` |
| `/redo` | Redo undone change | `ctrl+x r` |
| `/compact` | Compact/summarize conversation | `ctrl+x c` |

### Development Mode (Local)

| Aspect | Behavior |
|--------|----------|
| Header color | Purple `#8B5CF6` |
| Agent name | White text |
| Mode indicator | `[BUILD]` bright, `[PLAN]` dim |
| Thought process | Shown in collapsible panel |
| Tool calls | Shown in real-time |
| Auth | None (local process) |

### Production Mode (Deployed/Local Deploy)

| Aspect | Behavior |
|--------|----------|
| Header color | Green `#10B981` |
| Live badge | `[● LIVE]` |
| Mode indicator | Same as dev (Plan/Build) |
| Thought process | Hidden by default |
| Tool calls | Collapsed, show only on error |
| Auth | Bearer token required |

### TUI Example (Development Mode)

```
┌─────────────────────────────────────────────────────────────┐
│ ● email-agent                          [PLAN] [BUILD]      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ▹ Hello! I'm the Cast Builder Agent. I'll help you create │
│    an agent that works with your email.                     │
│                                                             │
│  ▸ I want an agent that reads my gmail inbox               │
│                                                             │
│  ▹ Great! Let me help you create that agent. First, let me │
│    ask a few questions to understand your needs...          │
│                                                             │
│  [View Drafts] [Approve All] [Edit Draft]                   │
│                                                             │
│  Uptime: 0m 32s | Builder mode | [Tab] Toggle Plan/Build   │
└─────────────────────────────────────────────────────────────┘
```

### TUI Example (Production Mode)

```
┌─────────────────────────────────────────────────────────────┐
│  ● email-agent                              [● LIVE]        │
├─────────────────────────────────────────────────────────────┤
│  (Production mode - thought process hidden)                │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ You: Check my inbox and draft replies for important │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ email-agent: Found 3 important emails. Drafting...  │   │
│  │                                                      │
│  │ ✓ Draft created for john@example.com                 │   │
│  │ ✓ Draft created for urgent@client.com               │   │
│  │ ⚠ Skipped marketing@newsletter (newsletter)         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ [View Drafts] [Approve All] [Edit Draft]           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  Uptime: 2h 14m | Deployed: railway | [Ctrl+C] Disconnect │
└─────────────────────────────────────────────────────────────┘
```

---

## LLM Provider Architecture

Inference providers register themselves. The runtime agent, the builder, and memory reflection call `get_provider(model)`. They do not import a concrete provider class and they do not branch on the provider name.

There is no `LLMProvider` ABC and no `<provider>:<model>` syntax. A model string uses a slash prefix (`digitalocean/<id>`, `example/<id>`) or, with no matching prefix, the default provider.

### How a model string picks a provider

Non-default providers match first. A provider matches when the model starts with one of its prefixes. The longest matching prefix wins. If none match, the default provider is used. OpenRouter is the only default.

| Model string | Provider |
|---|---|
| `digitalocean/llama3.3-70b-instruct` | DigitalOcean serverless inference |
| `openrouter/anthropic/claude-sonnet-4.6` | OpenRouter |
| `anthropic/claude-sonnet-4.6` | OpenRouter |
| `openai/gpt-4o` | OpenRouter |
| `claude-sonnet-4` | OpenRouter, then the alias table |
| `example/my-model` | The external provider that registered `example/` |

`openai/`, `anthropic/`, `google/`, `meta-llama/`, `kimi/`, `minimax/`, `deepseek/`, `mistralai/`, `cohere/`, `x-ai/`, and `perplexity/` are OpenRouter model ids, not provider prefixes.

Both API keys may be set. The prefix wins. If the selected provider's environment variable is missing, Cast stays in echo mode and names that variable. It does not try the other provider.

### Registration

Built-ins are a module under `python/cast/providers/<key>.py` that exports `provider`, one row in `python/cast/providers/manifest.json`, and one binding in `BUILTIN_MODULES`. OpenRouter (`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`) is the default. DigitalOcean (`https://inference.do-ai.run/v1`, `DIGITALOCEAN_MODEL_ACCESS_KEY`, config key `providers.digitalocean_inference.api_key`) accepts any catalog id and does not rewrite it. `providers.digitalocean` remains the Droplet and MicroVM deploy token.

External providers load after built-ins, with no edit to this repository:

1. `cast.inference` entry points, sorted by key.
2. `~/.cast/inference-providers/<key>/` (`provider.json` and `provider.py`), sorted by directory name.
3. `inferenceProviders` paths or module names in `~/.cast/config.yaml`, in listed order.

An external key or prefix that collides with a provider loaded earlier fails at load and names both sources. An external cannot set `default`. A provider file that fails to import is reported with its path. Built-ins still register.

`python -m cast.providers.catalog` prints the loaded catalog as JSON. `knownModels` is not in that payload. Deploy code calls `inferenceEnv()`, which runs the catalog, resolves each `envVar` from the environment and then from `configKey`, and returns only the pairs that have a value. The deploy then keeps the key for the provider selected by `brain.model`. Secret values are passed on stdin or in the provider create body.

### Provider Implementations

| Provider | File | Status |
|----------|------|--------|
| OpenRouter | `providers/openrouter.py` | v1, default |
| DigitalOcean serverless inference | `providers/digitalocean.py` | v1 |
| Anthropic | `providers/anthropic.py` | Placeholder |
| OpenAI | `providers/openai.py` | Placeholder |
| Ollama | `providers/ollama.py` | Placeholder |

### Model string examples

- `openrouter/minimax/minimax-m2.5` (default builder model)
- `digitalocean/llama3.3-70b-instruct`
- `digitalocean/deepseek-v3.2`
- `example/my-model` (external provider)

A `digitalocean/<model-id>` string selects DigitalOcean and sends `<model-id>` unchanged. `openrouter/...`, bare aliases, `anthropic/...`, and `openai/...` stay on OpenRouter. Alias and vendor-prefix rewrites stay inside the OpenRouter module.

---

## MCP Integration

### OAuth Flow (Localhost)

```
1. TypeScript CLI starts an HTTP server bound to 127.0.0.1 on port 34567
2. Opens browser to provider OAuth URL with a crypto.randomBytes state
3. User authenticates
4. Provider redirects to localhost:34567/callback
5. TypeScript CLI checks the state in constant time, then exchanges the code for tokens
6. Stores in ~/.cast/vault/<agent>/<server>-oauth.json (directory mode 0700, file mode 0600)
7. Stops temp server
8. Falls back to manual code entry if browser unavailable
```

### MCP Config

```yaml
# ~/.cast/agents/<agent>/mcp/gmail.yaml
server: gmail
version: "1.0.0"
auth:
  type: oauth
  credentials_path: ~/.cast/vault/email-agent/gmail-oauth.json
scopes:
  - https://www.googleapis.com/auth/gmail.readonly
```

---

## Security Model

### Harness Layer

```
┌─────────────────────────────────────┐
│         Agent Brain (LLM)          │
└───────────────┬─────────────────────┘
                │ tool call
                ▼
┌─────────────────────────────────────┐
│         Harness Layer               │
│  ┌─────────────────────────────────┐│
│  │ Permission Checker              ││
│  │ - always-allow → execute       ││
│  │ - approve-once → prompt once   ││
│  │ - always-ask → prompt every    ││
│  │ - block → deny                 ││
│  └─────────────────────────────────┘│
│  ┌─────────────────────────────────┐│
│  │ Constitutional Principles       ││
│  └─────────────────────────────────┘│
└───────────────┬─────────────────────┘
                │ approved
                ▼
┌─────────────────────────────────────┐
│         Tool Executor (Hands)       │
└─────────────────────────────────────┘
```

### Permission Levels

| Level | Behavior |
|-------|----------|
| `always-allow` | Execute without prompting |
| `approve-once` | Prompt once per session |
| `always-ask` | Prompt every time |
| `block` | Deny execution |

### Authentication (Deployed Agents)

```
Deploy:
  1. Generate random AUTH_TOKEN (32 bytes, base64)
  2. Store hash in ~/.cast/tokens/<agent>.token
  3. Set AUTH_TOKEN as environment variable on deployed agent
  4. Agent validates Bearer token on each A2A request

Connect:
  1. OpenTUI retrieves token from keychain (keytar)
  2. Send Authorization: Bearer <token> header with each request
  3. Agent hashes incoming token, compares to stored hash
```

### Token Storage

- Local dev: No token required
- Deployed agents:
  - Plain token stored in `~/.cast/tokens/<agent>.token`
  - Token hash stored in `cast.db` deployments table
  - Runtime keychain via keytar for CLI session

---

## Deployment

### v1 Targets

| Provider | Service | Command |
|----------|---------|---------|
| Railway | Managed containers | `cast <agent> deploy --provider railway` |
| Fly.io | Distributed containers | `cast <agent> deploy --provider fly` |
| Sprites | Firecracker VMs via the `sprite` CLI | `cast <agent> deploy --provider sprites` |
| DigitalOcean | App Platform | `cast <agent> deploy --provider digitalocean` |
| Docker | Self-hosted | `cast <agent> deploy --provider docker` |
| Local | Local production | `cast <agent> deploy --provider local` |

### Sprites authentication

Sprites does not accept `FLY_API_TOKEN`. Install the `sprite` CLI, then either run `sprite login` or set `SPRITES_TOKEN`. Create that token at https://sprites.dev/account. The value uses the `org/token-id/secret` format.

### Deployment Flow

```bash
cast email-agent deploy --provider railway
```

1. Package agent (Docker image)
2. Push to provider registry
3. Configure environment variables (from vault)
4. Set schedule (cron) if configured
5. Generate auth token, store hash
6. Return deployment URL

### Deployed Agent Security

```python
# In deployed agent - A2A request handler
class AuthenticatedAgentExecutor:
    async def execute(self, context, event_queue):
        # Validate Bearer token
        auth_header = context.message.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise ServerError(error=UnauthorizedError())
        
        token = auth_header[7:]  # Strip "Bearer "
        if not verify_token(token, self.expected_token_hash):
            raise ServerError(error=ForbiddenError())
        
        # Proceed with normal execution
        await self._process_request(context, event_queue)
```

### Local Deployment

```bash
cast email-agent deploy --provider local
```

- Spawns Python agent process locally in production mode
- Same TUI production mode (green theme)
- Auth token still required
- Supports cron scheduling
- No external exposure (localhost only)

---

## Dynamic Port Allocation

For local development, agents bind to a dynamically allocated port:

```python
# Python Runtime Agent
import socket

def find_free_port(start=10000, end=65535) -> int:
    """Find a free port in the given range."""
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('localhost', port)) != 0:
                return port
    raise RuntimeError("No free ports available")

# Agent starts HTTP server on free port
port = find_free_port()
print(f"Agent ready on port {port}")  # TypeScript CLI captures this
```

```typescript
// TypeScript CLI
const agent = spawn('python', ['-m', 'cast.runtime'], {
  env: { ...process.env, CAST_AGENT_NAME: 'email-agent' }
});

// Capture port from stdout
agent.stdout.on('data', (data) => {
  const match = data.toString().match(/Agent ready on port (\d+)/);
  if (match) {
    const port = parseInt(match[1]);
    // Store in local_agents table
    sqlite.run('INSERT INTO local_agents (agent_name, pid, port) VALUES (?, ?, ?)', 
      ['email-agent', agent.pid, port]);
    // Connect OpenTUI to localhost:port
    opentui.connect(`http://localhost:${port}`);
  }
});
```

---

## Deployed Agent Communication

### Connection Flow

```
1. deploy --provider railway
   └── Agent deployed with AUTH_TOKEN, returns deployment URL
   └── Store: deployment_url, auth_token_hash in cast.db

2. connect
   └── TUI retrieves AUTH_TOKEN from keychain (keytar)
   └── OpenTUI connects via A2A HTTPS to deployment URL
   └── Token sent with every request (Authorization: Bearer)

3. chat (production mode)
   └── Clean UI, green color scheme
   └── Thought process hidden by default
   └── Collapsible tool calls
   └── Real-time streaming responses
```

### On Connection Drop

- Display message: "Connection lost. Press any key to reconnect."
- Require manual reconnection (no auto-reconnect)

---

## Meta-Builder (Test Harness)

### Purpose
Verifies the Builder Agent works correctly by running test scenarios and asserting created artifacts are valid.

### CLI

```bash
cast meta test                    # Run all tests
cast meta test --scenario create # Run specific scenario
cast meta test --verbose         # Show full output
```

### Test Scenarios

| Test | Input | Assertions |
|------|-------|------------|
| Create simple agent | "email agent" | `~/.cast/agents/email/agent.yaml` exists, valid YAML |
| Create with MCP | "agent that reads gmail" | `mcp/gmail.yaml` exists, OAuth config valid |
| Model recommendation | "simple task" | Model is haiku/mini-tier |
| Model recommendation | "complex analysis" | Model is sonnet/opus-tier |
| Permissions | "delete files" | `filesystem.write` is NOT `always-allow` |
| Missing fields | "" (empty) | Builder asks clarifying questions |

### Test Scenario Format

```yaml
# ~/.cast/meta/scenarios/create-with-mcp.yaml
name: Create agent with MCP
description: Builder should create agent with Gmail MCP when user mentions email

input: "Create an agent that reads my emails"

assertions:
  - type: file_exists
    path: ~/.cast/agents/email-agent/agent.yaml
  - type: file_exists
    path: ~/.cast/agents/email-agent/mcp/gmail.yaml
  - type: yaml_contains
    path: ~/.cast/agents/email-agent/agent.yaml
    key: tools.mcp
    value: gmail
  - type: yaml_not_always_allow
    path: ~/.cast/agents/email-agent/agent.yaml
    key: email.draft
```

---

## Implementation Phases

### Phase 1: TypeScript CLI Foundation (2-3 weeks)

- [ ] Initialize oclif project (`cast-cli`)
- [ ] Create basic commands: list, dev, deploy, connect, meta test
- [ ] Set up SQLite with `better-sqlite3`
- [ ] Integrate `keytar` for token storage
- [ ] Create AgentCard.json type definitions
- [ ] Basic project structure

### Phase 2: OpenTUI TUI (2-3 weeks)

- [ ] Set up OpenTUI subprocess management
- [ ] Open the TUI directly on the chat screen (no splash)
- [ ] Create Chat screen with Plan/Build mode toggle
- [ ] Implement Tab key for mode toggle
- [ ] Add slash commands (`/help`, `/exit`, `/thinking`, etc.)
- [ ] Keyboard shortcuts (`ctrl+x h`, `ctrl+x n`, etc.)
- [ ] Message display with user/agent prefixes
- [ ] Tool call rendering (collapsible panels)

### Phase 3: Builder Agent (stdio) (2-3 weeks)

- [ ] Implement stdio JSON-RPC bridge in TypeScript
- [ ] Create Builder Agent Python module (`cast.builder`)
- [ ] LangChain agent with tool calling
- [ ] Builder tools: `create_agent`, `update_config`, `install_mcp`
- [ ] Model recommendation logic
- [ ] OAuth flow integration (TypeScript side)
- [ ] Spawn Builder Agent from `cast <agent>` when agent doesn't exist

### Phase 4: Runtime Agent (A2A local) (2-3 weeks)

- [ ] Create Runtime Agent Python module (`cast.runtime`)
- [ ] LangChain `AgentExecutor` with `@tool` decorators
- [ ] A2A HTTP server (Starlette/FastAPI)
- [ ] Dynamic port allocation
- [ ] Built-in tools: `bash`, `read`, `glob`
- [ ] AgentCard.json generation
- [ ] OpenTUI A2A client integration
- [ ] Local dev mode: spawn agent, connect, chat

### Phase 5: MCP Manager + OAuth (2-3 weeks)

- [ ] MCP server installation
- [ ] OAuth flow (localhost redirect)
- [ ] Credential vault (`~/.cast/vault/`)
- [ ] MCP → tool conversion for agents
- [ ] Builder Agent `install_mcp` tool

### Phase 6: Test Framework (1-2 weeks)

- [ ] TypeScript CLI tests (oclif test framework)
- [ ] Python agent unit tests
- [ ] Test scenario YAML parser
- [ ] Assertion engine

### Phase 7: Meta-Builder (1-2 weeks)

- [ ] Test scenario runner
- [ ] `cast meta test` command
- [ ] Verbose output mode
- [ ] Integration with Builder Agent

### Phase 8: Deployment: Railway (1-2 weeks)

- [ ] Railway API integration
- [ ] Docker image packaging
- [ ] Auth token generation
- [ ] `cast <agent> deploy --provider railway`

### Phase 9: Deployment: Fly.io (1-2 weeks)

- [ ] Fly.io API integration
- [ ] `fly.toml` generation
- [ ] TLS/HTTPS configuration
- [ ] `cast <agent> deploy --provider fly`

### Phase 10: Deployment: DigitalOcean (1-2 weeks)

- [ ] DigitalOcean App Platform API
- [ ] `app.yaml` generation
- [ ] `cast <agent> deploy --provider digitalocean`

### Phase 11: Deployment: Docker/Local (1-2 weeks)

- [ ] Docker image export
- [ ] Local production mode
- [ ] Cron scheduling support
- [ ] `cast <agent> deploy --provider docker`
- [ ] `cast <agent> deploy --provider local`

### Phase 12: Production TUI Mode (1-2 weeks)

- [ ] Green color scheme for production
- [ ] Hidden thought process by default
- [ ] Collapsible tool calls
- [ ] Streaming response support
- [ ] Connection drop handling
- [ ] Manual reconnection prompt

---

## Project Structure

### TypeScript Side

```
typescript/
├── cast-cli/
│   ├── src/
│   │   ├── index.ts              # Entry point
│   │   ├── commands/
│   │   │   ├── list.ts           # List agents
│   │   │   ├── dev.ts            # Development mode
│   │   │   ├── test.ts           # Run tests
│   │   │   ├── deploy.ts         # Deploy agent
│   │   │   ├── connect.ts        # Connect to deployed
│   │   │   ├── logs.ts           # View logs
│   │   │   ├── update.ts         # Update config
│   │   │   ├── delete.ts         # Delete agent
│   │   │   └── meta/
│   │   │       └── test.ts       # Meta-builder tests
│   │   └── lib/
│   │       ├── opentui.ts         # OpenTUI integration
│   │       ├── sqlite.ts          # SQLite state
│   │       ├── keychain.ts        # keytar token storage
│   │       ├── mcp.ts             # MCP manager
│   │       ├── a2a/
│   │       │   ├── client.ts      # A2A client
│   │       │   └── protocol.ts    # A2A types
│   │       ├── builder/
│   │       │   └── stdio.ts       # stdio JSON-RPC bridge
│   │       └── deploy/
│   │           ├── railway.ts
│   │           ├── fly.ts
│   │           ├── digitalocean.ts
│   │           └── docker.ts
│   ├── package.json
│   └── tsconfig.json
└── cast-tui/
    ├── src/
    │   ├── index.ts
    │   ├── screens/
    │   │   └── chat.ts
    │   └── components/
    │       ├── header.ts
    │       ├── messages.ts
    │       └── input.ts
    ├── package.json
    └── tsconfig.json
```

### Python Side

```
python/cast/
├── __main__.py               # CLI entry
├── agent/
│   ├── __init__.py
│   ├── base.py               # LangChain AgentExecutor base
│   ├── builder.py            # Builder Agent (stdio JSON-RPC)
│   └── runtime.py            # Runtime Agent (A2A HTTP server)
├── tools/
│   ├── __init__.py
│   ├── bash.py               # Built-in bash tool
│   ├── read.py               # Built-in file read
│   └── glob.py               # Built-in file glob
├── harness/
│   ├── permissions.py        # Permission checker
│   └── principles.py         # Constitutional principles
└── providers/
    ├── registry.py           # get_provider(model)
    ├── manifest.json         # Built-in catalog rows
    ├── catalog.py            # python -m cast.providers.catalog
    ├── openrouter.py         # Default inference provider
    ├── digitalocean.py       # digitalocean/ prefix binding
    ├── digitalocean_inference.py  # Serverless inference client
    ├── anthropic.py          # Placeholder
    ├── openai.py             # Placeholder
    └── ollama.py             # Placeholder
```

---

## License

Apache License 2.0 - See LICENSE file

---

## Decisions Summary

| Decision | Choice |
|----------|--------|
| Name | cast |
| Project Directory | castagent |
| CLI Language | TypeScript (oclif) |
| TUI Framework | OpenTUI |
| Agent Language | Python (LangChain) |
| Builder Communication | stdio JSON-RPC |
| Runtime Communication | A2A over HTTP |
| Local Agent Port | Dynamic allocation |
| Database | Plain SQLite |
| Token Storage | keytar (system keychain) |
| Agent Storage | `~/.cast/agents/` |
| Global State | `~/.cast/` |
| License | Apache 2.0 |
| Commands | `list`, `dev`, `test`, `deploy`, `connect`, `logs`, `update`, `delete`, `meta test` |
| Help | `cast --help` and per-command `--help` |
| LLM Provider | OpenRouter v1, others extensible |
| Auth Tokens | System keychain (keytar) |
| OAuth | Localhost redirect + manual fallback |
| Deployment | Railway, Fly.io, DigitalOcean, Docker, Local |
| Production Comm | A2A over HTTPS, Bearer token |
| Production TUI | Green theme, hidden thought process, no auto-reconnect |
| Meta-builder | TypeScript CLI + Python test scenarios |

---

## Appendix: A2A Protocol Reference

### A2A Message Types

```typescript
// A2A Message
interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  messageId: string;
  metadata?: Record<string, any>;
}

// A2A Part (text or other content)
interface A2APart {
  kind: 'text' | 'file' | 'data';
  text?: string;
  file?: { name: string; mimeType: string; bytes?: string; uri?: string };
  data?: Record<string, any>;
}

// A2A Request
interface A2ARequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, any>;
}

// A2A Response
interface A2AResponse {
  jsonrpc: '2.0';
  id: string;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
}
```

### A2A Methods

| Method | Description |
|--------|-------------|
| `message/send` | Send a message to the agent |
| `message/get` | Get a message by ID |
| `task/get` | Get task status |
| `task/cancel` | Cancel a running task |
| `agent/card` | Get the AgentCard |

---

*Last updated: 2026-04-28*
