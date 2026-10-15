"""Runtime enforcement of harness.permissions."""

import asyncio
from pathlib import Path

import pytest

from cast.harness.permissions import (
    ALWAYS_ALLOW,
    ASK,
    BUILTIN_TOOL_NAMES,
    DENY,
    MCP_ORIGIN,
    ApprovalBroker,
    PermissionGate,
    guard_tool,
    normalize_level,
    permission_denied_message,
)
from cast.tools.bash import bash_tool


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


class TestNormalizeLevel:
    def test_documented_levels(self):
        assert normalize_level("always-allow") == ALWAYS_ALLOW
        assert normalize_level("ask") == ASK
        assert normalize_level("deny") == DENY

    def test_case_and_space(self):
        assert normalize_level("  Deny ") == DENY

    def test_legacy_names(self):
        assert normalize_level("block") == DENY
        assert normalize_level("always-ask") == ASK
        assert normalize_level("approve-once") == ASK

    def test_unknown(self):
        assert normalize_level("yolo") is None
        assert normalize_level(None) is None


class TestPermissionGate:
    def test_missing_entry_is_allow(self):
        gate = PermissionGate({})
        assert gate.action_for("bash") == ALWAYS_ALLOW

    def test_unknown_level_is_not_allow(self):
        gate = PermissionGate({"bash": "sometimes"})
        assert gate.action_for("bash") is None

    def test_non_mapping_config_allows(self):
        gate = PermissionGate(None)
        assert gate.action_for("bash") == ALWAYS_ALLOW


class TestGuardedBash:
    """The bug: bash=deny and bash=ask still executed the command."""

    @pytest.mark.asyncio
    async def test_deny_does_not_run_the_command(self, tmp_path):
        target = tmp_path / "deny-proof.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "deny"}))
        result = await tool.ainvoke({"command": f"printf ran > {_quote(target)}"})

        assert not target.exists()
        assert "bash" in result
        assert "not executed" in result
        assert result == permission_denied_message("bash", DENY)

    @pytest.mark.asyncio
    async def test_ask_without_a_prompt_does_not_run(self, tmp_path):
        target = tmp_path / "ask-proof.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "ask"}))
        result = await tool.ainvoke({"command": f"printf ran > {_quote(target)}"})

        assert not target.exists()
        assert result == permission_denied_message("bash", ASK)

    @pytest.mark.asyncio
    async def test_ask_runs_only_after_approval(self, tmp_path):
        target = tmp_path / "approved.txt"
        broker = ApprovalBroker()
        queue: asyncio.Queue = asyncio.Queue()
        broker.attach(queue)
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "ask"}, broker))

        async def approve():
            kind, payload = await queue.get()
            assert kind == "permission"
            assert payload["tool"] == "bash"
            assert "printf" in payload["arguments"]["command"]
            assert broker.respond(payload["id"], True)

        waiter = asyncio.create_task(approve())
        result = await tool.ainvoke({"command": f"printf yes > {_quote(target)}"})
        await waiter

        assert target.read_text() == "yes"
        assert "denied" not in result.lower()

    @pytest.mark.asyncio
    async def test_ask_deny_response_does_not_run(self, tmp_path):
        target = tmp_path / "rejected.txt"
        broker = ApprovalBroker()
        queue: asyncio.Queue = asyncio.Queue()
        broker.attach(queue)
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "ask"}, broker))

        async def reject():
            _kind, payload = await queue.get()
            assert broker.respond(payload["id"], False)

        waiter = asyncio.create_task(reject())
        result = await tool.ainvoke({"command": f"printf yes > {_quote(target)}"})
        await waiter

        assert not target.exists()
        assert result == permission_denied_message("bash", ASK)

    @pytest.mark.asyncio
    async def test_always_allow_runs(self, tmp_path):
        target = tmp_path / "allowed.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "always-allow"}))
        await tool.ainvoke({"command": f"printf ok > {_quote(target)}"})
        assert target.read_text() == "ok"

    @pytest.mark.asyncio
    async def test_missing_permission_runs(self, tmp_path):
        target = tmp_path / "default.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({}))
        await tool.ainvoke({"command": f"printf ok > {_quote(target)}"})
        assert target.read_text() == "ok"

    def test_sync_deny_does_not_run(self, tmp_path):
        target = tmp_path / "sync-deny.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "deny"}))
        result = tool.invoke({"command": f"printf ran > {_quote(target)}"})
        assert not target.exists()
        assert "not executed" in result

    @pytest.mark.asyncio
    async def test_unknown_level_does_not_run(self, tmp_path):
        target = tmp_path / "unknown.txt"
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "sometimes"}))
        result = await tool.ainvoke({"command": f"printf ran > {_quote(target)}"})
        assert not target.exists()
        assert "not allowed" in result

    def test_guard_keeps_the_model_tool_name(self):
        tool = guard_tool(bash_tool, "bash", PermissionGate({"bash": "deny"}))
        assert tool.name == "bash_tool"
        assert "command" in tool.args


class TestMcpPermissionDefault:
    """An advertised MCP name must not run just because it is missing."""

    def test_builtin_names_match_the_runtime_catalog(self):
        from cast.agent.runtime import BUILTIN_TOOLS

        assert BUILTIN_TOOL_NAMES == frozenset(BUILTIN_TOOLS)

    def test_missing_builtin_stays_allow(self):
        gate = PermissionGate({"bash": "deny"})
        assert gate.action_for("read") == ALWAYS_ALLOW
        assert gate.action_for("bash") == DENY

    def test_unlisted_name_is_deny(self):
        gate = PermissionGate({"bash": "deny"})
        assert gate.action_for("run") == DENY
        assert gate.action_for("run", origin=MCP_ORIGIN) == DENY

    def test_empty_config_denies_unknown_names(self):
        gate = PermissionGate(None)
        assert gate.action_for("bash") == ALWAYS_ALLOW
        assert gate.action_for("run") == DENY

    def test_mcp_origin_does_not_inherit_builtin_default(self):
        gate = PermissionGate({})
        assert gate.action_for("read") == ALWAYS_ALLOW
        assert gate.action_for("read", origin=MCP_ORIGIN) == DENY

    def test_exact_name_beats_mcp_deny(self):
        gate = PermissionGate({"mcp": "deny", "run": "always-allow"})
        assert gate.action_for("run", origin=MCP_ORIGIN) == ALWAYS_ALLOW

    def test_mcp_deny_beats_wildcard_allow(self):
        gate = PermissionGate({"mcp": "deny", "*": "always-allow"})
        assert gate.action_for("run", origin=MCP_ORIGIN) == DENY
        assert gate.action_for("bash") == ALWAYS_ALLOW

    def test_wildcard_ask_covers_discovered_names(self):
        gate = PermissionGate({"*": "ask"})
        assert gate.action_for("run") == ASK
        assert gate.action_for("bash") == ALWAYS_ALLOW

    def test_wildcard_deny_covers_discovered_names(self):
        gate = PermissionGate({"bash": "deny", "*": "deny"})
        assert gate.action_for("run") == DENY
        assert gate.action_for("bash") == DENY

    def test_mcp_scope_does_not_change_builtins(self):
        gate = PermissionGate({"mcp": "deny"})
        assert gate.action_for("bash") == ALWAYS_ALLOW
        assert gate.action_for("run", origin=MCP_ORIGIN) == DENY

    def test_unknown_mcp_level_fails_closed(self):
        gate = PermissionGate({"mcp": "sometimes"})
        assert gate.action_for("run", origin=MCP_ORIGIN) is None

    def test_startup_lists_unlisted_names(self):
        gate = PermissionGate({"bash": "deny"})
        assert gate.mcp_startup_messages(["run"]) == [
            "MCP tools advertised at startup: run",
            "Denied until listed in harness.permissions: run.",
        ]

    def test_startup_skips_denial_when_a_scope_is_set(self):
        gate = PermissionGate({"mcp": "ask"})
        assert gate.mcp_startup_messages(["run"]) == [
            "MCP tools advertised at startup: run",
        ]

    def test_startup_warns_when_a_builtin_name_is_advertised(self):
        gate = PermissionGate({})
        lines = gate.mcp_startup_messages(["read"])
        assert "MCP tools advertised at startup: read" in lines
        assert "Denied until listed in harness.permissions: read." in lines
        assert "MCP tools sharing a built-in permissions key: read." in lines

    def test_listed_builtin_name_is_not_pending(self):
        gate = PermissionGate({"read": "always-allow"})
        assert gate.mcp_startup_messages(["read"]) == [
            "MCP tools advertised at startup: read",
            "MCP tools sharing a built-in permissions key: read.",
        ]

    @pytest.mark.asyncio
    async def test_unlisted_mcp_guard_does_not_run(self, tmp_path):
        target = tmp_path / "ran.txt"
        tool = guard_tool(
            bash_tool,
            "run",
            PermissionGate({"bash": "deny"}),
            origin=MCP_ORIGIN,
        )
        result = await tool.ainvoke({"command": f"printf ran > {_quote(target)}"})
        assert not target.exists()
        assert result == permission_denied_message("run", DENY)

    def test_sync_ask_scope_does_not_run(self, tmp_path):
        target = tmp_path / "ask.txt"
        tool = guard_tool(
            bash_tool,
            "run",
            PermissionGate({"*": "ask"}),
            origin=MCP_ORIGIN,
        )
        result = tool.invoke({"command": f"printf ran > {_quote(target)}"})
        assert not target.exists()
        assert result == permission_denied_message("run", ASK)

    def test_mcp_always_allow_runs_when_explicit(self, tmp_path):
        target = tmp_path / "allowed.txt"
        tool = guard_tool(
            bash_tool,
            "run",
            PermissionGate({"mcp": "always-allow"}),
            origin=MCP_ORIGIN,
        )
        tool.invoke({"command": f"printf ok > {_quote(target)}"})
        assert target.read_text() == "ok"

    def test_unknown_scope_level_does_not_run(self, tmp_path):
        target = tmp_path / "bad.txt"
        tool = guard_tool(
            bash_tool,
            "run",
            PermissionGate({"mcp": "sometimes"}),
            origin=MCP_ORIGIN,
        )
        result = tool.invoke({"command": f"printf ran > {_quote(target)}"})
        assert not target.exists()
        assert "not allowed" in result
