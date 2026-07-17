---
title: Custom tools
section: configuration
order: 1
description: Adding a Python tool to an agent's runtime.
ref: ['']
---

# Custom tools

Any `.py` file in `~/.cast/agents/<name>/tools/` is loaded as a LangChain
tool the next time the agent starts. There is no registration step.

## Minimal example

```python
# ~/.cast/agents/email-assistant/tools/summarize_thread.py
from langchain.tools import tool

@tool
def summarize_thread(thread_id: str) -> str:
    """Summarize an email thread by its ID.

    Returns a 3-bullet summary of the thread.
    """
    # your implementation here
    return "• ...\n• ...\n• ..."
```

The docstring becomes the tool's description (the LLM reads it to decide
when to call the tool). Type hints on the arguments and the return value
become the tool's schema.

## Multi-tool files

You can put several tools in one file:

```python
# tools/email.py
from langchain.tools import tool

@tool
def search_mailbox(query: str, max_results: int = 10) -> list[dict]:
    """Search the mailbox for messages matching `query`."""
    ...

@tool
def get_message(message_id: str) -> dict:
    """Fetch a single message by ID."""
    ...
```

## Loading order

Cast loads all `.py` files in `tools/` alphabetically, in this order:

1. `bash.py` and other names that conflict with built-in tools are
   ignored (built-ins win).
2. Each module is imported once per runtime start.
3. Any `@tool`-decorated function is registered with the LangChain
   `AgentExecutor`.

If a tool fails to import (syntax error, missing dependency), the
runtime logs the failure and continues without that tool. Other tools
are still available.

## Permissions

Set per-tool permission in `agent.yaml` under `harness.permissions`:

```yaml
harness:
  permissions:
    bash: ask
    read: always-allow
    glob: always-allow
    summarize_thread: always-allow
    search_mailbox: ask
    get_message: always-allow
```

Levels:

- `always-allow` — the agent calls the tool without asking.
- `ask` — the runtime prompts the user (in the TUI) before executing.
- `deny` — the tool call returns an error and is never executed.

The TUI's `ask` prompt is a modal showing the tool name, the arguments,
and Approve / Deny buttons.

## Hot-reload during development

`cast dev` reloads the agent on file change, including `tools/`. Save a
file, the runtime restarts, and the new tool is registered. If the
restart fails (bad import, syntax error), the previous good state is
kept and the error is shown in the TUI header.

## Dependencies

If your tool needs a pip package, add it to `agent.yaml`:

```yaml
runtime:
  python_version: "3.12"
  requirements:
    - requests
    - beautifulsoup4
```

Cast installs the venv fresh on each `cast deploy` / `cast upgrade`.
Locally, `cast dev` reads from `python/.venv/`.
