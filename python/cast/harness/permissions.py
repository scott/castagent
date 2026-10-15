"""Enforce harness.permissions before a tool runs.

Levels written by `cast update --permission` are `always-allow`, `ask`, and
`deny`. A missing entry for a built-in tool stays allowed so existing agents
keep working. An MCP tool, and any other name that is not a built-in, is
`deny` until it is listed. `mcp` and `*` cover names an MCP server advertises
at startup. An unknown level fails closed.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

ALWAYS_ALLOW = "always-allow"
ASK = "ask"
DENY = "deny"

# `harness.permissions` keys that cover every MCP tool with no entry of its own.
# `mcp` is more specific than `*`. Neither key changes a built-in default.
MCP_SCOPE = "mcp"
WILDCARD_SCOPE = "*"
MCP_ORIGIN = "mcp"
_SCOPE_KEYS = frozenset({MCP_SCOPE, WILDCARD_SCOPE})

# Built-in `harness.permissions` keys. A missing entry stays always-allow.
# MCP calls pass origin MCP_ORIGIN so a server cannot reuse one of these names
# to inherit that default.
BUILTIN_TOOL_NAMES = frozenset({
    "bash",
    "read",
    "glob",
    "git_status",
    "git_commit",
    "git_push",
    "git_log",
    "git_diff",
    "git_add",
})

# Older spec names still appear in hand-written agent.yaml files.
_LEVELS = {
    "always-allow": ALWAYS_ALLOW,
    "allow": ALWAYS_ALLOW,
    "ask": ASK,
    "always-ask": ASK,
    "approve-once": ASK,
    "deny": DENY,
    "block": DENY,
}


def normalize_level(level: Any) -> str | None:
    """Return a canonical level, or None when the value is not recognized."""
    if not isinstance(level, str):
        return None
    return _LEVELS.get(level.strip().lower())


def permission_denied_message(tool_name: str, level: str = DENY) -> str:
    """Tool result returned to the model when a call does not run."""
    if level == ASK:
        return (
            f"Error: Permission denied for {tool_name}. "
            "Approval is required before this tool can run, and it was not executed."
        )
    return (
        f"Error: Permission denied for {tool_name}. "
        "This tool is set to deny and was not executed."
    )


def _unknown_level_message(tool_name: str) -> str:
    return (
        f"Error: Permission denied for {tool_name}. "
        "The permission level is not allowed, so the tool was not executed."
    )


def _json_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    try:
        encoded = json.dumps(dict(arguments), default=str)
        parsed = json.loads(encoded)
    except (TypeError, ValueError):
        return {"value": str(arguments)}
    if isinstance(parsed, dict):
        return parsed
    return {"value": parsed}


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    message: str


class PermissionPrompt:
    """A tool call that is waiting for Approve or Deny."""

    def __init__(self, request: dict[str, Any]):
        self.request = request


class ApprovalBroker:
    """Pause an `ask` tool until the TUI sends permission/respond.

    Non-streaming message/send has no second request to answer with, so
    `request` returns False and the tool does not run. One chat stream
    owns the broker at a time.
    """

    def __init__(self) -> None:
        self.interactive = False
        self._notify: asyncio.Queue | None = None
        self._pending: dict[str, asyncio.Future] = {}

    def attach(self, notify: asyncio.Queue) -> None:
        self._notify = notify
        self.interactive = True

    def detach(self) -> None:
        self.interactive = False
        self._notify = None
        for future in list(self._pending.values()):
            if not future.done():
                future.set_result(False)

    async def request(self, tool_name: str, arguments: Mapping[str, Any]) -> bool:
        notify = self._notify
        if not self.interactive or notify is None:
            return False
        request_id = uuid.uuid4().hex
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        payload = {
            "id": request_id,
            "tool": tool_name,
            "arguments": _json_arguments(arguments),
        }
        try:
            if not self.interactive or self._notify is None:
                return False
            await notify.put(("permission", payload))
            if future.done():
                return bool(future.result())
            return bool(await future)
        finally:
            self._pending.pop(request_id, None)

    def respond(self, request_id: str, approved: bool) -> bool:
        if not isinstance(request_id, str):
            return False
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(bool(approved))
        return True


class PermissionGate:
    """Decide whether one tool call may run."""

    def __init__(self, permissions: Any, broker: ApprovalBroker | None = None):
        if isinstance(permissions, Mapping):
            self.permissions: dict[str, Any] = dict(permissions)
        else:
            self.permissions = {}
        self.broker = broker if broker is not None else ApprovalBroker()

    def _uses_mcp_policy(self, tool_name: str, origin: str | None) -> bool:
        """MCP calls and unknown names fail closed. Built-ins do not."""
        if origin == MCP_ORIGIN:
            return True
        return tool_name not in BUILTIN_TOOL_NAMES

    def policy_key(self, tool_name: str, *, origin: str | None = None) -> str | None:
        """Permissions key that governs `tool_name`, or None for a default.

        An exact tool name wins. Otherwise an MCP call uses `mcp`, then `*`.
        A built-in with no exact entry keeps its own default and ignores both
        of those keys.
        """
        if not isinstance(tool_name, str) or not tool_name:
            return None
        mcp_policy = self._uses_mcp_policy(tool_name, origin)
        if tool_name in self.permissions and tool_name not in _SCOPE_KEYS:
            return tool_name
        if mcp_policy and tool_name in _SCOPE_KEYS and tool_name in self.permissions:
            return tool_name
        if mcp_policy and MCP_SCOPE in self.permissions and tool_name != MCP_SCOPE:
            return MCP_SCOPE
        if mcp_policy and WILDCARD_SCOPE in self.permissions and tool_name != WILDCARD_SCOPE:
            return WILDCARD_SCOPE
        return None

    def action_for(self, tool_name: str, *, origin: str | None = None) -> str | None:
        """Canonical level, or None when the configured value is unknown.

        A built-in with no entry is `always-allow`. An MCP tool with no entry
        is `deny`, including when its advertised name matches a built-in.
        """
        if not isinstance(tool_name, str) or not tool_name:
            return DENY
        key = self.policy_key(tool_name, origin=origin)
        if key is not None:
            return normalize_level(self.permissions.get(key))
        if not self._uses_mcp_policy(tool_name, origin):
            return ALWAYS_ALLOW
        return DENY

    def mcp_startup_messages(self, names: list[str] | tuple[str, ...]) -> list[str]:
        """Lines printed when an MCP server advertises tools.

        Names with no exact entry and no `mcp` or `*` policy are denied
        until the operator lists them.
        """
        advertised: list[str] = []
        for name in names:
            if isinstance(name, str) and name and name not in advertised:
                advertised.append(name)
        if not advertised:
            return []
        lines = ["MCP tools advertised at startup: " + ", ".join(advertised)]
        pending = [
            name
            for name in advertised
            if self.policy_key(name, origin=MCP_ORIGIN) is None
        ]
        if pending:
            lines.append(
                "Denied until listed in harness.permissions: " + ", ".join(pending) + "."
            )
        shared = [name for name in advertised if name in BUILTIN_TOOL_NAMES]
        if shared:
            lines.append(
                "MCP tools sharing a built-in permissions key: " + ", ".join(shared) + "."
            )
        return lines

    async def authorize(
        self,
        tool_name: str,
        arguments: Mapping[str, Any],
        *,
        origin: str | None = None,
    ) -> PermissionDecision:
        level = self.action_for(tool_name, origin=origin)
        if level == ALWAYS_ALLOW:
            return PermissionDecision(True, "")
        if level is None:
            return PermissionDecision(False, _unknown_level_message(tool_name))
        if level == DENY:
            return PermissionDecision(False, permission_denied_message(tool_name, DENY))
        approved = await self.broker.request(tool_name, arguments)
        if not approved:
            return PermissionDecision(False, permission_denied_message(tool_name, ASK))
        return PermissionDecision(True, "")

    def authorize_now(
        self,
        tool_name: str,
        arguments: Mapping[str, Any],
        *,
        origin: str | None = None,
    ) -> PermissionDecision:
        """Sync path. `ask` cannot wait for the TUI here, so it does not run."""
        level = self.action_for(tool_name, origin=origin)
        if level == ALWAYS_ALLOW:
            return PermissionDecision(True, "")
        if level is None:
            return PermissionDecision(False, _unknown_level_message(tool_name))
        if level == ASK:
            return PermissionDecision(False, permission_denied_message(tool_name, ASK))
        return PermissionDecision(False, permission_denied_message(tool_name, DENY))


def guard_tool(
    tool: Any,
    config_name: str,
    gate: PermissionGate,
    *,
    origin: str | None = None,
) -> Any:
    """Return a copy of `tool` that checks `config_name` before it runs.

    The copy keeps the model's tool name and argument schema. `config_name`
    is the `harness.permissions` key, such as `bash` for `bash_tool`.
    MCP tools pass `origin="mcp"` so the check fails closed.
    """
    from langchain_core.tools import StructuredTool

    original = getattr(tool, "func", None)
    if original is None:
        raise TypeError(f"Tool {config_name} has no function to guard")

    def _blocked(decision: PermissionDecision) -> str:
        return decision.message

    def func(*args: Any, **kwargs: Any) -> Any:
        bound = inspect.signature(original).bind_partial(*args, **kwargs)
        decision = gate.authorize_now(config_name, bound.arguments, origin=origin)
        if not decision.allowed:
            return _blocked(decision)
        return original(*args, **kwargs)

    async def coroutine(*args: Any, **kwargs: Any) -> Any:
        bound = inspect.signature(original).bind_partial(*args, **kwargs)
        decision = await gate.authorize(config_name, bound.arguments, origin=origin)
        if not decision.allowed:
            return _blocked(decision)
        result = original(*args, **kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    signature = inspect.signature(original)
    func.__signature__ = signature  # type: ignore[attr-defined]
    coroutine.__signature__ = signature  # type: ignore[attr-defined]
    func.__name__ = getattr(original, "__name__", config_name)
    coroutine.__name__ = func.__name__
    func.__doc__ = getattr(original, "__doc__", None)
    coroutine.__doc__ = func.__doc__

    description = getattr(tool, "description", None) or func.__doc__ or config_name
    return StructuredTool.from_function(
        func=func,
        coroutine=coroutine,
        name=getattr(tool, "name", config_name),
        description=description,
        args_schema=getattr(tool, "args_schema", None),
        infer_schema=False,
    )
