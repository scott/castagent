import pytest
from cast.builder import StdioJsonRpcServer
import asyncio
from pathlib import Path
import yaml

@pytest.mark.asyncio
async def test_stdio_server_initialization():
    server = StdioJsonRpcServer()
    
    # Test initialize method
    result = await server.handle_initialize({"agent_name": "test-agent"})
    assert result["status"] == "ready"
    assert result["agent_name"] == "test-agent"
    assert result["new_mode"] is False


@pytest.mark.asyncio
async def test_stdio_server_new_mode_initialization():
    server = StdioJsonRpcServer()
    
    # Test initialize method with new_mode
    result = await server.handle_initialize({"agent_name": "__new__", "new_mode": True})
    assert result["status"] == "ready"
    assert result["agent_name"] == "__new__"
    assert result["new_mode"] is True
    assert server.agent.new_mode is True
    
    # Welcome message should be the new-mode welcome
    welcome = result["message"]
    assert "create a new agent" in welcome.lower()
    assert "what should your agent do" in welcome.lower()


@pytest.mark.asyncio
async def test_stdio_server_edit_mode_initialization(tmp_path):
    server = StdioJsonRpcServer()
    
    # Create a dummy agent on disk with a rich config
    agent_name = "test-edit-agent"
    agent_dir = tmp_path / ".cast" / "agents" / agent_name
    agent_dir.mkdir(parents=True)
    config = {
        "name": agent_name,
        "version": "1.0",
        "description": "A test agent that monitors logs",
        "brain": {
            "model": "openrouter/anthropic/claude-3-7-sonnet",
            "instructions_file": "instructions.md",
        },
        "harness": {
            "permissions": {},
            "principles": ["Be concise", "Be helpful"],
        },
        "tools": {
            "builtin": ["bash", "read", "glob"],
            "mcp": [{"server": "slack", "config": "mcp/slack.yaml"}],
            "custom": [],
        },
        "runtime": {
            "python_version": "3.11",
            "requirements": [],
        },
    }
    with open(agent_dir / "agent.yaml", "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    
    # Temporarily override the agents directory
    from cast.builder_tools import tools
    original_agents_dir = tools.AGENTS_DIR
    tools.AGENTS_DIR = tmp_path / ".cast" / "agents"
    try:
        result = await server.handle_initialize({"agent_name": agent_name, "new_mode": False})
        assert result["status"] == "ready"
        assert result["agent_name"] == agent_name
        assert result["new_mode"] is False
        
        welcome = result["message"]
        assert "edit" in welcome.lower()
        assert agent_name in welcome.lower()
        # Rich welcome should include attributes from the config
        assert "monitors logs" in welcome.lower()
        assert "claude-3-7-sonnet" in welcome.lower()
        assert "bash" in welcome.lower()
        assert "slack" in welcome.lower()
        assert "be concise" in welcome.lower()
    finally:
        tools.AGENTS_DIR = original_agents_dir
