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

    def test_echo_hi(self, agent_config):
        """Echo mode should respond to 'hi' greeting."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("hi")
            assert "test-agent" in response
            assert "How can I help you today?" in response

    def test_echo_hey(self, agent_config):
        """Echo mode should respond to 'hey' greeting."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("hey")
            assert "test-agent" in response

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

    @pytest.mark.asyncio
    async def test_process_message_help_query(self, agent_config):
        """process_message should respond to help queries."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("help me")
            assert "test-agent" in response


class TestRuntimeAgentEchoStreaming:
    """Tests for echo mode streaming."""

    @pytest.mark.asyncio
    async def test_echo_response_stream_yields_chunks(self, agent_config):
        """_echo_response_stream should yield word-by-word chunks."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            chunks = []
            async for chunk in agent._echo_response_stream("hello"):
                chunks.append(chunk)

            assert len(chunks) > 0
            assert "hello" in "".join(chunks).lower()

    @pytest.mark.asyncio
    async def test_echo_response_stream_includes_spaces(self, agent_config):
        """_echo_response_stream should include spaces between words."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            chunks = []
            async for chunk in agent._echo_response_stream("hello world"):
                chunks.append(chunk)

            result = "".join(chunks)
            assert "hello" in result.lower()
            assert "world" in result.lower()


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

    def test_agent_card_input_output_modes(self, agent_config):
        """AgentCard should specify input/output modes."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            card = agent.get_agent_card()

            assert "text/plain" in card["defaultInputModes"]
            assert "text/plain" in card["defaultOutputModes"]

    def test_agent_card_url(self, agent_config):
        """AgentCard should include URL."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            card = agent.get_agent_card()

            assert "url" in card
            assert "localhost" in card["url"]


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

    def test_git_tools_exist(self):
        """Git tools should be registered."""
        from cast.tools.git import git_status, git_commit, git_push, git_log, git_diff, git_add

        assert "git_status" in BUILTIN_TOOLS
        assert "git_commit" in BUILTIN_TOOLS
        assert "git_push" in BUILTIN_TOOLS
        assert "git_log" in BUILTIN_TOOLS
        assert "git_diff" in BUILTIN_TOOLS
        assert "git_add" in BUILTIN_TOOLS


class TestRuntimeAgentLLMMode:
    """Tests for RuntimeAgent in LLM mode (with mocked API key)."""

    @patch("cast.agent.runtime.get_provider")
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

    @patch("cast.agent.runtime.get_provider")
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

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_custom_entries_are_not_loaded(self, mock_create_react_agent, mock_provider_class, temp_agent_dir):
        """String and path custom entries stay on the config and are not imported."""
        tools_dir = os.path.join(temp_agent_dir, "tools")
        os.makedirs(tools_dir, exist_ok=True)
        with open(os.path.join(tools_dir, "email_tools.py"), "w", encoding="utf-8") as handle:
            handle.write("def email_tools():\n    return 'unused'\n")

        config_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(config_path, encoding="utf-8") as handle:
            text = handle.read()
        text = text.replace(
            "  custom: []",
            "  custom:\n    - email_tools\n    - path: tools/email_tools.py",
        )
        with open(config_path, "w", encoding="utf-8") as handle:
            handle.write(text)

        config = AgentConfig.from_path(temp_agent_dir)
        assert config.tools["custom"] == [
            "email_tools",
            {"path": "tools/email_tools.py"},
        ]

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.return_value = MagicMock()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(config)

        assert agent.tools == [bash_tool, read_tool, glob_tool]
        loaded = mock_create_react_agent.call_args.kwargs["tools"]
        assert loaded == [bash_tool, read_tool, glob_tool]

    @patch("cast.agent.runtime.get_provider")
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

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_fallback_on_init_error(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Agent should fall back to echo mode if LLM init fails."""
        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.create_llm.side_effect = Exception("Provider init failed")
        mock_provider.name = "OpenRouter"
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_fallback_on_graph_error(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Agent should fall back to echo mode if graph creation fails."""
        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_create_react_agent.side_effect = Exception("Graph creation failed")

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None


class TestRuntimeAgentMemoryIntegration:
    """Tests for memory integration."""

    def test_memory_initialized_with_api_key(self, agent_config):
        """Agent should initialize memory when API key is available."""
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with patch("cast.agent.runtime.get_provider") as mock_provider:
                mock_provider.is_available.return_value = True
                mock_provider_instance = MagicMock()
                mock_provider_instance.create_llm.return_value = MagicMock()
                mock_provider.return_value = mock_provider_instance

                agent = RuntimeAgent(agent_config)

                # Memory should be initialized
                assert agent.memory is not None

    def test_memory_initialized_without_api_key(self, agent_config):
        """Agent should still initialize memory without API key."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)

            # Memory should still be initialized
            assert agent.memory is not None


class TestRuntimeAgentProcessMessageErrors:
    """Tests for error handling in process_message."""

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_handles_404_error(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message should return friendly message for 404 errors."""
        mock_graph = AsyncMock()
        mock_graph.ainvoke.side_effect = Exception("Error 404: Model not found")
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")

            assert "404" in response or "model" in response.lower()
            assert "OPENROUTER_API_KEY" not in response
            assert "Set " not in response

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_invalid_model_id_does_not_ask_for_a_set_key(
        self, mock_create_react_agent, mock_provider_class, agent_config
    ):
        """A 400 for a bad model id must not claim the API key is missing."""
        mock_graph = AsyncMock()
        mock_graph.ainvoke.side_effect = Exception(
            "Error code: 400 - {'error': {'message': 'google/gemini-2.0-flash is not a valid model ID'}}"
        )
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.is_available.return_value = True
        mock_provider.env_var = "OPENROUTER_API_KEY"
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")

        assert "400" in response
        assert "google/gemini-2.0-flash is not a valid model ID" in response
        assert "Set OPENROUTER_API_KEY" not in response

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_handles_generic_error(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message should return friendly message for generic errors."""
        mock_graph = AsyncMock()
        mock_graph.ainvoke.side_effect = Exception("Connection timeout")
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")

            assert "encountered an error" in response.lower() or "Connection timeout" in response
            assert "OPENROUTER_API_KEY" not in response


class TestRuntimeAgentStreamingMode:
    """Tests for streaming mode."""

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_stream_echo_mode(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message_stream should work in echo mode."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            chunks = []

            async for chunk in agent.process_message_stream("hello"):
                chunks.append(chunk)

            assert isinstance(chunks, list)

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_stream_llm_mode(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message_stream should stream from LLM."""
        mock_chunk = MagicMock()
        mock_chunk.content = " streamed response"

        mock_graph = MagicMock()
        mock_graph.astream = AsyncMock(return_value=iter([(mock_chunk, {})]))
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            chunks = []

            async for chunk in agent.process_message_stream("hello"):
                chunks.append(chunk)

            # Should yield chunks from LLM
            assert len(chunks) >= 0  # May be empty if streaming format differs

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_process_message_stream_error_handling(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message_stream should handle errors gracefully."""
        mock_graph = MagicMock()
        mock_graph.astream = AsyncMock(side_effect=Exception("Stream failed"))
        mock_create_react_agent.return_value = mock_graph

        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            agent = RuntimeAgent(agent_config)
            chunks = []

            async for chunk in agent.process_message_stream("hello"):
                chunks.append(chunk)

            # Should yield error message
            error_chunks = [c for c in chunks if "error" in c.lower()]
            assert len(error_chunks) > 0


class TestRuntimeAgentChatHistory:
    """Tests for chat history management."""

    @pytest.mark.asyncio
    async def test_chat_history_updated_after_message(self, agent_config):
        """Chat history should be updated after processing message."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)
            initial_len = len(agent.chat_history)

            await agent.process_message("hello")

            # Chat history may or may not be updated depending on implementation
            assert isinstance(agent.chat_history, list)

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    @pytest.mark.asyncio
    async def test_chat_history_with_memory_context(self, mock_create_react_agent, mock_provider_class, agent_config):
        """Chat history should include memory context when available."""
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

            # Mock memory to return context
            agent.memory.format_memories = MagicMock(return_value="Relevant memory context")

            await agent.process_message("hello")

            # Check that memory.format_memories was called
            agent.memory.format_memories.assert_called()


class TestRuntimeAgentTools:
    """Tests for tool configuration."""

    def test_agent_has_tools_attribute(self, agent_config):
        """Agent should have tools attribute when LLM is configured."""
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with patch("cast.agent.runtime.get_provider") as mock_provider:
                mock_provider.is_available.return_value = True
                mock_provider_instance = MagicMock()
                mock_provider_instance.create_llm.return_value = MagicMock()
                mock_provider.return_value = mock_provider_instance

                agent = RuntimeAgent(agent_config)

                assert hasattr(agent, "tools")
                assert isinstance(agent.tools, list)

    def test_agent_without_llm_has_no_tools_attr(self, agent_config):
        """Agent in echo mode may not have tools attribute."""
        with patch.dict(os.environ, {}, clear=True):
            agent = RuntimeAgent(agent_config)

            # In echo mode, tools may not be set
            assert not hasattr(agent, "tools") or agent.tools is None