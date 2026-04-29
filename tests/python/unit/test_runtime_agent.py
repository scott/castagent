import os
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent, BUILTIN_TOOLS
from cast.tools.bash import bash_tool
from cast.tools.read import read_tool
from cast.tools.glob import glob_tool


@pytest.fixture
def temp_agent_dir(tmp_path):
    """Create a temporary agent directory with agent.yaml and instructions.md."""
    agent_dir = tmp_path / "demo-agent"
    agent_dir.mkdir()

    agent_yaml = agent_dir / "agent.yaml"
    agent_yaml.write_text("""
name: test-agent
version: "1.0"
description: "A test agent"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow
    read: always-allow
    glob: always-allow
  principles:
    - "Be helpful and concise"

tools:
  builtin:
    - bash
    - read
    - glob
  mcp: []
  custom: []
""")

    instructions = agent_dir / "instructions.md"
    instructions.write_text("You are a helpful test agent.")

    return str(agent_dir)


@pytest.fixture
def agent_config(temp_agent_dir):
    """Create an AgentConfig from the temporary agent directory."""
    return AgentConfig.from_path(temp_agent_dir)


class TestRuntimeAgentEchoMode:
    """Tests for RuntimeAgent in echo mode (no API key)."""

    def test_init_without_api_key(self, agent_config):
        """Agent should initialize without API key and stay in echo mode."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
            assert agent.config.name == "test-agent"

    def test_echo_greeting(self, agent_config):
        """Echo mode should respond to greetings."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("hello")
            assert "test-agent" in response
            assert "How can I help you today?" in response

    def test_echo_tools(self, agent_config):
        """Echo mode should list available tools."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("what tools do you have?")
            assert "bash" in response
            assert "read" in response
            assert "glob" in response

    def test_echo_help(self, agent_config):
        """Echo mode should respond to help requests."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("help")
            assert "test-agent" in response
            assert "Run bash commands" in response

    def test_echo_default(self, agent_config):
        """Echo mode should return default response for unknown input."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("random message")
            assert "random message" in response
            assert "OPENROUTER_API_KEY" in response

    @pytest.mark.asyncio
    async def test_process_message_echo_mode(self, agent_config):
        """process_message should work in echo mode without API key."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")
            assert "test-agent" in response

    @pytest.mark.asyncio
    async def test_process_message_tools_query(self, agent_config):
        """process_message should list tools when asked."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("show me your tools")
            assert "bash" in response


class TestRuntimeAgentCard:
    """Tests for AgentCard generation."""

    def test_get_agent_card(self, agent_config):
        """get_agent_card should return valid A2A AgentCard."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            card = agent.get_agent_card()

            assert card["protocolVersion"] == "0.2.9"
            assert card["name"] == "test-agent"
            assert card["description"] == "A test agent"
            assert card["version"] == "1.0"
            assert card["capabilities"]["chatAgent"] is True
            assert len(card["skills"]) == 1
            assert card["skills"][0]["id"] == "test-agent-skill"

    def test_agent_card_capabilities(self, agent_config):
        """AgentCard should have correct capabilities."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            card = agent.get_agent_card()

            assert card["capabilities"]["streaming"] is True
            assert card["capabilities"]["pushNotifications"] is False
            assert card["capabilities"]["stateTransitionHistory"] is True


class TestBuiltinTools:
    """Tests for built-in tool registration."""

    def test_bash_tool_exists(self):
        assert "bash" in BUILTIN_TOOLS
        assert BUILTIN_TOOLS["bash"] == bash_tool

    def test_read_tool_exists(self):
        assert "read" in BUILTIN_TOOLS
        assert BUILTIN_TOOLS["read"] == read_tool

    def test_glob_tool_exists(self):
        assert "glob" in BUILTIN_TOOLS
        assert BUILTIN_TOOLS["glob"] == glob_tool


class TestRuntimeAgentLLMMode:
    """Tests for RuntimeAgent in LLM mode (with mocked API key)."""

    @patch("cast.agent.runtime.OpenRouterProvider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_init_with_api_key(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Agent should initialize LLM when API key is present."""
        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)

            assert agent.graph is not None
            mock_provider_class.assert_called_once()
            mock_provider.create_llm.assert_called_once_with(
                model="openrouter/anthropic/claude-3-7-sonnet"
            )
            mock_create_react_agent.assert_called_once()

    @patch("cast.agent.runtime.OpenRouterProvider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_tools_loaded_from_config(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Agent should load tools specified in config."""
        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)

            assert len(agent.tools) == 3
            assert bash_tool in agent.tools
            assert read_tool in agent.tools
            assert glob_tool in agent.tools

    @patch("cast.agent.runtime.OpenRouterProvider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_llm_mode(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message should invoke LLM graph when available."""
        mock_ai_message = MagicMock()
        mock_ai_message.content = "LLM response"

        mock_graph = AsyncMock()
        mock_graph.ainvoke.return_value = {"messages": [mock_ai_message]}
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")

            assert response == "LLM response"
            mock_graph.ainvoke.assert_called_once()

    @patch("cast.agent.runtime.OpenRouterProvider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_fallback_on_init_error(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Agent should fall back to echo mode if LLM init fails."""
        mock_provider_class.side_effect = Exception("Provider init failed")

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
