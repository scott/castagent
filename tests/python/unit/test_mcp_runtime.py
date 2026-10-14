"""MCP stdio servers register tools the agent can call."""

import os
import shlex
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import yaml
from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.mcp.loader import _command_argv, _command_env, _unique_name, load_mcp_tools

FAKE_SERVER = Path(__file__).with_name("fake_mcp_server.py")


def _command(mode: str) -> str:
    return shlex.join([sys.executable, str(FAKE_SERVER), mode])


def _write_server(agent_dir: Path, filename: str, mode: str, env: dict | None = None) -> None:
    mcp_dir = agent_dir / "mcp"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "server": Path(filename).stem,
        "command": _command(mode),
    }
    if env:
        config["env"] = env
    (mcp_dir / filename).write_text(yaml.safe_dump(config), encoding="utf-8")


def _agent_dir(tmp_path: Path, mcp_entries: list, permissions: dict | None = None) -> Path:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    config = {
        "name": "mcp-agent",
        "version": "1.0",
        "description": "MCP test agent",
        "brain": {
            "model": "openrouter/anthropic/claude-3-7-sonnet",
            "instructions_file": "instructions.md",
        },
        "harness": {"permissions": permissions or {}},
        "tools": {
            "builtin": ["bash", "read", "glob"],
            "mcp": mcp_entries,
            "custom": [],
        },
    }
    (agent_dir / "agent.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    (agent_dir / "instructions.md").write_text("You are a test agent.\n", encoding="utf-8")
    return agent_dir


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    return len([line for line in path.read_text(encoding="utf-8").splitlines() if line])


class TestMcpConfigHelpers:
    def test_command_string_is_split(self):
        argv = _command_argv({"command": "npx -y @modelcontextprotocol/server-everything"})
        assert argv == ["npx", "-y", "@modelcontextprotocol/server-everything"]

    def test_command_and_args_list(self):
        argv = _command_argv({"command": "npx", "args": ["-y", "server"]})
        assert argv == ["npx", "-y", "server"]

    def test_env_expands_home_and_stringifies_numbers(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        monkeypatch.setenv("HOME", str(tmp_path))
        env = _command_env({
            "env": {
                "GMAIL_CREDENTIALS_PATH": "~/.cast/vault/token.json",
                "PORT": 3000,
            }
        })
        assert env["GMAIL_CREDENTIALS_PATH"] == str(tmp_path / ".cast/vault/token.json")
        assert env["PORT"] == "3000"

    def test_unique_name_prefixes_collisions(self):
        used = {"bash_tool", "echo_text"}
        assert _unique_name("everything", "bash_tool", used) == "everything_bash_tool"
        assert _unique_name("other", "echo_text", used) == "other_echo_text"


class TestMcpLoader:
    def test_lists_and_calls_tools_and_keeps_the_process(self, tmp_path: Path):
        agent_dir = tmp_path / "agent"
        count_path = tmp_path / "calls.txt"
        _write_server(
            agent_dir,
            "everything.yaml",
            "echo",
            {"CAST_MCP_MARKER": "quince", "CAST_MCP_COUNT": str(count_path)},
        )
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            [{"server": "everything", "config": "mcp/everything.yaml"}],
            timeout=5,
        )
        try:
            assert sessions[0].is_running()
            by_name = {tool.name: tool for tool in tools}
            assert set(by_name) == {"echo_text"}
            schema = by_name["echo_text"].tool_call_schema
            assert schema["properties"]["text"]["type"] == "string"
            assert by_name["echo_text"].invoke({"text": "hello"}) == "hello"
            assert by_name["echo_text"].invoke({"text": "status"}) == "initialized"
            assert by_name["echo_text"].invoke({"text": "env"}) == "quince"
            assert by_name["echo_text"].invoke({"text": "fail"}) == "Error: nope"
            assert _count_lines(count_path) == 4
            assert sessions[0].is_running()
        finally:
            for session in sessions:
                session.close()
        assert sessions[0].returncode is not None
        assert not sessions[0].is_running()

    def test_ping_during_call_does_not_deadlock(self, tmp_path: Path):
        agent_dir = tmp_path / "agent"
        _write_server(agent_dir, "ping.yaml", "ping")
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            [{"server": "ping", "config": "mcp/ping.yaml"}],
            timeout=5,
        )
        try:
            assert tools[0].invoke({"text": "hello"}) == "pong:hello"
        finally:
            for session in sessions:
                session.close()

    def test_content_length_frames_and_stdout_banner(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        agent_dir = tmp_path / "agent"
        _write_server(agent_dir, "framed.yaml", "framed")
        _write_server(agent_dir, "banner.yaml", "banner")
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            [
                {"server": "framed", "config": "mcp/framed.yaml"},
                {"name": "banner", "config": "mcp/banner.yaml"},
            ],
            timeout=5,
        )
        try:
            names = sorted(tool.name for tool in tools)
            assert names == ["banner_echo_text", "echo_text"]
            framed = next(tool for tool in tools if tool.name == "echo_text")
            assert framed.invoke({"text": "framed"}) == "framed"
        finally:
            for session in sessions:
                session.close()
        warning = capsys.readouterr().err
        assert "non-JSON" in warning

    def test_paginates_tool_list(self, tmp_path: Path):
        agent_dir = tmp_path / "agent"
        _write_server(agent_dir, "pages.yaml", "paginate")
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            ["pages"],
            timeout=5,
        )
        try:
            assert sorted(tool.name for tool in tools) == ["alpha", "beta"]
            assert tools[0].invoke({}) in ("alpha", "beta")
        finally:
            for session in sessions:
                session.close()

    def test_bad_yaml_is_skipped_and_other_servers_start(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        agent_dir = tmp_path / "agent"
        mcp_dir = agent_dir / "mcp"
        mcp_dir.mkdir(parents=True)
        (mcp_dir / "broken.yaml").write_text("command: [unterminated\n", encoding="utf-8")
        _write_server(agent_dir, "everything.yaml", "echo")
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            [
                {"server": "broken", "config": "mcp/broken.yaml"},
                {"server": "everything", "config": "mcp/everything.yaml"},
            ],
            timeout=5,
        )
        try:
            assert [tool.name for tool in tools] == ["echo_text"]
            assert sessions[0].is_running()
        finally:
            for session in sessions:
                session.close()
        warning = capsys.readouterr().err
        assert "could not be parsed" in warning
        assert "broken.yaml" in warning

    def test_path_escape_missing_command_and_dead_process_are_skipped(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        outside = tmp_path / "outside.yaml"
        outside.write_text(
            yaml.safe_dump({"server": "outside", "command": _command("echo")}),
            encoding="utf-8",
        )
        mcp_dir = agent_dir / "mcp"
        mcp_dir.mkdir()
        (mcp_dir / "nocommand.yaml").write_text("server: nocommand\n", encoding="utf-8")
        (mcp_dir / "exit.yaml").write_text(
            yaml.safe_dump({"server": "exit", "command": _command("exit")}),
            encoding="utf-8",
        )
        (mcp_dir / "missing.yaml").write_text(
            "server: missing\ncommand: /nonexistent/cast-mcp-no-such-bin\n",
            encoding="utf-8",
        )
        sessions, tools = load_mcp_tools(
            str(agent_dir),
            [
                {"server": "outside", "config": "../outside.yaml"},
                {"server": "absolute", "config": str(outside)},
                {"server": "nocommand", "config": "mcp/nocommand.yaml"},
                {"server": "exit", "config": "mcp/exit.yaml"},
                {"server": "missing", "config": "mcp/missing.yaml"},
            ],
            timeout=5,
        )
        try:
            assert sessions == []
            assert tools == []
        finally:
            for session in sessions:
                session.close()
        warning = capsys.readouterr().err
        assert "outside the agent directory" in warning
        assert "no command" in warning
        assert "failed to start" in warning or "not running" in warning or "exited" in warning


class TestRuntimeAgentMcp:
    def test_echo_mode_lists_mcp_tools(self, tmp_path: Path):
        agent_dir = _agent_dir(
            tmp_path,
            [{"server": "everything", "config": "mcp/everything.yaml"}],
        )
        _write_server(agent_dir, "everything.yaml", "echo")
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(AgentConfig.from_path(str(agent_dir)), agent_path=str(agent_dir))
        try:
            assert agent.graph is None
            response = agent._echo_response("what tools do you have?")
            assert "bash" in response
            assert "echo_text" in response
            assert agent.mcp_sessions[0].is_running()
            echo = next(tool for tool in agent.tools if tool.name == "echo_text")
            assert echo.invoke({"text": "from-echo"}) == "from-echo"
        finally:
            agent.close()

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_graph_receives_callable_mcp_tools(
        self, mock_create_react_agent, mock_provider_class, tmp_path: Path
    ):
        count_path = tmp_path / "calls.txt"
        agent_dir = _agent_dir(
            tmp_path,
            [{"server": "everything", "config": "mcp/everything.yaml"}],
            permissions={"echo_text": "deny"},
        )
        _write_server(
            agent_dir,
            "everything.yaml",
            "echo",
            {"CAST_MCP_COUNT": str(count_path)},
        )
        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(AgentConfig.from_path(str(agent_dir)), agent_path=str(agent_dir))
        try:
            loaded = mock_create_react_agent.call_args.kwargs["tools"]
            names = [tool.name for tool in loaded]
            assert names[:3] == ["bash_tool", "read_tool", "glob_tool"]
            assert "echo_text" in names
            guarded = next(tool for tool in loaded if tool.name == "echo_text")
            denied = guarded.invoke({"text": "secret"})
            assert "Permission denied" in denied
            assert "echo_text" in denied
            assert _count_lines(count_path) == 0
            raw = next(tool for tool in agent.tools if tool.name == "echo_text")
            assert raw.invoke({"text": "allowed"}) == "allowed"
            assert _count_lines(count_path) == 1
            assert agent.mcp_sessions[0].is_running()
        finally:
            agent.close()
