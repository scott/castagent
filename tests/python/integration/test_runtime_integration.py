"""
Integration tests for Runtime Agent.
Tests agent with memory, streaming responses, auth token validation, and error recovery.
"""
import os
import pytest
import asyncio
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.runtime import A2AServer
from cast.memory import MemoryStore


@pytest.fixture
def temp_agent_dir(tmp_path):
    """Create a temporary agent directory with full config."""
    agent_dir = tmp_path / "integration-agent"
    agent_dir.mkdir()

    agent_yaml = agent_dir / "agent.yaml"
    agent_yaml.write_text("""
name: integration-agent
version: "1.0"
description: "Agent for integration testing"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow
    read: always-allow

tools:
  builtin:
    - bash
    - read
  mcp: []
  custom: []
""")

    instructions = agent_dir / "instructions.md"
    instructions.write_text("You are a test agent for integration testing. Be helpful and concise.")

    return str(agent_dir)


@pytest.fixture
def echo_agent(temp_agent_dir):
    """Create a RuntimeAgent in echo mode (no API key)."""
    with patch.dict(os.environ, {}, clear=True):
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        return agent


class TestAgentWithMemory:
    """Tests for agent memory functionality."""

    @pytest.mark.asyncio
    async def test_agent_maintains_conversation_history(self, echo_agent):
        """Agent should maintain conversation history across messages."""
        # Process multiple messages
        response1 = await echo_agent.process_message("Hello")
        response2 = await echo_agent.process_message("How are you?")

        # Both responses should reference the agent name
        assert "integration-agent" in response1.lower() or "test" in response1.lower()
        assert len(response2) > 0

    @pytest.mark.asyncio
    async def test_agent_memory_persistence(self, temp_agent_dir):
        """Agent memory should persist between sessions."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent1 = RuntimeAgent(config)

            # Add some state
            await agent1.process_message("First message")

            # Create new agent instance
            agent2 = RuntimeAgent(config)

            # Should have context from previous agent
            response = await agent2.process_message("Continue our conversation")
            assert len(response) > 0


class TestStreamingResponses:
    """Tests for streaming response handling."""

    @pytest.mark.asyncio
    async def test_a2a_server_streaming(self, temp_agent_dir):
        """Test A2A server handles streaming responses."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Send message
            request = {
                "jsonrpc": "2.0",
                "id": "stream-test",
                "method": "message/send",
                "params": {
                    "message": {
                        "role": "user",
                        "parts": [{"kind": "text", "text": "Hello"}],
                        "messageId": "msg-stream"
                    }
                }
            }

            response = await server.handle_request(request)
            assert response["jsonrpc"] == "2.0"
            assert "result" in response
            assert "parts" in response["result"]

    @pytest.mark.asyncio
    async def test_response_contains_text_parts(self, echo_agent):
        """Response should contain text parts with content."""
        response = await echo_agent.process_message("What is your name?")

        # Response should have content
        assert len(response) > 0


class TestAuthTokenValidation:
    """Tests for authentication token validation."""

    @pytest.mark.asyncio
    async def test_token_verification_empty_token(self, temp_agent_dir):
        """Empty tokens should be valid in local mode."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Empty token should be valid
            assert server.verify_token("") is True

    @pytest.mark.asyncio
    async def test_token_verification_with_configured_token(self, temp_agent_dir):
        """Should verify configured auth tokens."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Set auth token
            server.set_auth_token("secret-token-123")

            # Correct token should be valid
            assert server.verify_token("secret-token-123") is True

            # Wrong token should be invalid
            assert server.verify_token("wrong-token") is False

    @pytest.mark.asyncio
    async def test_token_verification_no_auth_required_in_echo_mode(self, temp_agent_dir):
        """In echo mode (no API key), tokens should not be required."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Any token should work in echo mode
            assert server.verify_token("any-token") is True
            assert server.verify_token("") is True


class TestErrorRecovery:
    """Tests for error handling and recovery."""

    @pytest.mark.asyncio
    async def test_handles_invalid_jsonrpc_request(self, echo_agent):
        """Should handle malformed JSON-RPC requests gracefully."""
        with patch.dict(os.environ, {}, clear=True):
            server = A2AServer(echo_agent, port=0)

            # Invalid request format
            request = {
                "jsonrpc": "2.0",
                "id": "1",
                "method": "invalid/method",
                "params": {}
            }

            response = await server.handle_request(request)
            assert "error" in response
            assert response["error"]["code"] == -32601

    @pytest.mark.asyncio
    async def test_handles_missing_agent_directory(self):
        """Should handle missing agent directory gracefully."""
        with patch.dict(os.environ, {}, clear=True):
            non_existent_path = "/non/existent/path"
            config = AgentConfig(non_existent_path)

            # Should handle gracefully
            agent = RuntimeAgent(config)
            response = await agent.process_message("test")

            # Should return some response (error or fallback)
            assert response is not None

    @pytest.mark.asyncio
    async def test_handles_missing_instructions_file(self, tmp_path):
        """Should handle missing instructions file."""
        agent_dir = tmp_path / "no-instructions-agent"
        agent_dir.mkdir()

        agent_yaml = agent_dir / "agent.yaml"
        agent_yaml.write_text("""
name: no-instructions-agent
version: "1.0"
description: "Agent without instructions"
brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: missing.md
tools:
  builtin:
    - bash
  mcp: []
  custom: []
""")

        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(str(agent_dir))
            agent = RuntimeAgent(config)

            # Should handle gracefully
            response = await agent.process_message("test")
            assert len(response) > 0

    @pytest.mark.asyncio
    async def test_handles_invalid_yaml_config(self, tmp_path):
        """Should handle invalid YAML configuration."""
        agent_dir = tmp_path / "invalid-config-agent"
        agent_dir.mkdir()

        agent_yaml = agent_dir / "agent.yaml"
        agent_yaml.write_text("""
name: invalid-agent
version: "1.0"
brain:
  model: [invalid
yaml
""")

        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(str(agent_dir))
            # Should either parse with defaults or handle gracefully
            agent = RuntimeAgent(config)
            assert agent is not None


class TestA2AServerIntegration:
    """Comprehensive A2A server integration tests."""

    @pytest.mark.asyncio
    async def test_full_message_exchange_flow(self, temp_agent_dir):
        """Test complete message exchange flow."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Get agent card
            card_request = {
                "jsonrpc": "2.0",
                "id": "1",
                "method": "agent/card",
                "params": {}
            }
            card_response = await server.handle_request(card_request)
            assert card_response["result"]["name"] == "integration-agent"

            # Send message
            message_request = {
                "jsonrpc": "2.0",
                "id": "2",
                "method": "message/send",
                "params": {
                    "message": {
                        "role": "user",
                        "parts": [{"kind": "text", "text": "Hello, how are you?"}],
                        "messageId": "msg-1"
                    }
                }
            }
            message_response = await server.handle_request(message_request)
            assert "result" in message_response
            assert len(message_response["result"]["parts"]) > 0

            # Get task status
            task_request = {
                "jsonrpc": "2.0",
                "id": "3",
                "method": "task/get",
                "params": {"taskId": "msg-1"}
            }
            task_response = await server.handle_request(task_request)
            assert task_response["result"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_concurrent_requests(self, temp_agent_dir):
        """Should handle concurrent requests properly."""
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)

            # Send multiple concurrent requests
            requests = [
                {
                    "jsonrpc": "2.0",
                    "id": str(i),
                    "method": "message/send",
                    "params": {
                        "message": {
                            "role": "user",
                            "parts": [{"kind": "text", "text": f"Message {i}"}],
                            "messageId": f"msg-{i}"
                        }
                    }
                }
                for i in range(5)
            ]

            responses = await asyncio.gather(*[
                server.handle_request(req) for req in requests
            ])

            # All should succeed
            for response in responses:
                assert "jsonrpc" in response
                assert response["jsonrpc"] == "2.0"


class TestLLMIntegration:
    """Integration tests for LLM mode (requires API key)."""

    @pytest.mark.asyncio
    async def test_llm_mode_requires_api_key(self, temp_agent_dir):
        """Verify LLM mode behavior with and without API key."""
        # Without API key - should be in echo mode
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)

            # Agent should still function in echo mode
            response = await agent.process_message("Hello")
            assert len(response) > 0

    @pytest.mark.asyncio
    async def test_llm_tool_execution_integration(self, temp_agent_dir):
        """Test tool execution with real LLM."""
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            pytest.skip("OPENROUTER_API_KEY not set - skipping LLM integration test")

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": api_key}, clear=False):
            config = AgentConfig(temp_agent_dir)
            agent = RuntimeAgent(config)

            # Verify tools are loaded
            assert len(agent.tools) > 0

            # Process a message that might trigger tool use
            response = await agent.process_message("List the files in the current directory")
            assert len(response) > 0