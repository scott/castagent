"""A2A message/send must honor harness.permissions (issue #206)."""

import asyncio
import json
import os
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.harness.permissions import PermissionPrompt
from cast.runtime import JSONRPC_INVALID_PARAMS, A2AServer
from langchain_core.messages import AIMessage, AIMessageChunk


def _write_agent(tmp_path: Path, bash_level: str) -> str:
    agent_dir = tmp_path / f"bb2-chat-{uuid.uuid4().hex[:8]}"
    agent_dir.mkdir()
    (agent_dir / "agent.yaml").write_text(f"""
name: bb2-chat
version: "1.0"
description: "permission repro"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: {bash_level}

tools:
  builtin:
    - bash
  mcp: []
  custom: []
""")
    (agent_dir / "instructions.md").write_text("You are a test agent.")
    return str(agent_dir)


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


def _message(text: str, request_id: str = "1") -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": [{"kind": "text", "text": text}],
                "messageId": request_id,
            }
        },
    }


@pytest.fixture
def guarded_agent(tmp_path):
    """LLM-mode agent whose graph calls the real guarded bash tool."""

    def build(level: str, command: str):
        agent_dir = _write_agent(tmp_path, level)
        calls = {}

        async def ainvoke(_payload):
            tool = calls["bash"]
            result = await tool.ainvoke({"command": command})
            return {"messages": [AIMessage(content=result)]}

        async def astream(_payload, stream_mode=None):
            tool = calls["bash"]
            result = await tool.ainvoke({"command": command})
            yield AIMessageChunk(content=result), {}

        with (
            patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}),
            patch("cast.agent.runtime.get_provider") as get_provider,
            patch("cast.agent.runtime.create_react_agent") as create_graph,
        ):
                provider = MagicMock()
                provider.is_available.return_value = True
                provider.create_llm.return_value = MagicMock()
                provider.env_var = "OPENROUTER_API_KEY"
                provider.name = "OpenRouter"
                get_provider.return_value = provider
                graph = MagicMock()
                graph.ainvoke = ainvoke
                graph.astream = astream
                create_graph.return_value = graph
                config = AgentConfig.from_path(agent_dir)
                agent = RuntimeAgent(config, agent_path=agent_dir)
                agent.memory.format_memories = MagicMock(return_value="")
                agent.memory.record = AsyncMock(return_value=None)
                calls["bash"] = next(
                    tool for tool in create_graph.call_args.kwargs["tools"]
                    if tool.name == "bash_tool"
                )
                yield_agent = agent
        return yield_agent

    return build


class TestMessageSendPermissions:
    @pytest.mark.asyncio
    async def test_deny_message_send_does_not_create_the_file(self, tmp_path, guarded_agent):
        target = tmp_path / "deny-proof.txt"
        command = f"printf 1791990322441334951 > {_quote(target)}"
        agent = guarded_agent("deny", command)
        server = A2AServer(agent, port=0)

        response = await server.handle_request(_message(
            "Use the bash tool to run exactly: " + command
        ))

        assert "error" not in response
        text = response["result"]["parts"][0]["text"]
        assert "Permission denied" in text
        assert "bash" in text
        assert not target.exists()

    @pytest.mark.asyncio
    async def test_ask_message_send_does_not_run_without_a_prompt(self, tmp_path, guarded_agent):
        target = tmp_path / "ask-proof.txt"
        command = f"printf ran > {_quote(target)}"
        agent = guarded_agent("ask", command)
        server = A2AServer(agent, port=0)

        response = await server.handle_request(_message("run the command"))

        text = response["result"]["parts"][0]["text"]
        assert "Approval is required" in text
        assert not target.exists()

    @pytest.mark.asyncio
    async def test_streaming_ask_runs_only_when_approved(self, tmp_path, guarded_agent):
        target = tmp_path / "stream-proof.txt"
        command = f"printf yes > {_quote(target)}"
        agent = guarded_agent("ask", command)
        server = A2AServer(agent, port=0)

        denied_target = tmp_path / "stream-denied.txt"
        agent_deny = guarded_agent("ask", f"printf yes > {_quote(denied_target)}")
        server_deny = A2AServer(agent_deny, port=0)

        async def drive_on(active, approved: bool):
            events = []
            async for event in active.handle_streaming_request(_message("run it", "stream-1")):
                events.append(event)
                if "permissionRequest" not in event:
                    continue
                payload = json.loads(event.removeprefix("data: ").strip())
                request = payload["result"]["metadata"]["permissionRequest"]
                assert request["tool"] == "bash"
                assert "printf" in request["arguments"]["command"]
                answered = await active.handle_request({
                    "jsonrpc": "2.0",
                    "id": "perm",
                    "method": "permission/respond",
                    "params": {"id": request["id"], "approved": approved},
                })
                assert answered["result"]["ok"] is True
            return "".join(events)

        denied_body = await asyncio.wait_for(drive_on(server_deny, False), timeout=5)
        assert "Permission denied" in denied_body
        assert not denied_target.exists()

        approved_body = await asyncio.wait_for(drive_on(server, True), timeout=5)
        assert target.read_text() == "yes"
        assert "yes" in approved_body

    @pytest.mark.asyncio
    async def test_permission_respond_without_a_prompt_is_an_error(self, tmp_path, guarded_agent):
        agent = guarded_agent("deny", "true")
        server = A2AServer(agent, port=0)
        response = await server.handle_request({
            "jsonrpc": "2.0",
            "id": "perm",
            "method": "permission/respond",
            "params": {"id": "missing", "approved": True},
        })
        assert response["error"]["code"] == JSONRPC_INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_permission_respond_rejects_a_string_approval(self, tmp_path, guarded_agent):
        agent = guarded_agent("ask", "true")
        server = A2AServer(agent, port=0)
        response = await server.handle_request({
            "jsonrpc": "2.0",
            "id": "perm",
            "method": "permission/respond",
            "params": {"id": "req", "approved": "true"},
        })
        assert response["error"]["code"] == JSONRPC_INVALID_PARAMS


class TestStreamPrompt:
    @pytest.mark.asyncio
    async def test_stream_yields_a_prompt_before_the_tool_finishes(self, tmp_path):
        agent_dir = _write_agent(tmp_path, "ask")
        seen = {}

        async def astream(_payload, stream_mode=None):
            approved = await seen["agent"].approval_broker.request(
                "bash", {"command": "date"}
            )
            yield AIMessageChunk(content="yes" if approved else "no"), {}

        with (
            patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}),
            patch("cast.agent.runtime.get_provider") as get_provider,
            patch("cast.agent.runtime.create_react_agent") as create_graph,
        ):
                provider = MagicMock()
                provider.is_available.return_value = True
                provider.create_llm.return_value = MagicMock()
                provider.env_var = "OPENROUTER_API_KEY"
                provider.name = "OpenRouter"
                get_provider.return_value = provider
                graph = MagicMock()
                graph.astream = astream
                create_graph.return_value = graph
                agent = RuntimeAgent(AgentConfig.from_path(agent_dir), agent_path=agent_dir)
                agent.memory.format_memories = MagicMock(return_value="")
                agent.memory.record = AsyncMock(return_value=None)
                seen["agent"] = agent

                chunks = []

                async def collect():
                    async for chunk in agent.process_message_stream("hi"):
                        chunks.append(chunk)
                        if isinstance(chunk, PermissionPrompt):
                            assert chunk.request["tool"] == "bash"
                            assert agent.approval_broker.respond(chunk.request["id"], False)

                await asyncio.wait_for(collect(), timeout=5)

        assert any(isinstance(chunk, PermissionPrompt) for chunk in chunks)
        assert "no" in chunks
