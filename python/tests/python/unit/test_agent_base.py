import pytest
import tempfile
import os
import yaml
from cast.agent.base import AgentConfig, AgentConfigError


class TestAgentConfig:
    """Tests for AgentConfig class."""

    @pytest.fixture
    def temp_agent_dir(self):
        """Create a temporary directory for test agents."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def minimal_agent_yaml(self, temp_agent_dir):
        """Create a minimal agent.yaml file."""
        config = {
            "name": "test-agent",
            "version": "1.0",
            "description": "A test agent",
            "brain": {
                "model": "openrouter/anthropic/claude-3-5-sonnet",
            }
        }
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            yaml.dump(config, f)
        return temp_agent_dir

    @pytest.fixture
    def full_agent_yaml(self, temp_agent_dir):
        """Create a full-featured agent.yaml file."""
        config = {
            "name": "my-agent",
            "version": "2.0",
            "description": "A fully featured test agent",
            "brain": {
                "model": "openrouter/anthropic/claude-3-7-sonnet",
                "instructions_file": "custom_instructions.md",
            },
            "tools": {
                "builtin": ["bash", "read", "glob"],
                "mcp": ["gmail", "github"],
                "custom": ["my_tool"],
            },
            "harness": {
                "permissions": {
                    "allow": ["read", "write"],
                    "deny": ["delete"],
                },
                "principles": ["be helpful", "be concise"],
            }
        }
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            yaml.dump(config, f)

        # Create custom instructions file
        instructions_path = os.path.join(temp_agent_dir, "custom_instructions.md")
        with open(instructions_path, "w") as f:
            f.write("# Custom Instructions\n\nYou are a helpful assistant.")

        return temp_agent_dir

    def test_from_path_with_valid_agent_yaml(self, minimal_agent_yaml):
        """Test AgentConfig.from_path loads valid agent.yaml."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config is not None
        assert isinstance(config, AgentConfig)

    def test_from_path_with_missing_directory(self):
        """Test AgentConfig.from_path handles missing directory gracefully."""
        with tempfile.TemporaryDirectory() as tmpdir:
            nonexistent_path = os.path.join(tmpdir, "nonexistent_agent")
            # Directory doesn't exist, so agent.yaml won't exist either

            config = AgentConfig.from_path(nonexistent_path)

            # Should create config with empty dict
            assert config.name == "unknown"
            assert config.version == "1.0"
            assert config.description == ""

    def test_from_path_with_invalid_yaml(self, temp_agent_dir):
        """A file that will not parse fails instead of starting with defaults."""
        invalid_yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(invalid_yaml_path, "w") as f:
            f.write("name: demo\nbrain: [unclosed\n")

        with pytest.raises(AgentConfigError) as exc_info:
            AgentConfig.from_path(temp_agent_dir)

        message = str(exc_info.value)
        assert "agent.yaml could not be parsed" in message
        assert invalid_yaml_path in message
        assert f"{invalid_yaml_path}:2)" in message
        assert f"{invalid_yaml_path}:3)" not in message
        assert "brain: [unclosed" in message

    def test_parse_error_uses_the_quoted_line(self, temp_agent_dir):
        """The location is the bad line, not the blank line after it."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        lines = ["name: demo"]
        lines.extend(f"key{i}: value" for i in range(20))
        lines.append("brain: [unclosed")
        assert len(lines) == 22
        with open(yaml_path, "w") as handle:
            handle.write("\n".join(lines) + "\n")

        with pytest.raises(AgentConfigError) as exc_info:
            AgentConfig.from_path(temp_agent_dir)

        message = str(exc_info.value)
        assert f"{yaml_path}:22)" in message
        assert f"{yaml_path}:23)" not in message
        assert "brain: [unclosed" in message

    def test_from_path_with_non_mapping_yaml(self, temp_agent_dir):
        """A document that parses but is not a mapping is a validation error."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            f.write("- just\n- a\n- list\n")

        with pytest.raises(AgentConfigError) as exc_info:
            AgentConfig.from_path(temp_agent_dir)

        message = str(exc_info.value)
        assert "agent.yaml could not be validated" in message
        assert yaml_path in message
        assert "expected a mapping" in message

    def test_from_path_with_blank_yaml_uses_defaults(self, temp_agent_dir):
        """An empty document is valid and uses defaults."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            f.write("")

        config = AgentConfig.from_path(temp_agent_dir)

        assert config.name == "unknown"
        assert config.model == "openrouter/anthropic/claude-3-7-sonnet"

    def test_config_attributes_name(self, full_agent_yaml):
        """Test name attribute parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.name == "my-agent"

    def test_config_attributes_version(self, full_agent_yaml):
        """Test version attribute parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.version == "2.0"

    @pytest.mark.parametrize(
        ("scalar", "expected"),
        [
            ("1.10", "1.10"),
            ("2.0", "2.0"),
            ("1.0.0", "1.0.0"),
            ("'1.10'", "1.10"),
            ('"1.10"', "1.10"),
            ("'2.0'", "2.0"),
            ('"2.0"', "2.0"),
            ("'1.0.0'", "1.0.0"),
            ('"1.0.0"', "1.0.0"),
            ("1.10 # keep", "1.10"),
        ],
    )
    def test_version_survives_as_written(self, temp_agent_dir, scalar, expected):
        """Unquoted numbers and quoted forms load as the same string deploy records."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w", encoding="utf-8") as handle:
            handle.write(
                "name: demo\n"
                f"version: {scalar}\n"
                "description: stay\n"
                "runtime:\n"
                "  python_version: 3.11\n"
            )

        config = AgentConfig.from_path(temp_agent_dir)

        assert config.version == expected
        assert isinstance(config.version, str)
        assert config.config["version"] == expected
        if expected == "1.10":
            assert config.version != "1.1"
        assert isinstance(config.config["runtime"]["python_version"], float)
        assert config.description == "stay"
        assert config.name == "demo"

    def test_null_version_is_the_missing_default(self, temp_agent_dir):
        """A YAML null is no version. It is not kept as the text null."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w", encoding="utf-8") as handle:
            handle.write("name: demo\nversion: null\n")

        config = AgentConfig.from_path(temp_agent_dir)

        assert config.version == "1.0"
        assert config.version != "null"
        assert config.config["version"] == "1.0"

    def test_config_attributes_description(self, full_agent_yaml):
        """Test description attribute parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.description == "A fully featured test agent"

    def test_config_attributes_model(self, full_agent_yaml):
        """Test model attribute parsing from brain config."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.model == "openrouter/anthropic/claude-3-7-sonnet"

    def test_config_default_model(self, minimal_agent_yaml):
        """Test default model when not specified."""
        # Update the agent.yaml to have empty brain
        yaml_path = os.path.join(minimal_agent_yaml, "agent.yaml")
        with open(yaml_path, "r") as f:
            config_data = yaml.safe_load(f)

        # Remove the model from brain config
        if "brain" in config_data:
            config_data["brain"].pop("model", None)
        with open(yaml_path, "w") as f:
            yaml.dump(config_data, f)

        config = AgentConfig.from_path(minimal_agent_yaml)

        # When brain.model is not specified, should use default
        assert config.model == "openrouter/anthropic/claude-3-7-sonnet"

    def test_config_custom_model(self, minimal_agent_yaml):
        """Test custom model specification."""
        # Update the agent.yaml with custom model
        yaml_path = os.path.join(minimal_agent_yaml, "agent.yaml")
        with open(yaml_path, "r") as f:
            config_data = yaml.safe_load(f)

        config_data["brain"]["model"] = "openrouter/openai/gpt-4"
        with open(yaml_path, "w") as f:
            yaml.dump(config_data, f)

        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config.model == "openrouter/openai/gpt-4"

    def test_tools_configuration_parsing(self, full_agent_yaml):
        """Test tools configuration parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.tools == {
            "builtin": ["bash", "read", "glob"],
            "mcp": ["gmail", "github"],
            "custom": ["my_tool"],
        }

    def test_tools_default_value(self, minimal_agent_yaml):
        """Test default tools value when not specified."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config.tools == {}

    def test_permissions_parsing(self, full_agent_yaml):
        """Test harness/permissions parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.permissions == {
            "allow": ["read", "write"],
            "deny": ["delete"],
        }

    def test_permissions_default_value(self, minimal_agent_yaml):
        """Test default permissions value when not specified."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config.permissions == {}

    def test_principles_parsing(self, full_agent_yaml):
        """Test harness/principles parsing."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.principles == ["be helpful", "be concise"]

    def test_principles_default_value(self, minimal_agent_yaml):
        """Test default principles value when not specified."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config.principles == []

    def test_instructions_file_property(self, full_agent_yaml):
        """Test instructions_file property."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.instructions_file == "custom_instructions.md"

    def test_instructions_file_default(self, minimal_agent_yaml):
        """Test default instructions_file when not specified."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert config.instructions_file == "instructions.md"

    def test_instructions_property_with_existing_file(self, full_agent_yaml):
        """Test instructions property when instructions file exists."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert "Custom Instructions" in config.instructions
        assert "helpful assistant" in config.instructions

    def test_instructions_property_with_missing_file(self, minimal_agent_yaml):
        """Test instructions property when instructions file doesn't exist."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        # Should return default instruction
        assert config.instructions == "You are a helpful assistant."

    def test_instructions_with_missing_directory(self):
        """Test instructions when agent directory doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            nonexistent_path = os.path.join(tmpdir, "nonexistent_agent")

            config = AgentConfig.from_path(nonexistent_path)

            # Should return default instruction
            assert config.instructions == "You are a helpful assistant."

    def test_config_with_empty_yaml(self, temp_agent_dir):
        """Test handling of empty agent.yaml."""
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            f.write("{}\n")  # Empty dict

        config = AgentConfig.from_path(temp_agent_dir)

        # Should use defaults
        assert config.name == "unknown"
        assert config.version == "1.0"
        assert config.description == ""

    def test_config_path_property(self, full_agent_yaml):
        """Test that path property is set correctly."""
        config = AgentConfig.from_path(full_agent_yaml)

        assert config.path == full_agent_yaml

    def test_multiple_agent_configs_are_independent(self, temp_agent_dir):
        """Test that multiple AgentConfig instances are independent."""
        import tempfile

        # Create two separate agent directories
        with tempfile.TemporaryDirectory() as tmpdir1, tempfile.TemporaryDirectory() as tmpdir2:
            # Create agent.yaml in first directory
            config1 = {
                "name": "agent-one",
                "version": "1.0",
            }
            yaml_path1 = os.path.join(tmpdir1, "agent.yaml")
            with open(yaml_path1, "w") as f:
                yaml.dump(config1, f)

            # Create agent.yaml in second directory
            config2 = {
                "name": "agent-two",
                "version": "2.0",
            }
            yaml_path2 = os.path.join(tmpdir2, "agent.yaml")
            with open(yaml_path2, "w") as f:
                yaml.dump(config2, f)

            configA = AgentConfig.from_path(tmpdir1)
            configB = AgentConfig.from_path(tmpdir2)

            assert configA.name != configB.name
            assert configA.version != configB.version
            assert configA.path != configB.path

    def test_agent_config_from_path_returns_instance(self, minimal_agent_yaml):
        """Test that from_path returns a proper AgentConfig instance."""
        config = AgentConfig.from_path(minimal_agent_yaml)

        assert isinstance(config, AgentConfig)

    def test_agent_config_with_brain_but_no_model(self, temp_agent_dir):
        """Test handling of brain config without model."""
        config_data = {
            "name": "test-agent",
            "brain": {
                "instructions_file": "custom.md",
            }
        }
        yaml_path = os.path.join(temp_agent_dir, "agent.yaml")
        with open(yaml_path, "w") as f:
            yaml.dump(config_data, f)

        config = AgentConfig.from_path(temp_agent_dir)

        # Should use default model
        assert config.model == "openrouter/anthropic/claude-3-7-sonnet"