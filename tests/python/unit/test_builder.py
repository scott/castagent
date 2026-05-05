import pytest
from cast.builder import StdioJsonRpcServer
import asyncio

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
