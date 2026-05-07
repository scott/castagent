import os
import pytest
import tempfile
import yaml
from pathlib import Path

from cast.builder_tools import (
    create_agent,
    check_name_availability,
    install_mcp,
    recommend_model,
    list_agents,
    get_agent_config,
    read_file,
    update_agent_config,
    update_instructions,
    suggest_name,
)
from cast.builder_tools.tools import AGENTS_DIR


class TestCreateAgent:
    """Tests for create_agent tool."""

    def test_create_agent_creates_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Override AGENTS_DIR for testing
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = create_agent.invoke({"name": "test-agent"})
                assert "created successfully" in result

                agent_path = Path(tmpdir) / "test-agent"
                assert (agent_path / "agent.yaml").exists()
                assert (agent_path / "instructions.md").exists()
                assert (agent_path / "tools").exists()
                assert (agent_path / "mcp").exists()
            finally:
                tools.AGENTS_DIR = original_dir

    def test_create_agent_already_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "existing-agent"})
                result = create_agent.invoke({"name": "existing-agent"})
                assert "already exists" in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_create_agent_yaml_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "yaml-test-agent"})
                agent_yaml_path = Path(tmpdir) / "yaml-test-agent" / "agent.yaml"

                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["name"] == "yaml-test-agent"
                assert config["version"] == "1.0"
                assert "brain" in config
                assert "tools" in config
                assert config["tools"]["builtin"] == ["bash", "read", "glob"]
            finally:
                tools.AGENTS_DIR = original_dir


class TestInstallMcp:
    """Tests for install_mcp tool."""

    def test_install_mcp_creates_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                # First create the agent
                create_agent.invoke({"name": "mcp-test-agent"})

                # Install MCP server
                result = install_mcp.invoke({"name": "mcp-test-agent", "server": "gmail"})
                assert "Installed MCP server 'gmail'" in result

                mcp_path = Path(tmpdir) / "mcp-test-agent" / "mcp" / "gmail.yaml"
                assert mcp_path.exists()

                with open(mcp_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["server"] == "gmail"
                assert config["auth"]["type"] == "oauth"
            finally:
                tools.AGENTS_DIR = original_dir

    def test_install_mcp_updates_agent_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "mcp-update-agent"})
                install_mcp.invoke({"name": "mcp-update-agent", "server": "slack"})

                agent_yaml_path = Path(tmpdir) / "mcp-update-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                mcp_list = config["tools"]["mcp"]
                assert any(m.get("server") == "slack" for m in mcp_list)
            finally:
                tools.AGENTS_DIR = original_dir

    def test_install_mcp_agent_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                with pytest.raises(ValueError, match="does not exist"):
                    install_mcp.invoke({"name": "nonexistent", "server": "gmail"})
            finally:
                tools.AGENTS_DIR = original_dir


class TestRecommendModel:
    """Tests for recommend_model tool."""

    def test_recommend_simple_task(self):
        result = recommend_model.invoke({"requirements": "Simple task to classify emails"})
        assert "haiku" in result.lower() or "mini" in result.lower()

    def test_recommend_complex_task(self):
        result = recommend_model.invoke({"requirements": "Complex analysis and reasoning"})
        assert "sonnet" in result.lower() or "opus" in result.lower()

    def test_recommend_coding_task(self):
        result = recommend_model.invoke({"requirements": "Code review and debugging"})
        assert "sonnet" in result.lower()

    def test_recommend_default(self):
        result = recommend_model.invoke({"requirements": "General purpose agent"})
        assert "sonnet" in result.lower()


class TestListAgents:
    """Tests for list_agents tool."""

    def test_list_agents_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = list_agents.invoke({})
                assert result == []
            finally:
                tools.AGENTS_DIR = original_dir

    def test_list_agents_returns_names(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "agent-a"})
                create_agent.invoke({"name": "agent-b"})

                result = list_agents.invoke({})
                assert "agent-a" in result
                assert "agent-b" in result
                assert result == sorted(result)
            finally:
                tools.AGENTS_DIR = original_dir


class TestGetAgentConfig:
    """Tests for get_agent_config tool."""

    def test_get_agent_config_returns_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "config-agent"})
                result = get_agent_config.invoke({"name": "config-agent"})
                assert "name: config-agent" in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_get_agent_config_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                with pytest.raises(ValueError, match="does not exist"):
                    get_agent_config.invoke({"name": "nonexistent"})
            finally:
                tools.AGENTS_DIR = original_dir


class TestUpdateAgentConfig:
    """Tests for update_agent_config tool."""

    def test_update_agent_config_merges(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "update-config-agent"})
                result = update_agent_config.invoke({
                    "name": "update-config-agent",
                    "config_yaml": "version: '2.0'\ndescription: Updated",
                })
                assert "Updated agent.yaml" in result

                agent_yaml_path = Path(tmpdir) / "update-config-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["version"] == "2.0"
                assert config["description"] == "Updated"
                assert config["name"] == "update-config-agent"  # Original value preserved
            finally:
                tools.AGENTS_DIR = original_dir


class TestUpdateInstructions:
    """Tests for update_instructions tool."""

    def test_update_instructions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "instructions-agent"})
                result = update_instructions.invoke({
                    "name": "instructions-agent",
                    "instructions_md": "# Custom Instructions\n\nBe very helpful.",
                })
                assert "Updated instructions.md" in result

                instructions_path = Path(tmpdir) / "instructions-agent" / "instructions.md"
                content = instructions_path.read_text()
                assert "Custom Instructions" in content
                assert "Be very helpful." in content
            finally:
                tools.AGENTS_DIR = original_dir


class TestSuggestName:
    """Tests for suggest_name tool."""

    def test_suggest_name_from_description(self):
        result = suggest_name.invoke({"description": "an agent that reads my emails"})
        assert "suggested name:" in result.lower()
        assert "email" in result.lower()

    def test_suggest_name_avoids_conflicts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                # Create an agent to cause a conflict
                create_agent.invoke({"name": "email-agent"})
                result = suggest_name.invoke({"description": "an agent that reads my emails"})
                assert "suggested name:" in result.lower()
                # Should have suggested an alternative since email-agent exists
                assert "was taken" in result.lower() or "email-agent-2" in result.lower()
            finally:
                tools.AGENTS_DIR = original_dir


class TestCheckNameAvailability:
    """Tests for check_name_availability tool."""

    def test_available_name(self):
        result = check_name_availability.invoke({"name": "totally-unique-agent-12345"})
        assert "available" in result.lower()

    def test_taken_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "taken-agent"})
                result = check_name_availability.invoke({"name": "taken-agent"})
                assert "taken" in result.lower() or "already" in result.lower()
            finally:
                tools.AGENTS_DIR = original_dir


class TestCreateAgentWithDescription:
    """Tests for create_agent with description parameter."""

    def test_create_agent_with_description(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = create_agent.invoke({
                    "name": "described-agent",
                    "description": "reads emails and drafts replies",
                })
                assert "created successfully" in result

                agent_yaml_path = Path(tmpdir) / "described-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["description"] == "reads emails and drafts replies"

                instructions_path = Path(tmpdir) / "described-agent" / "instructions.md"
                content = instructions_path.read_text()
                assert "reads emails and drafts replies" in content
                assert "Your Capabilities" in content
            finally:
                tools.AGENTS_DIR = original_dir


class TestReadFile:
    """Tests for read_file tool."""

    def test_read_file_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            test_file.write_text("Hello, world!\nLine 2\nLine 3\n")
            
            result = read_file.invoke({"file_path": str(test_file)})
            assert "Hello, world!" in result
            assert "Line 2" in result
            assert "Line 3" in result

    def test_read_file_not_found(self):
        result = read_file.invoke({"file_path": "/nonexistent/path/file.txt"})
        assert "not found" in result.lower()

    def test_read_file_with_offset_and_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            lines = [f"Line {i}\n" for i in range(1, 21)]
            test_file.write_text("".join(lines))
            
            result = read_file.invoke({"file_path": str(test_file), "offset": 5, "limit": 5})
            assert "Line 6" in result
            assert "Line 10" in result
            assert "Line 5" not in result
            assert "Line 11" not in result
            assert "more lines" in result

    def test_read_file_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = read_file.invoke({"file_path": tmpdir})
            assert "not a file" in result.lower()

    def test_read_file_expands_tilde(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            test_file.write_text("Home directory file content")
            
            # Mock the home directory by using the tmpdir as home
            import os
            original_home = os.environ.get("HOME")
            os.environ["HOME"] = tmpdir
            try:
                result = read_file.invoke({"file_path": "~/test.txt"})
                assert "Home directory file content" in result
            finally:
                if original_home:
                    os.environ["HOME"] = original_home
                else:
                    del os.environ["HOME"]
