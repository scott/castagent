"""Persistent memory in cast dev.

Issue #209: "remember: my favorite fruit is QUINCE-BB2" was not stored,
and the read tool could not open memory/notes.md in the agent directory.
"""

import os
import sqlite3
from unittest.mock import MagicMock, patch

import pytest

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.memory.explicit import explicit_remember_fact
from cast.memory.middleware import MemoryMiddleware
from cast.runtime import configure_runtime_env
from cast.tools.read import read_tool


REMEMBER = "remember: my favorite fruit is QUINCE-BB2"


def _write_agent(agent_dir, *, enabled=True):
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "agent.yaml").write_text(
        "name: fruit-agent\n"
        "version: '1.0'\n"
        "description: remembers fruit\n"
        "brain:\n"
        "  model: openrouter/anthropic/claude-3-7-sonnet\n"
        "tools:\n"
        "  builtin: [bash, read, glob]\n"
    )
    (agent_dir / "instructions.md").write_text("You are a helpful test agent.\n")
    memory = agent_dir / "memory"
    memory.mkdir()
    (memory / "config.yaml").write_text(
        "memory:\n"
        f"  enabled: {str(enabled).lower()}\n"
    )
    return agent_dir


def _highlight_contents(agent_dir):
    db_path = agent_dir / "memory" / "memory.db"
    if not db_path.exists():
        return []
    with sqlite3.connect(db_path) as conn:
        return [row[0] for row in conn.execute("SELECT content FROM highlights")]


class TestExplicitRememberFact:
    def test_colon_form(self):
        assert explicit_remember_fact(REMEMBER) == "my favorite fruit is QUINCE-BB2"

    def test_remember_that_form(self):
        fact = explicit_remember_fact("please remember that my favorite fruit is QUINCE-BB2")
        assert fact == "my favorite fruit is QUINCE-BB2"

    def test_ordinary_message_is_not_a_fact(self):
        assert explicit_remember_fact("what is my favorite fruit?") is None
        assert explicit_remember_fact("I remember the old name") is None


class TestDevPersistentMemory:
    @pytest.mark.asyncio
    async def test_remember_is_in_the_database_and_notes(self, tmp_path, monkeypatch):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("DIGITALOCEAN_API_KEY", raising=False)

        config = AgentConfig.from_path(str(agent_dir))
        agent = RuntimeAgent(config, agent_path=str(agent_dir))
        await agent.process_message(REMEMBER)

        contents = _highlight_contents(agent_dir)
        assert contents == ["my favorite fruit is QUINCE-BB2"]
        notes = (agent_dir / "memory" / "notes.md").read_text(encoding="utf-8")
        assert "QUINCE-BB2" in notes

        # A new process, the same agent directory: the fact is still there.
        restarted = MemoryMiddleware(agent_dir)
        context = restarted.format_memories("what is my favorite fruit?")
        assert "QUINCE-BB2" in context

        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        monkeypatch.setenv("CAST_AGENT_PATH", str(agent_dir))
        monkeypatch.chdir(elsewhere)
        read = read_tool.invoke({"file_path": "memory/notes.md"})
        assert "QUINCE-BB2" in read
        assert "not found" not in read.lower()

    @pytest.mark.asyncio
    async def test_stream_remember_is_stored(self, tmp_path, monkeypatch):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

        config = AgentConfig.from_path(str(agent_dir))
        agent = RuntimeAgent(config, agent_path=str(agent_dir))
        chunks = []
        async for chunk in agent.process_message_stream(REMEMBER):
            chunks.append(chunk)

        assert chunks
        assert "QUINCE-BB2" in _highlight_contents(agent_dir)

    @pytest.mark.asyncio
    async def test_disabled_memory_does_not_write(self, tmp_path, monkeypatch):
        agent_dir = _write_agent(tmp_path / "fruit-agent", enabled=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        config = AgentConfig.from_path(str(agent_dir))
        agent = RuntimeAgent(config, agent_path=str(agent_dir))

        await agent.process_message(REMEMBER)

        assert not (agent_dir / "memory" / "notes.md").exists()
        assert not (agent_dir / "memory" / "memory.db").exists()

    @pytest.mark.asyncio
    async def test_unrelated_message_does_not_write_notes(self, tmp_path, monkeypatch):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        config = AgentConfig.from_path(str(agent_dir))
        agent = RuntimeAgent(config, agent_path=str(agent_dir))

        await agent.process_message("what is my favorite fruit?")

        assert not (agent_dir / "memory" / "notes.md").exists()
        assert _highlight_contents(agent_dir) == []

    def test_duplicate_remember_is_one_row(self, tmp_path):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        middleware = MemoryMiddleware(agent_dir)
        first = middleware.remember_explicit(REMEMBER)
        second = middleware.remember_explicit(REMEMBER)

        assert first is not None
        assert second is not None
        assert _highlight_contents(agent_dir) == ["my favorite fruit is QUINCE-BB2"]
        notes = (agent_dir / "memory" / "notes.md").read_text(encoding="utf-8")
        assert notes.count("QUINCE-BB2") == 1

    def test_configure_runtime_env_sets_agent_path(self, tmp_path, monkeypatch):
        monkeypatch.delenv("CAST_AGENT_PATH", raising=False)
        root = configure_runtime_env(str(tmp_path))
        assert os.environ["CAST_AGENT_PATH"] == root
        assert os.path.realpath(root) == os.path.realpath(tmp_path)


class TestPersistentMemoryPrompt:
    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_enabled_memory_is_in_the_system_prompt(
        self, mock_create_react_agent, mock_provider_class, tmp_path
    ):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            RuntimeAgent(AgentConfig.from_path(str(agent_dir)), agent_path=str(agent_dir))

        prompt = mock_create_react_agent.call_args.kwargs["prompt"]
        assert "memory/notes.md" in prompt
        assert "memory/memory.db" in prompt
        assert "Do not say that you lack a memory tool." in prompt

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_disabled_memory_leaves_the_prompt_unchanged(
        self, mock_create_react_agent, mock_provider_class, tmp_path
    ):
        agent_dir = _write_agent(tmp_path / "fruit-agent", enabled=False)
        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            RuntimeAgent(AgentConfig.from_path(str(agent_dir)), agent_path=str(agent_dir))

        prompt = mock_create_react_agent.call_args.kwargs["prompt"]
        assert "Persistent memory" not in prompt

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_saved_fact_is_on_the_model_turn(
        self, mock_create_react_agent, mock_provider_class, tmp_path
    ):
        agent_dir = _write_agent(tmp_path / "fruit-agent")
        mock_ai = MagicMock()
        mock_ai.content = "I will remember that."
        mock_graph = MagicMock()
        mock_create_react_agent.return_value = mock_graph
        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider_class.return_value = mock_provider

        seen = {}

        async def _capture(payload):
            seen["messages"] = payload["messages"]
            return {"messages": [mock_ai]}

        mock_graph.ainvoke = _capture

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(AgentConfig.from_path(str(agent_dir)), agent_path=str(agent_dir))
            # Reflection must not call a provider during this turn.
            agent.memory.reflection.llm = None
            await agent.process_message(REMEMBER)

        text = seen["messages"][-1].content
        assert "QUINCE-BB2" in text
