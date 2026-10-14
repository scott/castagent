"""Load tools.mcp entries and register one LangChain tool per MCP tool."""

from __future__ import annotations

import json
import os
import shlex
import sys
from typing import Any

import yaml
from langchain_core.tools import StructuredTool

from .session import DEFAULT_TIMEOUT, McpError, McpStdioSession

_NAME_BREAKS = str.maketrans({char: "_" for char in " \t\r\n/\\:."})


def load_mcp_tools(
    agent_path: str,
    entries: Any,
    used_names: set[str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[list[McpStdioSession], list[Any]]:
    """Start each configured server and return sessions plus tools.

    A bad entry is logged and skipped. Servers that did start stay
    running so the agent can call their tools.
    """
    if used_names is None:
        used_names = set()
    sessions: list[McpStdioSession] = []
    tools: list[Any] = []
    if entries is None:
        return sessions, tools
    if not isinstance(entries, list):
        _warn("tools.mcp must be a list. No MCP servers were loaded.")
        return sessions, tools
    for index, entry in enumerate(entries):
        try:
            loaded = _load_entry(agent_path, entry, used_names, timeout, index)
        except Exception as exc:  # noqa: BLE001
            # One bad server must not stop the others from loading.
            _warn(f"MCP entry {index} skipped: {exc}")
            continue
        if loaded is None:
            continue
        session, session_tools = loaded
        sessions.append(session)
        tools.extend(session_tools)
    return sessions, tools


def _load_entry(
    agent_path: str,
    entry: Any,
    used_names: set[str],
    timeout: float,
    index: int,
) -> tuple[McpStdioSession, list[Any]] | None:
    located = _locate_config(agent_path, entry, index)
    if located is None:
        return None
    hint, config_path = located
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            raw = yaml.safe_load(handle)
    except OSError as exc:
        _warn(f"MCP config '{config_path}' could not be read: {exc}")
        return None
    except yaml.YAMLError as exc:
        _warn(f"MCP config '{config_path}' could not be parsed: {exc}")
        return None
    if not isinstance(raw, dict):
        _warn(f"MCP config '{config_path}' could not be parsed: expected a mapping")
        return None
    server_name = _server_name(entry, raw, config_path, hint)
    try:
        argv = _command_argv(raw)
        env = _command_env(raw)
    except (TypeError, ValueError) as exc:
        _warn(f"MCP server '{server_name}' skipped: {exc}")
        return None
    if not argv:
        _warn(f"MCP server '{server_name}' skipped: config has no command")
        return None
    session = McpStdioSession(
        name=server_name,
        argv=argv,
        env=env,
        cwd=agent_path,
        timeout=timeout,
    )
    finished = False
    try:
        specs = session.start()
        tools: list[Any] = []
        for spec in specs:
            tool = _make_tool(session, server_name, spec, used_names)
            if tool is not None:
                tools.append(tool)
        finished = True
        return session, tools
    except McpError as exc:
        _warn(str(exc))
        return None
    finally:
        if not finished:
            session.close()


def _locate_config(agent_path: str, entry: Any, index: int) -> tuple[str, str] | None:
    hint = ""
    relative = ""
    if isinstance(entry, str):
        hint = entry.strip()
        if not hint:
            _warn(f"MCP entry {index} skipped: server name is empty")
            return None
        relative = os.path.join("mcp", f"{hint}.yaml")
    elif isinstance(entry, dict):
        for key in ("server", "name"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                hint = value.strip()
                break
        config = entry.get("config")
        if isinstance(config, str) and config.strip():
            relative = config.strip()
        elif hint:
            relative = os.path.join("mcp", f"{hint}.yaml")
        else:
            _warn(f"MCP entry {index} skipped: missing server name and config path")
            return None
    else:
        _warn(f"MCP entry {index} skipped: expected a server name or mapping")
        return None
    path = _safe_path(agent_path, relative)
    if path is None:
        _warn(
            f"MCP config '{relative}' skipped: path is outside the agent directory"
        )
        return None
    if not os.path.isfile(path):
        _warn(f"MCP config '{path}' skipped: file not found")
        return None
    return hint, path


def _safe_path(agent_path: str, relative: str) -> str | None:
    if not relative or os.path.isabs(relative):
        return None
    root = os.path.realpath(agent_path)
    path = os.path.realpath(os.path.join(agent_path, relative))
    if path != root and not path.startswith(root + os.sep):
        return None
    return path


def _server_name(entry: Any, config: dict[str, Any], config_path: str, hint: str) -> str:
    if hint:
        return hint
    for source in (entry, config):
        if not isinstance(source, dict):
            continue
        for key in ("server", "name"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return os.path.splitext(os.path.basename(config_path))[0]


def _command_argv(config: dict[str, Any]) -> list[str]:
    command = config.get("command")
    args = config.get("args") or []
    if args is None:
        args = []
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise TypeError("args must be a list of strings")
    argv: list[str] = []
    if isinstance(command, list):
        if not all(isinstance(item, str) for item in command):
            raise TypeError("command must be a string or a list of strings")
        argv = [*command, *args]
    elif isinstance(command, str) and command.strip():
        argv = [*shlex.split(command), *args]
    elif command is None:
        return []
    else:
        raise TypeError("command must be a string or a list of strings")
    expanded = [os.path.expanduser(part) for part in argv if part]
    if not expanded:
        return []
    return expanded


def _command_env(config: dict[str, Any]) -> dict[str, str]:
    raw = config.get("env") or {}
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise TypeError("env must be a mapping")
    env = os.environ.copy()
    for key, value in raw.items():
        if not isinstance(key, str) or not key:
            raise TypeError("env keys must be strings")
        text = _env_value(value)
        if text is None:
            raise TypeError(f"env value for {key} must be a string or number")
        env[key] = os.path.expanduser(os.path.expandvars(text))
    return env


def _env_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _make_tool(
    session: McpStdioSession,
    server_name: str,
    spec: dict[str, Any],
    used_names: set[str],
) -> Any | None:
    remote = spec.get("name")
    if not isinstance(remote, str) or not remote.strip():
        _warn(f"MCP server '{server_name}' skipped a tool with no name")
        return None
    local = _unique_name(server_name, remote.strip(), used_names)
    description = spec.get("description")
    if not isinstance(description, str) or not description.strip():
        description = f"MCP tool {remote} from {server_name}"
    schema = spec.get("inputSchema")
    if not isinstance(schema, dict):
        schema = {"type": "object", "properties": {}}
    else:
        schema = dict(schema)

    def _call(**kwargs: Any) -> str:
        try:
            result = session.call_tool(remote, kwargs)
        except Exception as exc:  # noqa: BLE001
            # The model should see a tool error, not a crashed turn.
            return f"Error: {exc}"
        return _render_call_result(result)

    return StructuredTool.from_function(
        func=_call,
        name=local,
        description=description.strip(),
        args_schema=schema,
        infer_schema=False,
    )


def _unique_name(server_name: str, tool_name: str, used_names: set[str]) -> str:
    primary = _sanitize(tool_name)
    if primary not in used_names:
        used_names.add(primary)
        return primary
    prefixed = _sanitize(f"{server_name}_{tool_name}")
    if prefixed not in used_names:
        used_names.add(prefixed)
        return prefixed
    number = 2
    while True:
        suffix = f"_{number}"
        candidate = f"{prefixed[: 64 - len(suffix)]}{suffix}"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        number += 1


def _sanitize(name: str) -> str:
    cleaned = name.translate(_NAME_BREAKS)
    cleaned = "".join(char if char.isalnum() or char in "_-" else "_" for char in cleaned)
    cleaned = cleaned.strip("_")
    if not cleaned:
        cleaned = "tool"
    if cleaned[0].isdigit():
        cleaned = f"tool_{cleaned}"
    return cleaned[:64]


def _render_call_result(result: Any) -> str:
    if not isinstance(result, dict):
        text = "" if result is None else str(result)
        return text or "MCP tool completed with no output"
    parts: list[str] = []
    content = result.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, dict):
                parts.append(_json_compact(block))
            else:
                parts.append(str(block))
    elif isinstance(content, str):
        parts.append(content)
    text = "\n".join(part for part in parts if part).strip()
    if result.get("isError"):
        if not text:
            text = "MCP tool returned an error"
        elif not text.startswith("Error:"):
            text = f"Error: {text}"
    if not text:
        return "MCP tool completed with no output"
    return text


def _json_compact(value: Any) -> str:
    return json.dumps(value, default=str)


def _warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr, flush=True)
