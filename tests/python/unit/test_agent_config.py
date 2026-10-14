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


def test_tools_list_is_not_treated_as_a_mapping():
    """A flat tools list must not crash callers that read tools.builtin."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "agent.yaml"), "w") as handle:
            handle.write("""
name: bb2-live
brain:
  model: openrouter/minimax/minimax-m2.5
tools:
  - bash
  - read
  - glob
permissions:
  bash: approve-once
memory:
  enabled: true
""")
        config = AgentConfig.from_path(tmpdir)
        assert config.tools == {}
        assert config.tools.get("builtin", []) == []
        assert config.permissions == {}
        assert config.model == "openrouter/minimax/minimax-m2.5"
