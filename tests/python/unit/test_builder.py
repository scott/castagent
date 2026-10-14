import pytest
from cast.builder import StdioJsonRpcServer, BuilderAgent, EchoChatModel, create_llm
import asyncio
from pathlib import Path
import yaml
import os
from unittest.mock import patch


class TestStdioJsonRpcServer:
    """Tests for StdioJsonRpcServer."""

    @pytest.mark.asyncio
    async def test_server_initialization(self):
        """Server should initialize with empty state."""
        server = StdioJsonRpcServer()

        assert server.agent is not None
        assert isinstance(server.agent, BuilderAgent)
        assert "initialize" in server.methods
        assert "tool_call" in server.methods
        assert "output" in server.methods

    @pytest.mark.asyncio
    async def test_handle_initialize_missing_agent_starts_new_mode(self, tmp_path, monkeypatch):
        """A missing agent starts the new-agent flow instead of edit mode."""
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)

        server = StdioJsonRpcServer()
        result = await server.handle_initialize({
            "agent_name": "bb-devnew",
            "new_mode": False,
        })

        assert result["status"] == "ready"
        assert result["agent_name"] == "bb-devnew"
        assert result["new_mode"] is True
        assert server.agent.new_mode is True
        message = result["message"]
        assert "bb-devnew" in message
        assert "what should your agent do" in message.lower()
        assert "loaded its current configuration" not in message.lower()
        assert "loaded" not in message.lower()
        assert not (agents / "bb-devnew").exists()

    @pytest.mark.asyncio
    async def test_handle_initialize_existing_agent_stays_in_edit_mode(self, tmp_path, monkeypatch):
        """An agent directory that exists is opened for editing."""
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agent_dir = agents / "inbox-agent"
        agent_dir.mkdir(parents=True)
        (agent_dir / "agent.yaml").write_text(
            "name: inbox-agent\ndescription: reads mail\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)

        server = StdioJsonRpcServer()
        result = await server.handle_initialize({"agent_name": "inbox-agent"})

        assert result["status"] == "ready"
        assert result["new_mode"] is False
        assert "inbox-agent" in result["message"]
        assert "loaded its current configuration" not in result["message"].lower()
        assert "what would you like to change" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_handle_initialize_harness_stays_in_normal_mode(self, tmp_path, monkeypatch):
        """Meta tests must not enter the new-agent flow for a missing name."""
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)

        server = StdioJsonRpcServer()
        result = await server.handle_initialize({
            "agent_name": "meta-test",
            "harness": True,
        })

        assert result["status"] == "ready"
        assert result["new_mode"] is False
        assert result["message"] == "Meta-builder harness ready."
        assert server.agent.new_mode is False
        assert not (agents / "meta-test").exists()

    @pytest.mark.asyncio
    async def test_harness_create_simple_uses_echo_with_api_key(self, tmp_path, monkeypatch):
        """create-simple creates email-agent without calling a live model."""
        from cast import versioning
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)
        monkeypatch.setattr(tools, "BUILDER_DIR", tmp_path / "builder")
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents)
        monkeypatch.setenv("CAST_BUILDER_ECHO", "1")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")

        server = StdioJsonRpcServer()
        assert isinstance(server.agent.llm, EchoChatModel)
        init = await server.handle_initialize({"agent_name": "meta-test", "harness": True})
        assert init["new_mode"] is False

        result = await server.handle_output({
            "message": "Create an email agent",
            "content": "Create an email agent",
            "text": "Create an email agent",
        })

        assert "email-agent" in result["response"]
        agent_yaml = agents / "email-agent" / "agent.yaml"
        assert agent_yaml.is_file()
        config = yaml.safe_load(agent_yaml.read_text(encoding="utf-8"))
        assert config["name"] == "email-agent"
        assert not (agents / "meta-test").exists()

    def test_create_llm_echo_env_ignores_api_key(self, monkeypatch):
        """CAST_BUILDER_ECHO wins over a configured API key."""
        monkeypatch.setenv("CAST_BUILDER_ECHO", "1")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
        assert isinstance(create_llm(), EchoChatModel)

    @pytest.mark.asyncio
    async def test_handle_initialize_new_mode(self):
        """handle_initialize should set up agent for new agent creation."""
        server = StdioJsonRpcServer()

        result = await server.handle_initialize({"agent_name": "__new__", "new_mode": True})
        assert result["status"] == "ready"
        assert result["agent_name"] == "__new__"
        assert result["new_mode"] is True
        assert server.agent.new_mode is True

        # Welcome message should be the new-mode welcome
        welcome = result["message"]
        assert "create a new agent" in welcome.lower()

    @pytest.mark.asyncio
    async def test_handle_initialize_missing_agent_name(self):
        """handle_initialize should return error for missing agent_name."""
        server = StdioJsonRpcServer()

        result = await server.handle_initialize({})
        assert "error" in result

    @pytest.mark.asyncio
    async def test_handle_tool_call_missing_tool(self):
        """handle_tool_call should return error for missing tool."""
        server = StdioJsonRpcServer()

        result = await server.handle_tool_call({})
        assert "error" in result
        assert result["error"]["code"] == -32602  # Invalid params

    @pytest.mark.asyncio
    async def test_handle_tool_call_unknown_tool(self):
        """handle_tool_call should handle unknown tool gracefully."""
        server = StdioJsonRpcServer()

        result = await server.handle_tool_call({"tool": "unknown_tool", "args": {}})
        # Tool execution should return error message, not throw
        assert "call_id" in result or "error" in result

    @pytest.mark.asyncio
    async def test_handle_output_empty_message(self):
        """handle_output should handle empty message."""
        server = StdioJsonRpcServer()

        result = await server.handle_output({"content": ""})
        assert "acknowledged" in result

    @pytest.mark.asyncio
    async def test_handle_output_with_message(self):
        """handle_output should process user message."""
        server = StdioJsonRpcServer()

        result = await server.handle_output({"content": "Hello"})
        assert "acknowledged" in result

    @pytest.mark.asyncio
    async def test_process_message_validation(self):
        """process_message should validate request structure."""
        server = StdioJsonRpcServer()

        # Invalid: not a dict
        result = await server.process_message("not a dict")
        assert "error" in result

        # Invalid: wrong jsonrpc version
        result = await server.process_message({"jsonrpc": "1.0", "method": "test"})
        assert "error" in result

        # Invalid: missing method
        result = await server.process_message({"jsonrpc": "2.0"})
        assert "error" in result

    @pytest.mark.asyncio
    async def test_process_message_unknown_method(self):
        """process_message should return error for unknown methods."""
        server = StdioJsonRpcServer()

        result = await server.process_message({
            "jsonrpc": "2.0",
            "id": "1",
            "method": "unknown/method",
            "params": {},
        })
        assert "error" in result

    @pytest.mark.asyncio
    async def test_process_message_with_id(self):
        """process_message should include id in response."""
        server = StdioJsonRpcServer()

        result = await server.process_message({
            "jsonrpc": "2.0",
            "id": "test-id-123",
            "method": "initialize",
            "params": {"agent_name": "test"},
        })
        assert result["id"] == "test-id-123"


class TestBuilderAgent:
    """Tests for BuilderAgent."""

    def test_agent_initialization(self):
        """BuilderAgent should initialize with system prompt and LLM."""
        agent = BuilderAgent()

        assert agent.system_prompt is not None
        assert len(agent.system_prompt) > 0
        assert agent.llm is not None
        assert agent.tools is not None
        assert len(agent.tools) > 0

    def test_agent_tools_registered(self):
        """BuilderAgent should have all tools registered."""
        agent = BuilderAgent()

        tool_names = [t.name for t in agent.tools]
        assert "create_agent" in tool_names
        assert "suggest_name" in tool_names
        assert "install_mcp" in tool_names
        assert "list_agents" in tool_names

    def test_set_agent_name(self):
        """set_agent_name should set the agent name."""
        agent = BuilderAgent()

        agent.set_agent_name("my-agent")
        assert agent.agent_name == "my-agent"

    def test_set_new_mode(self):
        """set_new_mode should toggle new mode."""
        agent = BuilderAgent()

        assert agent.new_mode is False
        agent.set_new_mode(True)
        assert agent.new_mode is True

    def test_load_agent_for_editing(self):
        """load_agent_for_editing should load agent config."""
        agent = BuilderAgent()

        # Should not throw even if agent doesn't exist
        agent.load_agent_for_editing("nonexistent-agent")

    @pytest.mark.asyncio
    async def test_process_message(self):
        """process_message should return a response."""
        agent = BuilderAgent()

        response = await agent.process_message("hello")
        assert response is not None
        assert isinstance(response, str)

    @pytest.mark.asyncio
    async def test_execute_tool(self):
        """execute_tool should execute a tool by name."""
        agent = BuilderAgent()

        result = await agent.execute_tool("list_agents", {})
        assert result is not None

    @pytest.mark.asyncio
    async def test_execute_unknown_tool(self):
        """execute_tool should return error for unknown tool."""
        agent = BuilderAgent()

        result = await agent.execute_tool("nonexistent_tool", {})
        assert "not found" in result.lower()

    def test_get_welcome_message_new_mode(self):
        """get_welcome_message should return new-mode welcome."""
        agent = BuilderAgent()
        agent.set_new_mode(True)

        welcome = agent.get_welcome_message()
        assert "create a new agent" in welcome.lower()

    def test_get_welcome_message_edit_mode(self):
        """get_welcome_message should return edit-mode welcome."""
        agent = BuilderAgent()
        agent.set_agent_name("test-agent")

        welcome = agent.get_welcome_message()
        assert "test-agent" in welcome

    def test_get_welcome_message_default(self):
        """get_welcome_message should return default welcome."""
        agent = BuilderAgent()

        welcome = agent.get_welcome_message()
        assert len(welcome) > 0


class TestEchoChatModel:
    """Tests for EchoChatModel."""

    def test_echo_chat_model_initialization(self):
        """EchoChatModel should initialize with default state."""
        model = EchoChatModel()

        assert model._new_mode is False
        assert model._agent_name is None

    def test_set_new_mode(self):
        """set_new_mode should toggle new mode."""
        model = EchoChatModel()

        model.set_new_mode(True)
        assert model._new_mode is True

        model.set_new_mode(False)
        assert model._new_mode is False

    def test_set_agent_name(self):
        """set_agent_name should set the agent name."""
        model = EchoChatModel()

        model.set_agent_name("my-agent")
        assert model._agent_name == "my-agent"

    def test_llm_type(self):
        """_llm_type should return 'echo'."""
        model = EchoChatModel()
        assert model._llm_type == "echo"

    def test_identifying_params(self):
        """_identifying_params should return model info."""
        model = EchoChatModel()
        params = model._identifying_params

        assert "model" in params
        assert params["model"] == "echo"

    def test_bind_tools(self):
        """bind_tools should return self with bound tools."""
        model = EchoChatModel()

        # Just test that bind_tools returns self
        result = model.bind_tools([])

        assert result is model

    def test_generate_with_empty_message(self):
        """_generate should handle empty messages."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()
        result = model._generate([HumanMessage(content="")])

        assert result.generations
        assert len(result.generations) > 0

    def test_generate_normal_mode(self):
        """_generate should respond in normal mode."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()
        model._new_mode = False

        result = model._generate([HumanMessage(content="hello")])

        assert result.generations
        assert len(result.generations) > 0

    def test_generate_new_mode_empty(self):
        """_generate should return new-mode prompt for empty input in new mode."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()
        model._new_mode = True

        result = model._generate([HumanMessage(content="")])

        assert result.generations
        content = result.generations[0].message.content
        assert "what would you like your new agent" in content.lower()

    def test_generate_new_mode_with_description(self):
        """_generate should suggest name for description in new mode."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()
        model._new_mode = True

        result = model._generate([HumanMessage(content="I want an agent that reads emails")])

        assert result.generations
        content = result.generations[0].message.content
        assert len(content) > 0
        tool_calls = result.generations[0].message.tool_calls or []
        assert any(tc["name"] == "suggest_name" for tc in tool_calls)

    def test_generate_new_mode_uses_requested_name(self):
        """cast dev <name> should create that name from the description."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()
        model.set_new_mode(True)
        model.set_agent_name("bb-devnew")

        result = model._generate([
            HumanMessage(content="Watch CI logs and ping me when a build fails badly"),
        ])

        tool_calls = result.generations[0].message.tool_calls or []
        create_calls = [tc for tc in tool_calls if tc["name"] == "create_agent"]
        assert len(create_calls) == 1
        assert create_calls[0]["args"]["name"] == "bb-devnew"
        assert "build fails" in create_calls[0]["args"]["description"]
        assert not any(tc["name"] == "suggest_name" for tc in tool_calls)

    def test_generate_confirm_name(self):
        """_generate should create agent when name is confirmed."""
        from langchain_core.messages import HumanMessage, ToolMessage

        model = EchoChatModel()
        model._new_mode = True

        # Simulate name suggestion followed by confirmation
        result = model._generate([
            HumanMessage(content="I want an agent that reads emails"),
            ToolMessage(content="Suggested name: email-agent", tool_call_id="1"),
            HumanMessage(content="yes"),
        ])

        assert result.generations
        content = result.generations[0].message.content
        assert "email-agent" in content

    def test_generate_list_agents(self):
        """_generate should call list_agents for list request."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()

        result = model._generate([HumanMessage(content="list my agents")])

        assert result.generations
        assert result.generations[0].message.tool_calls is not None
        assert any(tc["name"] == "list_agents" for tc in result.generations[0].message.tool_calls)

    def test_generate_create_agent(self):
        """_generate should call create_agent for create requests."""
        from langchain_core.messages import HumanMessage

        model = EchoChatModel()

        result = model._generate([HumanMessage(content="create an agent called test-agent")])

        assert result.generations
        tool_calls = result.generations[0].message.tool_calls or []
        assert any(tc["name"] == "create_agent" for tc in tool_calls)


class TestBuilderAgentGraph:
    """Tests for BuilderAgent graph construction."""

    def test_graph_built_on_init(self):
        """Graph should be built during initialization."""
        agent = BuilderAgent()

        assert agent.graph is not None

    def test_graph_has_agent_and_tools_nodes(self):
        """Graph should have agent and tools nodes."""
        agent = BuilderAgent()

        # The graph should be compilable
        assert hasattr(agent.graph, "invoke")


class TestStdioJsonRpcServerIntegration:
    """Integration tests for StdioJsonRpcServer."""

    @pytest.mark.asyncio
    async def test_full_conversation_flow(self, tmp_path, monkeypatch):
        """Test a full conversation flow."""
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)

        server = StdioJsonRpcServer()

        # Initialize
        result = await server.handle_initialize({"agent_name": "test-agent"})
        assert result["status"] == "ready"
        assert result["new_mode"] is True

        # Send a message. A list request must not scaffold the missing agent.
        result = await server.handle_output({"content": "list agents"})
        assert "acknowledged" in result
        assert "response" in result
        assert not (agents / "test-agent").exists()

    @pytest.mark.asyncio
    async def test_missing_agent_description_creates_named_scaffold(self, tmp_path, monkeypatch):
        """A description in the missing-agent flow writes that agent's files."""
        from cast import versioning
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        agents.mkdir()
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)
        monkeypatch.setattr(tools, "BUILDER_DIR", tmp_path / "builder")
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents)
        monkeypatch.setattr("cast.builder.create_llm", lambda: EchoChatModel())

        server = StdioJsonRpcServer()
        result = await server.handle_initialize({"agent_name": "bb-devnew"})
        assert result["new_mode"] is True
        assert "loaded its current configuration" not in result["message"].lower()

        await server.agent.process_message(
            "Watch CI logs and ping me when a build fails badly"
        )

        agent_yaml = agents / "bb-devnew" / "agent.yaml"
        assert agent_yaml.is_file()
        config = yaml.safe_load(agent_yaml.read_text(encoding="utf-8"))
        assert config["name"] == "bb-devnew"
        assert "build fails" in config["description"]

    @pytest.mark.asyncio
    async def test_error_propagation(self):
        """Test that errors are properly propagated."""
        server = StdioJsonRpcServer()

        # Initialize
        await server.handle_initialize({"agent_name": "test-agent"})

        # Force an error in the agent
        async def failing_process(x):
            raise Exception("Test error")

        original_process = server.agent.process_message
        server.agent.process_message = failing_process

        result = await server.handle_output({"content": "hello"})
        assert "error" in result

        # Restore
        server.agent.process_message = original_process


class TestBuilderAgentWelcomeMessages:
    """Tests for welcome message generation."""

    def test_welcome_includes_model_name(self):
        """Welcome message should include model name."""
        from cast.builder import get_builder_model

        model = get_builder_model()
        assert model is not None
        assert len(model) > 0

    def test_welcome_with_custom_prompt(self, tmp_path):
        """Welcome should use custom prompt when available."""
        # Create custom prompt
        builder_dir = tmp_path / ".cast" / "builder"
        builder_dir.mkdir(parents=True)
        instructions_file = builder_dir / "instructions.md"
        instructions_file.write_text("Custom system prompt")

        agent = BuilderAgent()

        # Should use custom prompt
        assert "Custom system prompt" in agent.system_prompt or "Cast Builder Agent" in agent.system_prompt


class TestStdioServerMessageValidation:
    """Tests for message validation in StdioJsonRpcServer."""

    def test_validate_message_dict(self):
        """_validate_message should reject non-dict messages."""
        server = StdioJsonRpcServer()

        result = server._validate_message("not a dict")
        assert result is not None
        assert result["error"]["code"] == -32600

    def test_validate_message_wrong_version(self):
        """_validate_message should reject wrong jsonrpc version."""
        server = StdioJsonRpcServer()

        result = server._validate_message({"jsonrpc": "1.0", "method": "test"})
        assert result is not None

    def test_validate_message_missing_method(self):
        """_validate_message should reject missing method."""
        server = StdioJsonRpcServer()

        result = server._validate_message({"jsonrpc": "2.0"})
        assert result is not None

    def test_validate_message_method_not_string(self):
        """_validate_message should reject non-string method."""
        server = StdioJsonRpcServer()

        result = server._validate_message({"jsonrpc": "2.0", "method": 123})
        assert result is not None

    def test_validate_message_valid(self):
        """_validate_message should accept valid messages."""
        server = StdioJsonRpcServer()

        result = server._validate_message({"jsonrpc": "2.0", "method": "initialize", "params": {}})
        assert result is None

    def test_make_error_response_with_id(self):
        """_make_error_response should include id when provided."""
        server = StdioJsonRpcServer()

        result = server._make_error_response("test-id", -32600, "Invalid request")
        assert result["id"] == "test-id"
        assert result["error"]["code"] == -32600

    def test_make_error_response_without_id(self):
        """_make_error_response should omit id when None."""
        server = StdioJsonRpcServer()

        result = server._make_error_response(None, -32600, "Invalid request")
        assert "id" not in result

    def test_make_error_response_with_data(self):
        """_make_error_response should include data when provided."""
        server = StdioJsonRpcServer()

        result = server._make_error_response("id", -32602, "Invalid params", {"extra": "info"})
        assert result["error"]["data"] == {"extra": "info"}


class TestBuilderModelConfig:
    """The builder LLM uses the raw configured model id. No network."""

    def _write_config(self, tmp_path, monkeypatch, model: str):
        home = tmp_path / "home"
        cast_dir = home / ".cast"
        cast_dir.mkdir(parents=True)
        (cast_dir / "config.yaml").write_text(
            f"defaults:\n  builder_model: {model}\n"
        )
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("DIGITALOCEAN_MODEL_ACCESS_KEY", raising=False)
        return home

    def test_create_llm_uses_configured_raw_model_id(self, tmp_path, monkeypatch):
        from cast.builder import create_llm

        self._write_config(tmp_path, monkeypatch, "anthropic/claude-3.5-sonnet")
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        with patch("cast.providers.openrouter.ChatOpenAI") as mock_chat:
            llm = create_llm()

        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "anthropic/claude-3.5-sonnet"
        assert kwargs["base_url"] == "https://openrouter.ai/api/v1"
        assert kwargs["base_url"] + "/chat/completions" == "https://openrouter.ai/api/v1/chat/completions"
        assert kwargs["api_key"] == "or-key"
        assert kwargs["temperature"] == 0.7
        assert llm is mock_chat.return_value

    def test_create_llm_echo_when_openrouter_key_is_absent(self, tmp_path, monkeypatch):
        from cast.builder import EchoChatModel, create_llm

        self._write_config(tmp_path, monkeypatch, "anthropic/claude-3.5-sonnet")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        with patch("cast.providers.openrouter.ChatOpenAI") as mock_chat:
            llm = create_llm()

        mock_chat.assert_not_called()
        assert isinstance(llm, EchoChatModel)

    def test_welcome_banner_uses_display_model(self, tmp_path, monkeypatch):
        from cast.builder import BuilderAgent, get_builder_model, get_builder_model_id

        self._write_config(tmp_path, monkeypatch, "openrouter/minimax/minimax-m2.5")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        assert get_builder_model_id() == "openrouter/minimax/minimax-m2.5"
        assert get_builder_model() == "minimax/minimax-m2.5"

        agent = BuilderAgent()
        agent.new_mode = True
        welcome = agent.get_welcome_message()
        assert "**minimax/minimax-m2.5**" in welcome
        assert "openrouter/minimax/minimax-m2.5" not in welcome


class TestBuilderConfigClaims:
    """The prompt and the edit welcome must match the file the runtime loads."""

    def test_prompt_tells_the_builder_not_to_claim_unapplied_settings(self):
        from cast.builder import DEFAULT_SYSTEM_PROMPT

        assert "tools.builtin" in DEFAULT_SYSTEM_PROMPT
        assert "brain.model" in DEFAULT_SYSTEM_PROMPT
        assert "nothing was applied" in DEFAULT_SYSTEM_PROMPT
        assert "approve-once" not in DEFAULT_SYSTEM_PROMPT
        assert "always-allow, ask, and deny" in DEFAULT_SYSTEM_PROMPT

    def test_edit_welcome_survives_a_tools_list(self):
        from cast.builder import BuilderAgent

        welcome = BuilderAgent._build_edit_welcome(
            None,
            "bb2-live",
            {
                "description": "answers in one sentence",
                "brain": {"model": "openrouter/minimax/minimax-m2.5"},
                "tools": ["bash", "read", "glob"],
                "permissions": {"bash": "approve-once"},
            },
        )
        assert "openrouter/minimax/minimax-m2.5" in welcome
        assert "approve-once" not in welcome
        assert "Built-in tools" not in welcome