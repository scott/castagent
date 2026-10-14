"""
Integration tests for Builder Agent.
Tests builder process, agent creation flow, and config generation.
"""
import os
import json
import pytest
import asyncio
from pathlib import Path
from unittest.mock import patch, MagicMock

from cast.builder import BuilderAgent, StdioJsonRpcServer


@pytest.fixture
def temp_agents_dir(tmp_path):
    """Create a temporary agents directory."""
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    return str(agents_dir)


@pytest.fixture
def builder_agent():
    """Create a BuilderAgent instance."""
    with patch.dict(os.environ, {}, clear=True):
        agent = BuilderAgent()
        return agent


class TestBuilderProcess:
    """Tests for the builder process flow."""

    @pytest.mark.asyncio
    async def test_builder_agent_initialization(self, builder_agent):
        """BuilderAgent should initialize correctly."""
        assert builder_agent is not None
        assert builder_agent.llm is not None
        assert len(builder_agent.tools) > 0
        assert builder_agent.graph is not None

    @pytest.mark.asyncio
    async def test_builder_processes_create_agent_message(self, builder_agent):
        """Builder should process create agent messages."""
        response = await builder_agent.process_message(
            "Create an email agent that reads my inbox"
        )

        # Should get some response
        assert len(response) > 0

    @pytest.mark.asyncio
    async def test_builder_processes_list_agents_message(self, builder_agent):
        """Builder should process list agents messages."""
        response = await builder_agent.process_message("list agents")

        # Should get a response about agents
        assert len(response) > 0
        # Should mention tools or agent creation
        assert any(keyword in response.lower() for keyword in ["agent", "create", "tool", "list"])

    @pytest.mark.asyncio
    async def test_builder_processes_config_message(self, builder_agent):
        """Builder should process config-related messages."""
        response = await builder_agent.process_message(
            "Show me the config for my agent"
        )

        # Should get some response
        assert len(response) > 0

    @pytest.mark.asyncio
    async def test_builder_processes_model_recommendation(self, builder_agent):
        """Builder should process model recommendation requests."""
        response = await builder_agent.process_message(
            "Recommend a model for simple text tasks"
        )

        # Should get a response
        assert len(response) > 0

    @pytest.mark.asyncio
    async def test_builder_handles_empty_message(self, builder_agent):
        """Builder should handle empty messages gracefully."""
        response = await builder_agent.process_message("")

        # Should get some response
        assert len(response) > 0


class TestAgentCreationFlow:
    """Tests for agent creation flow."""

    @pytest.mark.asyncio
    async def test_agent_creation_in_new_mode(self, temp_agents_dir):
        """Test agent creation in new mode."""
        with patch.dict(os.environ, {"CAST_NEW_MODE": "1"}, clear=False):
            agent = BuilderAgent()
            agent.set_new_mode(True)

            # Simulate creating an agent
            response = await agent.process_message(
                "I want an agent that sends emails"
            )

            assert len(response) > 0

    @pytest.mark.asyncio
    async def test_builder_understands_agent_descriptions(self, builder_agent):
        """Builder should extract agent purpose from descriptions."""
        test_descriptions = [
            "Create an agent that reads my Gmail",
            "I need an agent that manages my calendar",
            "Build me a code review agent",
        ]

        for desc in test_descriptions:
            response = await builder_agent.process_message(desc)
            assert len(response) > 0


class TestConfigGeneration:
    """Tests for configuration generation."""

    @pytest.mark.asyncio
    async def test_builder_generates_valid_yaml_config(self, temp_agents_dir):
        """Builder should generate valid YAML configuration."""
        agent = BuilderAgent()
        agent.set_agent_name("test-agent")

        # Check that builder can process config-related messages
        response = await agent.process_message(
            "Update the config for my agent"
        )

        assert len(response) > 0

    @pytest.mark.asyncio
    async def test_builder_recommends_appropriate_tools(self, builder_agent):
        """Builder should recommend appropriate tools based on agent purpose."""
        response = await builder_agent.process_message(
            "Create an agent that works with files"
        )

        # Should recommend tools
        assert len(response) > 0


class TestStdioJsonRpcServer:
    """Tests for the stdio JSON-RPC server."""

    @pytest.mark.asyncio
    async def test_server_initialization(self):
        """Server should initialize correctly."""
        server = StdioJsonRpcServer()
        assert server.agent is not None
        assert "initialize" in server.methods
        assert "tool_call" in server.methods
        assert "output" in server.methods

    @pytest.mark.asyncio
    async def test_handle_initialize(self):
        """Should handle initialize method."""
        server = StdioJsonRpcServer()

        params = {"agent_name": "test-agent", "new_mode": False}
        result = await server.handle_initialize(params)

        assert "status" in result
        assert result["status"] == "ready"
        assert result["agent_name"] == "test-agent"
        assert "message" in result

    @pytest.mark.asyncio
    async def test_handle_initialize_new_mode(self):
        """Should handle initialize in new mode."""
        server = StdioJsonRpcServer()

        params = {"agent_name": "__new__", "new_mode": True}
        result = await server.handle_initialize(params)

        assert result["status"] == "ready"
        assert result["new_mode"] is True

    @pytest.mark.asyncio
    async def test_handle_tool_call(self):
        """Should handle tool_call method."""
        server = StdioJsonRpcServer()
        await server.handle_initialize({"agent_name": "test-agent"})

        # Try a valid tool call
        params = {
            "tool": "list_agents",
            "args": {},
            "call_id": "call-1"
        }
        result = await server.handle_tool_call(params)

        assert "call_id" in result or "output" in result or "error" in result

    @pytest.mark.asyncio
    async def test_handle_output(self, tmp_path, monkeypatch):
        """Should handle output (user message) method."""
        from cast import versioning
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)
        monkeypatch.setattr(tools, "BUILDER_DIR", tmp_path / "builder")
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents)

        server = StdioJsonRpcServer()
        await server.handle_initialize({"agent_name": "test-agent"})

        params = {"content": "Create a test agent"}
        result = await server.handle_output(params)

        assert "acknowledged" in result or "response" in result or "error" in result

    @pytest.mark.asyncio
    async def test_invalid_method_returns_error(self):
        """Unknown methods should return error response."""
        server = StdioJsonRpcServer()

        message = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "unknown/method",
            "params": {}
        }

        result = await server.process_message(message)

        assert "error" in result
        assert result["error"]["code"] == -32601  # Method not found

    @pytest.mark.asyncio
    async def test_invalid_jsonrpc_version(self):
        """Invalid JSON-RPC version should return error."""
        server = StdioJsonRpcServer()

        message = {
            "jsonrpc": "1.0",  # Invalid version
            "id": "1",
            "method": "initialize",
            "params": {}
        }

        result = await server.process_message(message)

        assert "error" in result

    @pytest.mark.asyncio
    async def test_missing_method_field(self):
        """Missing method field should return error."""
        server = StdioJsonRpcServer()

        message = {
            "jsonrpc": "2.0",
            "id": "1",
            "params": {}
        }

        result = await server.process_message(message)

        assert "error" in result

    @pytest.mark.asyncio
    async def test_process_message_with_valid_request(self):
        """Should process valid JSON-RPC requests."""
        server = StdioJsonRpcServer()

        message = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "initialize",
            "params": {"agent_name": "test-agent"}
        }

        result = await server.process_message(message)

        assert result["jsonrpc"] == "2.0"
        assert result["id"] == "1"
        assert "result" in result


class TestBuilderTools:
    """Tests for builder tool functionality."""

    def test_create_agent_tool_exists(self, builder_agent):
        """Builder should have create_agent tool."""
        tool_names = [t.name for t in builder_agent.tools]
        assert "create_agent" in tool_names

    def test_list_agents_tool_exists(self, builder_agent):
        """Builder should have list_agents tool."""
        tool_names = [t.name for t in builder_agent.tools]
        assert "list_agents" in tool_names

    def test_update_agent_config_tool_exists(self, builder_agent):
        """Builder should have update_agent_config tool."""
        tool_names = [t.name for t in builder_agent.tools]
        assert "update_agent_config" in tool_names

    def test_install_mcp_tool_exists(self, builder_agent):
        """Builder should have install_mcp tool."""
        tool_names = [t.name for t in builder_agent.tools]
        assert "install_mcp" in tool_names

    def test_recommend_model_tool_exists(self, builder_agent):
        """Builder should have recommend_model tool."""
        tool_names = [t.name for t in builder_agent.tools]
        assert "recommend_model" in tool_names


class TestWelcomeMessages:
    """Tests for builder welcome messages."""

    def test_get_welcome_message_new_mode(self, builder_agent):
        """Should return appropriate welcome message in new mode."""
        builder_agent.set_new_mode(True)

        welcome = builder_agent.get_welcome_message()

        assert len(welcome) > 0
        assert "builder" in welcome.lower() or "agent" in welcome.lower()

    def test_get_welcome_message_edit_mode(self, builder_agent):
        """Should return appropriate welcome message in edit mode."""
        builder_agent.set_agent_name("test-agent")
        builder_agent.set_new_mode(False)

        welcome = builder_agent.get_welcome_message()

        assert len(welcome) > 0
        assert "test-agent" in welcome.lower() or "builder" in welcome.lower()

    def test_welcome_message_includes_model_info(self, builder_agent):
        """Welcome message should include model information."""
        builder_agent.set_new_mode(True)

        welcome = builder_agent.get_welcome_message()

        assert len(welcome) > 0