"""Issue #275: a deny-session memory must not outrank later permissions.

After bash=deny, memory.db can store a boundary: "The bash tool is
currently set to deny". After `cast update --permission bash=always-allow`
and a restart, that row must not be injected into the prompt.
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.harness.permissions import PermissionGate
from cast.memory.middleware import MemoryMiddleware
from cast.memory.permission_memory import (
    permission_claims,
    without_stale_permission_claims,
)
from cast.memory.store import MemoryHighlight, MemoryStore


DENY_BOUNDARY = "The bash tool is currently set to deny"
DISABLED_BOUNDARY = "the bash tool is currently disabled"
PREFERENCE = "The user likes short answers"
RATE_LIMIT = "The upstream API is limited to 10 requests per minute"
KEEP_BASH = "Do not use bash to delete the home directory"


def _gate(permissions: dict) -> PermissionGate:
    return PermissionGate(permissions)


def _agent_dir(tmp_path: Path, bash_level: str | None) -> Path:
    agent_dir = tmp_path / "perm-agent"
    agent_dir.mkdir()
    permissions = ""
    if bash_level is not None:
        permissions = (
            "harness:\n"
            "  permissions:\n"
            f"    bash: {bash_level}\n"
        )
    (agent_dir / "agent.yaml").write_text(
        "name: perm-agent\n"
        "version: '1.0'\n"
        "description: permission memory\n"
        "brain:\n"
        "  model: openrouter/anthropic/claude-3-7-sonnet\n"
        f"{permissions}"
        "tools:\n"
        "  builtin: [bash, read, glob]\n",
        encoding="utf-8",
    )
    (agent_dir / "instructions.md").write_text("You are a test agent.\n", encoding="utf-8")
    memory = agent_dir / "memory"
    memory.mkdir()
    (memory / "config.yaml").write_text("memory:\n  enabled: true\n", encoding="utf-8")
    return agent_dir


def _highlight(category: str, content: str, source: str = "exchange_1") -> MemoryHighlight:
    return MemoryHighlight(
        timestamp=datetime.now(timezone.utc).isoformat(),
        category=category,
        content=content,
        source=source,
        tags=[],
    )


def _seed(agent_dir: Path, rows: list[tuple[str, str]]) -> None:
    store = MemoryStore(agent_dir)
    for category, content in rows:
        store.append(_highlight(category, content))


def _contents(agent_dir: Path) -> list[str]:
    db_path = agent_dir / "memory" / "memory.db"
    with sqlite3.connect(db_path) as conn:
        return [row[0] for row in conn.execute("SELECT content FROM highlights ORDER BY id")]


class TestPermissionClaims:
    def test_issue_phrase_is_a_deny_claim(self):
        claims = permission_claims(DENY_BOUNDARY, _gate({"bash": "always-allow"}))
        assert claims == [("bash", "deny")]

    def test_disabled_phrase_is_a_deny_claim(self):
        claims = permission_claims(DISABLED_BOUNDARY, _gate({"bash": "always-allow"}))
        assert ("bash", "deny") in claims

    def test_assignment_and_ask(self):
        gate = _gate({"bash": "always-allow"})
        assert permission_claims("bash=always-allow", gate) == [("bash", "always-allow")]
        assert permission_claims("bash: ask", gate) == [("bash", "ask")]
        assert permission_claims("permission for the bash tool is deny", gate) == [("bash", "deny")]
        assert permission_claims("bash permission level is ask", gate) == [("bash", "ask")]

    def test_comma_phrase_and_set_verb(self):
        gate = _gate({"bash": "deny"})
        text = "The bash tool, which is currently set to deny, cannot run."
        assert ("bash", "deny") in permission_claims(text, gate)
        assert permission_claims("set the bash tool to always-allow", gate) == [
            ("bash", "always-allow")
        ]

    def test_ordinary_sentences_are_not_claims(self):
        gate = _gate({"bash": "always-allow", "read": "always-allow"})
        for text in (
            KEEP_BASH,
            RATE_LIMIT,
            "I read the design notes",
            "Please read: deny this request",
            "The bash tool is not set to deny",
            "Permission denied while reading /etc/shadow",
        ):
            assert permission_claims(text, gate) == [], text

    def test_tool_result_is_a_claim_and_shadow_is_not(self):
        gate = _gate({"bash": "always-allow"})
        error = (
            "Error: Permission denied for bash. "
            "This tool is set to deny and was not executed."
        )
        assert ("bash", "deny") in permission_claims(error, gate)
        ask = (
            "Error: Permission denied for bash. "
            "Approval is required before this tool can run, and it was not executed."
        )
        assert ("bash", "ask") in permission_claims(ask, gate)

    def test_read_tool_does_not_match_the_verb(self):
        gate = _gate({"read": "always-allow", "bash": "always-allow"})
        text = "I read the file and the bash tool is set to deny"
        claims = permission_claims(text, gate)
        assert ("read", "deny") not in claims
        assert ("bash", "deny") in claims


class TestStaleText:
    def test_conflicting_sentence_is_removed_and_other_text_stays(self):
        gate = _gate({"bash": "always-allow"})
        revised = without_stale_permission_claims(
            f"{PREFERENCE}. {DENY_BOUNDARY}.",
            gate,
        )
        assert revised == f"{PREFERENCE}."

    def test_matching_claim_is_unchanged(self):
        gate = _gate({"bash": "deny"})
        assert without_stale_permission_claims(DENY_BOUNDARY, gate) == DENY_BOUNDARY

    def test_whole_highlight_is_dropped_when_nothing_remains(self):
        gate = _gate({"bash": "always-allow"})
        assert without_stale_permission_claims(DENY_BOUNDARY, gate) is None

    def test_tool_error_sentences_are_dropped_when_bash_is_allowed(self):
        gate = _gate({"bash": "always-allow"})
        error = (
            "Error: Permission denied for bash. "
            "This tool is set to deny and was not executed. "
            f"{PREFERENCE}."
        )
        assert without_stale_permission_claims(error, gate) == f"{PREFERENCE}."

    def test_stale_always_allow_is_dropped_when_the_gate_denies(self):
        gate = _gate({"bash": "deny"})
        text = "The bash tool is currently set to always-allow"
        assert without_stale_permission_claims(text, gate) is None


class TestMiddlewareReconcile:
    def test_startup_drops_the_deny_boundary_after_always_allow(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, "always-allow")
        _seed(agent_dir, [
            ("boundary", DENY_BOUNDARY),
            ("preference", PREFERENCE),
            ("boundary", RATE_LIMIT),
            ("boundary", KEEP_BASH),
        ])
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({"bash": "always-allow"})

        contents = _contents(agent_dir)
        assert DENY_BOUNDARY not in contents
        assert PREFERENCE in contents
        assert RATE_LIMIT in contents
        assert KEEP_BASH in contents

        context = middleware.format_memories("Call the bash tool and quote the raw result")
        assert "set to deny" not in context
        assert "currently disabled" not in context
        assert PREFERENCE in context
        assert RATE_LIMIT in context

    def test_current_deny_keeps_the_boundary(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, "deny")
        _seed(agent_dir, [("boundary", DENY_BOUNDARY), ("preference", PREFERENCE)])
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({"bash": "deny"})

        assert DENY_BOUNDARY in _contents(agent_dir)
        context = middleware.format_memories("Call the bash tool")
        assert DENY_BOUNDARY in context

    def test_disabled_phrase_recorded_later_is_not_replayed(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, "always-allow")
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({"bash": "always-allow"})
        middleware.store.append(_highlight("boundary", DISABLED_BOUNDARY))

        context = middleware.format_memories("call bash")
        assert "disabled" not in context
        assert _contents(agent_dir) == []

    def test_explicit_deny_fact_is_not_stored_when_bash_is_allowed(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, "always-allow")
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({"bash": "always-allow"})

        saved = middleware.remember_explicit(f"remember: {DENY_BOUNDARY}")
        assert saved is None
        assert not (agent_dir / "memory" / "notes.md").exists()
        assert _contents(agent_dir) == []

        kept = middleware.remember_explicit("remember: my favorite fruit is quince")
        assert kept is not None
        assert kept.content == "my favorite fruit is quince"

    def test_record_sync_skips_a_stale_boundary(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, "always-allow")
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({"bash": "always-allow"})
        middleware.reflection.reflect_sync = lambda *_args, **_kwargs: _highlight(
            "boundary",
            f"{DENY_BOUNDARY}. {PREFERENCE}.",
        )

        saved = middleware.record_sync("use bash", "refused", "exchange_2")
        assert saved is not None
        assert saved.content == f"{PREFERENCE}."
        assert _contents(agent_dir) == [f"{PREFERENCE}."]

    def test_git_push_default_ask_drops_a_stale_allow(self, tmp_path):
        agent_dir = _agent_dir(tmp_path, None)
        _seed(agent_dir, [
            ("boundary", "git_push is set to always-allow"),
            ("boundary", "git_push is set to ask"),
        ])
        middleware = MemoryMiddleware(agent_dir)
        middleware.bind_permissions({})

        contents = _contents(agent_dir)
        assert "git_push is set to always-allow" not in contents
        assert "git_push is set to ask" in contents


class TestRuntimeRestart:
    def test_restart_removes_the_deny_boundary_before_the_first_turn(self, tmp_path, monkeypatch):
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("DIGITALOCEAN_API_KEY", raising=False)
        monkeypatch.delenv("CAST_MEMORY_PATH", raising=False)
        agent_dir = _agent_dir(tmp_path, "always-allow")
        _seed(agent_dir, [
            ("boundary", DENY_BOUNDARY),
            ("boundary", DISABLED_BOUNDARY),
            ("preference", PREFERENCE),
        ])

        config = AgentConfig.from_path(str(agent_dir))
        RuntimeAgent(config, agent_path=str(agent_dir))

        contents = _contents(agent_dir)
        assert contents == [PREFERENCE]

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_allowed_bash_turn_does_not_include_the_old_boundary(
        self, mock_create_react_agent, mock_provider_class, tmp_path, monkeypatch
    ):
        monkeypatch.delenv("CAST_MEMORY_PATH", raising=False)
        agent_dir = _agent_dir(tmp_path, "always-allow")
        _seed(agent_dir, [("boundary", DENY_BOUNDARY), ("preference", PREFERENCE)])

        mock_ai = MagicMock()
        mock_ai.content = "ran"
        mock_graph = MagicMock()
        mock_create_react_agent.return_value = mock_graph
        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider.name = "OpenRouter"
        mock_provider_class.return_value = mock_provider

        seen = {}

        async def _capture(payload):
            seen["messages"] = payload["messages"]
            return {"messages": [mock_ai]}

        mock_graph.ainvoke = _capture

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            config = AgentConfig.from_path(str(agent_dir))
            agent = RuntimeAgent(config, agent_path=str(agent_dir))
            agent.memory.record = AsyncMock(return_value=None)
            await agent.process_message("Call the bash tool and quote the raw result")

        prompt = mock_create_react_agent.call_args.kwargs["prompt"]
        assert "Live harness.permissions override memories from past sessions." in prompt
        assert "Current levels: bash=always-allow." in prompt

        text = seen["messages"][-1].content
        assert DENY_BOUNDARY not in text
        assert "currently disabled" not in text
        assert PREFERENCE in text
        assert "Call the bash tool and quote the raw result" in text
