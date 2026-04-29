import pytest
from cast.agent.base import AgentConfig
import tempfile
import os

def test_agent_config_from_path():
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a minimal agent.yaml
        config_content = """
name: test-agent
version: "1.0"
description: "Test agent"
brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md
"""
        with open(os.path.join(tmpdir, "agent.yaml"), "w") as f:
            f.write(config_content)
        
        config = AgentConfig.from_path(tmpdir)
        assert config.name == "test-agent"
        assert config.version == "1.0"
        assert config.model == "openrouter/anthropic/claude-3-7-sonnet"
