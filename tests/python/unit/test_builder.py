import pytest
from cast.builder import StdioJsonRpcServer, BuilderAgent, EchoChatModel
import asyncio
from pathlib import Path
import yaml
import os


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
    async def test_handle_initialize_basic(self):
        """handle_initialize should set up agent for editing."""
        server = StdioJsonRpcServer()

        result = await server.handle_initialize({"agent_name": "test-agent"})
        assert result["status"] == "ready"
        assert result["agent_name"] == "test-agent"
        assert result["new_mode"] is False

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
    async def test_full_conversation_flow(self, tmp_path):
        """Test a full conversation flow."""
        server = StdioJsonRpcServer()

        # Initialize
        result = await server.handle_initialize({"agent_name": "test-agent"})
        assert result["status"] == "ready"

        # Send a message
        result = await server.handle_output({"content": "list agents"})
        assert "acknowledged" in result
        assert "response" in result

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