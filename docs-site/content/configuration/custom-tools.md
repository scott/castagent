---
title: Custom tools
section: configuration
order: 1
description: The tools.custom entry shape, and what the runtime loads.
ref: ['cli:describe']
---

# Custom tools

`tools.custom` in `agent.yaml` records custom tool entries. `{% ref "cli:describe" %}` prints them on the Custom line. The runtime loads built-in tools from `tools.builtin` and leaves `tools.custom` on the config.

## Entry shape

Each entry is a module name string or an object with `path`:

```yaml
tools:
  custom:
    - email_tools
    - path: tools/summarize_thread.py
```

`cast describe` prints the string as written and the object as its `path`:

```
  Custom: email_tools, tools/summarize_thread.py
```

A blank string, or an object with no string `path`, is left off that line. A list of bare names such as `email_tools` used to render as `Custom:` with an empty value, because describe read only `path`.

## Minimal example

The file under `tools/` is the module you can point at with `path`. The runtime does not import it.

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

## What the runtime loads

The runtime agent (`python/cast/agent/runtime.py`) builds its tool list from `tools.builtin`. It keeps names that match a built-in implementation:

- `bash`
- `read`
- `glob`
- `git_status`, `git_commit`, `git_push`, `git_log`, `git_diff`, `git_add`

`tools.custom` is not part of that list. A `tools/*.py` file is not imported when the agent starts, and saving one does not register a tool.

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

The runtime checks the level when the model calls a built-in tool, including
calls that arrive over A2A. A tool with no entry runs as `always-allow`.

Levels:

- `always-allow`: the agent calls the tool without asking.
- `ask`: in the TUI, the runtime opens a modal before the tool runs. The
  modal shows the tool name, the arguments, and Approve / Deny. Deny starts
  selected. Up and down move, Enter confirms, and ESC denies and returns
  focus to the input. The tool runs only after Approve. A headless
  `message/send` has no modal, so an `ask` call returns an error and does
  not run.
- `deny`: the tool call returns an error and is never executed.

A level other than these three is treated as `deny`. `cast update
--permission` accepts only these three levels. Any other level is an error,
and `agent.yaml` is left unchanged.

Restart `cast dev` after changing permissions. A running process keeps the
levels it loaded at startup.

## Dependencies

If your tool needs a pip package, add it to `agent.yaml`:

```yaml
runtime:
  python_version: "3.12"
  requirements:
    - requests
    - beautifulsoup4
```

`cast update --python-version` accepts `3.11` or `3.12`. Any other version
is an error, and `agent.yaml` is left unchanged.

Cast installs the venv fresh on each `cast deploy` / `cast upgrade`.
Locally, `cast dev` reads from `python/.venv/`.
