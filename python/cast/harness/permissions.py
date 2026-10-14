"""Enforce harness.permissions before a built-in tool runs.

Levels written by `cast update --permission` are `always-allow`, `ask`, and
`deny`. A missing entry stays allowed so existing agents keep working. An
unknown level fails closed.
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

    def action_for(self, tool_name: str) -> str | None:
        """Canonical level, or None when the configured value is unknown.

        A tool with no entry is `always-allow`.
        """
        if tool_name not in self.permissions:
            return ALWAYS_ALLOW
        return normalize_level(self.permissions.get(tool_name))

    async def authorize(self, tool_name: str, arguments: Mapping[str, Any]) -> PermissionDecision:
        level = self.action_for(tool_name)
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

    def authorize_now(self, tool_name: str, arguments: Mapping[str, Any]) -> PermissionDecision:
        """Sync path. `ask` cannot wait for the TUI here, so it does not run."""
        level = self.action_for(tool_name)
        if level == ALWAYS_ALLOW:
            return PermissionDecision(True, "")
        if level is None:
            return PermissionDecision(False, _unknown_level_message(tool_name))
        if level == ASK:
            return PermissionDecision(False, permission_denied_message(tool_name, ASK))
        return PermissionDecision(False, permission_denied_message(tool_name, DENY))


def guard_tool(tool: Any, config_name: str, gate: PermissionGate) -> Any:
    """Return a copy of `tool` that checks `config_name` before it runs.

    The copy keeps the model's tool name and argument schema. `config_name`
    is the `harness.permissions` key, such as `bash` for `bash_tool`.
    """
    from langchain_core.tools import StructuredTool

    original = getattr(tool, "func", None)
    if original is None:
        raise TypeError(f"Tool {config_name} has no function to guard")

    def _blocked(decision: PermissionDecision) -> str:
        return decision.message

    def func(*args: Any, **kwargs: Any) -> Any:
        bound = inspect.signature(original).bind_partial(*args, **kwargs)
        decision = gate.authorize_now(config_name, bound.arguments)
        if not decision.allowed:
            return _blocked(decision)
        return original(*args, **kwargs)

    async def coroutine(*args: Any, **kwargs: Any) -> Any:
        bound = inspect.signature(original).bind_partial(*args, **kwargs)
        decision = await gate.authorize(config_name, bound.arguments)
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
