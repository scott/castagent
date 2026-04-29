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
