import os
import pytest
from unittest.mock import patch

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.runtime import A2AServer


@pytest.fixture
def temp_agent_dir(tmp_path):
    """Create a temporary agent directory."""
    agent_dir = tmp_path / "a2a-test-agent"
    agent_dir.mkdir()

    agent_yaml = agent_dir / "agent.yaml"
    agent_yaml.write_text("""
name: a2a-test-agent
version: "1.0"
description: "A2A test agent"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow

tools:
  builtin:
    - bash
  mcp: []
  custom: []
""")

    instructions = agent_dir / "instructions.md"
    instructions.write_text("You are an A2A test agent.")

    return str(agent_dir)


@pytest.fixture
def a2a_server(temp_agent_dir):
    """Create an A2A server in echo mode."""
    with patch.dict(os.environ, {}, clear=True):
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent, port=0)
        return server


class TestA2AServerAgentCard:
    """Tests for A2A agent/card endpoint."""

    @pytest.mark.asyncio
    async def test_agent_card(self, a2a_server):
        """agent/card should return valid AgentCard."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response
        assert response["result"]["name"] == "a2a-test-agent"
        assert response["result"]["protocolVersion"] == "0.2.9"
        assert response["result"]["capabilities"]["chatAgent"] is True


class TestA2AServerMessageSend:
    """Tests for A2A message/send endpoint."""

    @pytest.mark.asyncio
    async def test_message_send_hello(self, a2a_server):
        """message/send should process user message and return response."""
        request = {
            "jsonrpc": "2.0",
            "id": "2",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "hello"}],
                    "messageId": "test-1",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response
        assert "parts" in response["result"]
        assert response["result"]["parts"][0]["kind"] == "text"
        assert "a2a-test-agent" in response["result"]["parts"][0]["text"]

    @pytest.mark.asyncio
    async def test_message_send_tools(self, a2a_server):
        """message/send should respond to tool queries."""
        request = {
            "jsonrpc": "2.0",
            "id": "3",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "what tools do you have?"}],
                    "messageId": "test-2",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "bash" in response["result"]["parts"][0]["text"]

    @pytest.mark.asyncio
    async def test_message_send_empty_text(self, a2a_server):
        """message/send should handle empty text gracefully."""
        request = {
            "jsonrpc": "2.0",
            "id": "4",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": ""}],
                    "messageId": "test-3",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response


class TestA2AServerTaskGet:
    """Tests for A2A task/get endpoint."""

    @pytest.mark.asyncio
    async def test_task_get(self, a2a_server):
        """task/get should return completed status."""
        request = {
            "jsonrpc": "2.0",
            "id": "5",
            "method": "task/get",
            "params": {"taskId": "task-1"},
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert response["result"]["status"] == "completed"


class TestA2AServerErrors:
    """Tests for A2A error handling."""

    @pytest.mark.asyncio
    async def test_unknown_method(self, a2a_server):
        """Unknown method should return error."""
        request = {
            "jsonrpc": "2.0",
            "id": "6",
            "method": "unknown/method",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == -32601

    @pytest.mark.asyncio
    async def test_port_selection(self, a2a_server):
        """Server should select a valid port."""
        assert a2a_server.port > 0
        assert a2a_server.port <= 65535

    def test_auth_token_verification(self, a2a_server):
        """Token verification should work correctly."""
        # Local mode - no auth required
        assert a2a_server.verify_token("") is True
        assert a2a_server.verify_token("any-token") is True

        # Set auth token
        a2a_server.set_auth_token("secret-token")
        assert a2a_server.verify_token("secret-token") is True
        assert a2a_server.verify_token("wrong-token") is False
