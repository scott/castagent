import os
import tempfile
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

_ISOLATED_HOME = tempfile.mkdtemp(prefix="cast-pytest-home-")


def _env(extra=None):
    env = {"HOME": _ISOLATED_HOME, "PATH": os.environ.get("PATH", "")}
    if extra:
        env.update(extra)
    return env

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
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
            assert agent.config.name == "test-agent"
    
    def test_echo_greeting(self, agent_config):
        """Echo mode should respond to greetings."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("hello")
            assert "test-agent" in response
            assert "How can I help you today?" in response
    
    def test_echo_tools(self, agent_config):
        """Echo mode should list available tools."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("what tools do you have?")
            assert "bash" in response
            assert "read" in response
            assert "glob" in response
    
    def test_echo_help(self, agent_config):
        """Echo mode should respond to help requests."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("help")
            assert "test-agent" in response
            assert "Run bash commands" in response
    
    def test_echo_default(self, agent_config):
        """Echo mode should return default response for unknown input."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            response = agent._echo_response("random message")
            assert "random message" in response
            assert "OPENROUTER_API_KEY" in response
    
    @pytest.mark.asyncio
    async def test_process_message_echo_mode(self, agent_config):
        """process_message should work in echo mode without API key."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            response = await agent.process_message("hello")
            assert "test-agent" in response


class TestRuntimeAgentLLMMode:
    """Tests for RuntimeAgent in LLM mode (with API key)."""
    
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
    @pytest.mark.asyncio
    async def test_process_message_llm_mode(self, mock_create_react_agent, mock_provider_class, agent_config):
        """process_message should invoke LLM graph when available."""
        # Setup mock LLM response
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


class TestRuntimeAgentProviderSelection:
    """Model prefix selects the provider. Keys do not fall back."""

    def _set_model(self, agent_config, model: str) -> None:
        brain = agent_config.config.setdefault("brain", {})
        brain["model"] = model

    @patch("cast.agent.runtime.create_react_agent")
    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    @patch("cast.providers.openrouter.OpenRouterProvider")
    def test_digitalocean_model_never_constructs_openrouter(
        self, mock_openrouter, mock_chat, mock_graph, agent_config
    ):
        """A digitalocean/ model does not construct OpenRouterProvider."""
        self._set_model(agent_config, "digitalocean/llama3.3-70b-instruct")
        mock_graph.return_value = MagicMock()

        with patch.dict(os.environ, {
            "OPENROUTER_API_KEY": "or-key",
            "DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key",
        }):
            agent = RuntimeAgent(agent_config)

        assert mock_openrouter.called is False
        assert mock_openrouter.is_available.called is False
        assert agent.graph is not None
        assert mock_chat.call_args.kwargs["model"] == "llama3.3-70b-instruct"
        assert mock_chat.call_args.kwargs["base_url"] == "https://inference.do-ai.run/v1"
        assert mock_chat.call_args.kwargs["api_key"] == "do-key"

    @patch("cast.agent.runtime.get_provider")
    @patch("cast.agent.runtime.create_react_agent")
    def test_openrouter_model_does_not_require_digitalocean_key(
        self, mock_graph, mock_provider_class, agent_config
    ):
        mock_provider = MagicMock()
        mock_provider.create_llm.return_value = MagicMock()
        mock_provider_class.return_value = mock_provider
        mock_graph.return_value = MagicMock()

        with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "test-key"}), clear=True):
            agent = RuntimeAgent(agent_config)

        assert agent.graph is not None
        mock_provider_class.assert_called_once()

    def test_neither_key_stays_in_echo_mode(self, agent_config):
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
            response = agent._echo_response("random message")
            assert "OPENROUTER_API_KEY" in response

    @patch("cast.agent.runtime.create_react_agent")
    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_only_digitalocean_key_uses_digitalocean_not_echo(
        self, mock_chat, mock_graph, agent_config
    ):
        self._set_model(agent_config, "digitalocean/llama3.3-70b-instruct")
        mock_graph.return_value = MagicMock()

        with patch.dict(os.environ, _env({"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}), clear=True):
            agent = RuntimeAgent(agent_config)

        assert agent.graph is not None
        assert mock_chat.call_args.kwargs["model"] == "llama3.3-70b-instruct"

    @patch("cast.agent.runtime.create_react_agent")
    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_unlisted_openrouter_vendors_start(self, mock_chat, mock_graph, agent_config):
        """qwen/ and z-ai/ stay on OpenRouter and the process starts."""
        mock_graph.return_value = MagicMock()
        for model in ("qwen/qwen3-coder", "z-ai/glm-4.6"):
            mock_chat.reset_mock()
            self._set_model(agent_config, model)
            with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
                agent = RuntimeAgent(agent_config)
            assert agent.graph is not None, model
            assert agent._provider.key == "openrouter"
            assert mock_chat.call_args.kwargs["model"] == model
            assert mock_chat.call_args.kwargs["api_key"] == "or-key"

    def test_reserved_prefix_falls_back_to_echo(self, agent_config):
        self._set_model(agent_config, "openai-api/gpt-4o")
        with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
            agent = RuntimeAgent(agent_config)
        assert agent.graph is None
        assert agent._provider is None

    def test_xai_without_its_key_stays_in_echo(self, agent_config):
        self._set_model(agent_config, "xai/grok-4.7")
        with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
            assert agent._provider is not None
            assert agent._provider.key == "xai"
            response = agent._echo_response("hello")
            assert "XAI_API_KEY" in response
            assert "OPENROUTER_API_KEY" not in response

    @patch("cast.agent.runtime.create_react_agent")
    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_xai_key_starts_without_sending_builder_temperature(
        self, mock_chat, mock_graph, agent_config
    ):
        self._set_model(agent_config, "xai/grok-4.7")
        mock_graph.return_value = MagicMock()
        with patch.dict(os.environ, _env({
            "XAI_API_KEY": "xai-key",
            "OPENROUTER_API_KEY": "or-key",
        }), clear=True):
            agent = RuntimeAgent(agent_config)
        assert agent.graph is not None
        assert mock_chat.call_args.kwargs["model"] == "grok-4.7"
        assert mock_chat.call_args.kwargs["api_key"] == "xai-key"
        assert mock_chat.call_args.kwargs["base_url"] == "https://api.x.ai/v1"
        assert "temperature" not in mock_chat.call_args.kwargs

    def test_reflection_catches_a_reserved_prefix(self):
        from cast.memory.reflection import ReflectionAgent

        agent = ReflectionAgent("openai-api/gpt-4o")
        assert agent.llm is None

    def test_digitalocean_model_does_not_fall_back_to_openrouter(self, agent_config):
        self._set_model(agent_config, "digitalocean/llama3.3-70b-instruct")
        with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
            agent = RuntimeAgent(agent_config)
            assert agent.graph is None
            response = agent._echo_response("random message")
            assert "DIGITALOCEAN_MODEL_ACCESS_KEY" in response
            assert "OPENROUTER_API_KEY" not in response


class TestRuntimeAgentCard:
    """Tests for AgentCard generation."""
    
    def test_get_agent_card(self, agent_config):
        """get_agent_card should return valid A2A AgentCard."""
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(agent_config)
            card = agent.get_agent_card()
            
            assert card["protocolVersion"] == "0.2.9"
            assert card["name"] == "test-agent"
            assert card["description"] == "A test agent"
            assert card["version"] == "1.0"
            assert card["capabilities"]["chatAgent"] is True
            assert len(card["skills"]) == 1


class TestBuiltinTools:
    """Tests for built-in tool registration."""
    
    def test_bash_tool_exists(self):
        assert "bash" in BUILTIN_TOOLS
    
    def test_read_tool_exists(self):
        assert "read" in BUILTIN_TOOLS
    
    def test_glob_tool_exists(self):
        assert "glob" in BUILTIN_TOOLS
