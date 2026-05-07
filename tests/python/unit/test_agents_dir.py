"""Tests for agent directory configuration and path resolution."""

import os
import pytest
import tempfile
from pathlib import Path

from cast.builder_tools.tools import AGENTS_DIR, _get_agent_path


class TestAgentsDirConstant:
    """Tests that AGENTS_DIR points to the correct location."""

    def test_agents_dir_points_to_dot_cast_agents(self):
        """AGENTS_DIR should be ~/.cast/agents"""
        expected = Path.home() / ".cast" / "agents"
        assert AGENTS_DIR == expected

    def test_agents_dir_is_path_object(self):
        """AGENTS_DIR should be a Path object."""
        assert isinstance(AGENTS_DIR, Path)

    def test_agents_dir_name_is_agents(self):
        """The final component of AGENTS_DIR should be 'agents'."""
        assert AGENTS_DIR.name == "agents"

    def test_agents_dir_parent_is_dot_cast(self):
        """The parent of AGENTS_DIR should be ~/.cast"""
        assert AGENTS_DIR.parent == Path.home() / ".cast"


class TestGetAgentPath:
    """Tests for _get_agent_path helper function."""

    def test_get_agent_path_returns_correct_path(self):
        """_get_agent_path should return AGENTS_DIR / name"""
        agent_name = "test-agent"
        expected = AGENTS_DIR / agent_name
        assert _get_agent_path(agent_name) == expected

    def test_get_agent_path_with_hyphenated_name(self):
        """_get_agent_path should handle hyphenated names."""
        agent_name = "my-test-agent"
        expected = AGENTS_DIR / agent_name
        assert _get_agent_path(agent_name) == expected

    def test_get_agent_path_not_under_home_cast_agents(self):
        """_get_agent_path should NOT be under ~/cast-agents (old location)."""
        agent_name = "test-agent"
        result = _get_agent_path(agent_name)
        old_location = Path.home() / "cast-agents" / agent_name
        assert result != old_location


class TestAgentCreationPath:
    """Tests that agents are created in the correct directory."""

    def test_create_agent_uses_agents_dir(self):
        """create_agent should create files under the configured AGENTS_DIR."""
        from cast.builder_tools import create_agent, tools

        with tempfile.TemporaryDirectory() as tmpdir:
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = create_agent.invoke({"name": "path-test-agent"})
                assert "created successfully" in result

                # Verify the path matches our configured directory
                expected_path = Path(tmpdir) / "path-test-agent"
                assert expected_path.exists()
                assert (expected_path / "agent.yaml").exists()
            finally:
                tools.AGENTS_DIR = original_dir

    def test_create_agent_path_contains_dot_cast_structure(self):
        """When using real AGENTS_DIR, path should contain .cast/agents."""
        # This is a sanity check that the default path has the right structure
        assert ".cast" in str(AGENTS_DIR)
        assert "agents" in str(AGENTS_DIR)
        assert "cast-agents" not in str(AGENTS_DIR)


class TestAgentDirectoryMigration:
    """Tests related to the migration from ~/cast-agents to ~/.cast/agents."""

    def test_no_hardcoded_cast_agents_in_tools(self):
        """The tools module should not have hardcoded references to cast-agents."""
        import cast.builder_tools.tools as tools_module
        import inspect

        source = inspect.getsource(tools_module)
        # Should not contain the old path pattern
        assert '"/cast-agents"' not in source or '"cast-agents"' not in source
        # But should contain the new path
        assert ".cast/agents" in source or '".cast" / "agents"' in source

    def test_list_agents_scans_agents_dir(self):
        """list_agents should scan the AGENTS_DIR directory."""
        from cast.builder_tools import list_agents, tools

        with tempfile.TemporaryDirectory() as tmpdir:
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                # Create a fake agent directory
                agent_dir = Path(tmpdir) / "scanned-agent"
                agent_dir.mkdir()
                (agent_dir / "agent.yaml").write_text("name: scanned-agent\n")

                result = list_agents.invoke({})
                assert "scanned-agent" in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_install_mcp_uses_agents_dir(self):
        """install_mcp should read/write from AGENTS_DIR."""
        from cast.builder_tools import create_agent, install_mcp, tools

        with tempfile.TemporaryDirectory() as tmpdir:
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "mcp-path-agent"})
                install_mcp.invoke({"name": "mcp-path-agent", "server": "gmail"})

                # Verify MCP config is in the right place
                mcp_path = Path(tmpdir) / "mcp-path-agent" / "mcp" / "gmail.yaml"
                assert mcp_path.exists()
            finally:
                tools.AGENTS_DIR = original_dir
