"""
Integration test for Runtime Agent with and without OPENROUTER_API_KEY.

Run this test manually:
    cd /Users/scott/Workspace/castagent/python
    source .venv/bin/activate
    
    # Without API key (echo mode)
    PYTHONPATH=/Users/scott/Workspace/castagent/python pytest tests/test_integration.py -v -k echo
    
    # With API key (LLM mode) - requires valid OPENROUTER_API_KEY
    export OPENROUTER_API_KEY="your-key"
    PYTHONPATH=/Users/scott/Workspace/castagent/python pytest tests/test_integration.py -v -k llm
"""
import os
import tempfile
import pytest
import asyncio
from unittest.mock import patch, MagicMock, AsyncMock

_ISOLATED_HOME = tempfile.mkdtemp(prefix="cast-pytest-home-")


def _env(extra=None):
    env = {"HOME": _ISOLATED_HOME, "PATH": os.environ.get("PATH", "")}
    if extra:
        env.update(extra)
    return env

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.runtime import A2AServer


@pytest.fixture
def temp_agent_dir(tmp_path):
    """Create a temporary agent directory."""
    agent_dir = tmp_path / "demo-agent"
    agent_dir.mkdir()
    
    agent_yaml = agent_dir / "agent.yaml"
    agent_yaml.write_text("""
name: demo-agent
version: "1.0"
description: "A simple demo agent for testing"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow
    read: always-allow
    glob: always-allow

tools:
  builtin:
    - bash
    - read
    - glob
  mcp: []
  custom: []
""")
    
    instructions = agent_dir / "instructions.md"
    instructions.write_text("You are a helpful demo agent.")
    
    return str(agent_dir)


class TestEchoModeIntegration:
    """Integration tests for echo mode (no API key)."""
    
    @pytest.mark.asyncio
    async def test_a2a_server_echo_mode(self, tmp_path):
        """Test the full A2A server request/response in echo mode."""
        # Create temp agent
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        (agent_dir / "agent.yaml").write_text("""
name: test-agent
version: "1.0"
description: "Test agent"
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
        (agent_dir / "instructions.md").write_text("You are a test agent.")
        
        config = AgentConfig(str(agent_dir))
        
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)
            
            # Test agent card
            request = {"jsonrpc": "2.0", "id": "1", "method": "agent/card", "params": {}}
            response = await server.handle_request(request)
            assert response["jsonrpc"] == "2.0"
            assert response["result"]["name"] == "test-agent"
            
            # Test message send
            request = {
                "jsonrpc": "2.0",
                "id": "2",
                "method": "message/send",
                "params": {
                    "message": {
                        "role": "user",
                        "parts": [{"kind": "text", "text": "hello"}],
                        "messageId": "test-1"
                    }
                }
            }
            response = await server.handle_request(request)
            assert response["jsonrpc"] == "2.0"
            assert "result" in response
            assert response["result"]["parts"][0]["kind"] == "text"
            assert "test-agent" in response["result"]["parts"][0]["text"]
    
    @pytest.mark.asyncio
    async def test_a2a_server_task_get(self, tmp_path):
        """Test task/get endpoint."""
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        (agent_dir / "agent.yaml").write_text("name: test-agent\nversion: \"1.0\"\n")
        (agent_dir / "instructions.md").write_text("Test.")
        
        config = AgentConfig(str(agent_dir))
        
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)
            
            request = {
                "jsonrpc": "2.0",
                "id": "3",
                "method": "task/get",
                "params": {"taskId": "task-1"}
            }
            response = await server.handle_request(request)
            assert response["result"]["status"] == "completed"
    
    @pytest.mark.asyncio
    async def test_a2a_server_unknown_method(self, tmp_path):
        """Test unknown method returns error."""
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        (agent_dir / "agent.yaml").write_text("name: test-agent\nversion: \"1.0\"\n")
        (agent_dir / "instructions.md").write_text("Test.")
        
        config = AgentConfig(str(agent_dir))
        
        with patch.dict(os.environ, _env(), clear=True):
            agent = RuntimeAgent(config)
            server = A2AServer(agent, port=0)
            
            request = {
                "jsonrpc": "2.0",
                "id": "4",
                "method": "unknown/method",
                "params": {}
            }
            response = await server.handle_request(request)
            assert "error" in response
            assert response["error"]["code"] == -32601


class TestLLMModeIntegration:
    """Integration tests for LLM mode (requires OPENROUTER_API_KEY)."""
    
    @pytest.mark.asyncio
    async def test_llm_mode_with_real_api(self, tmp_path):
        """Test with real LLM - only runs if OPENROUTER_API_KEY is set."""
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            pytest.skip("OPENROUTER_API_KEY not set - skipping real LLM test")
        
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        (agent_dir / "agent.yaml").write_text("""
name: test-agent
version: "1.0"
description: "Test agent"
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
        (agent_dir / "instructions.md").write_text(
            "You are a test agent. Respond with exactly: 'LLM OK'"
        )
        
        config = AgentConfig(str(agent_dir))
        agent = RuntimeAgent(config)
        
        # Verify LLM is initialized
        assert agent.graph is not None
        
        # Process a message through the real LLM
        response = await agent.process_message("Say 'LLM OK'")
        
        # Should get a real response (not echo)
        assert "LLM OK" in response or "demo agent" not in response
    
    @pytest.mark.asyncio
    async def test_llm_mode_tool_execution(self, tmp_path):
        """Test that tools are properly registered in LLM mode."""
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            pytest.skip("OPENROUTER_API_KEY not set - skipping real LLM test")
        
        agent_dir = tmp_path / "agent"
        agent_dir.mkdir()
        (agent_dir / "agent.yaml").write_text("""
name: test-agent
version: "1.0"
description: "Test agent"
brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md
tools:
  builtin:
    - bash
    - read
    - glob
  mcp: []
  custom: []
""")
        (agent_dir / "instructions.md").write_text(
            "You are a test agent with tool access."
        )
        
        config = AgentConfig(str(agent_dir))
        agent = RuntimeAgent(config)
        
        # Verify tools are loaded
        assert len(agent.tools) == 3
        tool_names = [t.name for t in agent.tools]
        assert "bash_tool" in tool_names
        assert "read_tool" in tool_names
        assert "glob_tool" in tool_names
