import os
import pytest
import tempfile
import yaml
import json
import shutil
from pathlib import Path
from datetime import datetime

# Import versioning module
from cast import versioning


class TestVersioning:
    """Tests for agent versioning functionality."""

    @pytest.fixture
    def temp_agents_dir(self):
        """Create a temporary agents directory for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Override the AGENTS_DIR
            from cast import builder_tools
            original_dir = builder_tools.tools.AGENTS_DIR
            builder_tools.tools.AGENTS_DIR = Path(tmpdir)

            # Also need to update the versioning module's AGENTS_DIR
            original_versioning_dir = versioning.AGENTS_DIR
            versioning.AGENTS_DIR = Path(tmpdir)

            yield Path(tmpdir)

            # Restore original directories
            builder_tools.tools.AGENTS_DIR = original_dir
            versioning.AGENTS_DIR = original_versioning_dir

    @pytest.fixture
    def test_agent(self, temp_agents_dir):
        """Create a test agent."""
        agent_name = "test-agent"
        agent_path = temp_agents_dir / agent_name
        agent_path.mkdir(parents=True, exist_ok=True)
        (agent_path / "mcp").mkdir(exist_ok=True)
        (agent_path / "tools").mkdir(exist_ok=True)
        (agent_path / "tests").mkdir(exist_ok=True)

        # Create agent.yaml
        config = {
            "name": agent_name,
            "version": "1.0",
            "description": "Test agent",
            "brain": {
                "model": "openrouter/anthropic/claude-3-7-sonnet",
                "instructions_file": "instructions.md",
            },
            "tools": {"builtin": ["bash", "read", "glob"], "mcp": [], "custom": []},
        }
        with open(agent_path / "agent.yaml", "w") as f:
            yaml.dump(config, f)

        # Create instructions.md
        with open(agent_path / "instructions.md", "w") as f:
            f.write("# Test Agent\n\nYou are a helpful assistant.\n")

        return agent_name

    def test_create_version(self, test_agent, temp_agents_dir):
        """Test creating a single version."""
        result = versioning.create_version(test_agent, source="create", message="Initial version")

        assert result.id == 1
        assert result.source == "create"
        assert result.message == "Initial version"
        assert result.timestamp is not None

        # Check changes.json was created (new canonical location)
        changes_json_path = temp_agents_dir / test_agent / ".cast" / "changes" / "changes.json"
        assert changes_json_path.exists()

        with open(changes_json_path) as f:
            changes_data = json.load(f)

        assert changes_data["current"] == 1
        assert len(changes_data["versions"]) == 1

        # Backward compat: versions.json is also written if it exists
        # (it doesn't here, so the file should not be present)

    def test_create_multiple_versions(self, test_agent, temp_agents_dir):
        """Test creating multiple versions."""
        # Create first version
        v1 = versioning.create_version(test_agent, source="create", message="Initial")
        assert v1.id == 1

        # Create second version
        v2 = versioning.create_version(test_agent, source="builder", message="Updated model")
        assert v2.id == 2

        # Create third version
        v3 = versioning.create_version(test_agent, source="cli", message="Updated instructions")
        assert v3.id == 3

        # Verify all versions are tracked. list_versions returns newest first.
        versions = versioning.list_versions(test_agent)
        assert len(versions) == 3
        assert versions[0].id == 3
        assert versions[1].id == 2
        assert versions[2].id == 1

    def test_list_versions_empty(self, temp_agents_dir):
        """Test listing versions for agent that doesn't exist."""
        versions = versioning.list_versions("nonexistent-agent")
        assert versions == []

    def test_version_archive_created(self, test_agent, temp_agents_dir):
        """Test that version archive is created."""
        versioning.create_version(test_agent, source="create", message="Initial version")

        # Check archive exists in canonical changes/ location
        archive_path = temp_agents_dir / test_agent / ".cast" / "changes" / "001.tar.gz"
        assert archive_path.exists()
        assert archive_path.stat().st_size > 0

    def test_revert_creates_new_version(self, test_agent, temp_agents_dir):
        """Test that reverting creates a new version of current state."""
        # Create initial version
        versioning.create_version(test_agent, source="create", message="Initial")

        # Modify the agent
        agent_path = temp_agents_dir / test_agent
        with open(agent_path / "instructions.md", "w") as f:
            f.write("# Modified\n\nThis has been modified.\n")

        # Create another version after modification
        versioning.create_version(test_agent, source="cli", message="Modified instructions")

        # Revert to version 1
        revert_result = versioning.revert_to_version(test_agent, version_id=1, message="Reverted to v1")

        # Should have created a new version (version 3)
        assert revert_result.id == 3

        # Verify we have 3 versions now. list_versions returns newest first,
        # so the revert entry is at index 0.
        versions = versioning.list_versions(test_agent)
        assert len(versions) == 3
        assert versions[0].id == 3
        assert versions[0].message == "Reverted to v1"

    def test_revert_restores_files(self, test_agent, temp_agents_dir):
        """Test that reverting actually restores the files."""
        agent_path = temp_agents_dir / test_agent

        # Create version 1
        versioning.create_version(test_agent, source="create", message="Initial")

        # Modify instructions
        with open(agent_path / "instructions.md", "w") as f:
            f.write("# Modified content\n")

        # Create version 2
        versioning.create_version(test_agent, source="cli", message="Modified")

        # Revert to v1
        versioning.revert_to_version(test_agent, version_id=1)

        # Verify instructions.md is restored
        with open(agent_path / "instructions.md") as f:
            content = f.read()

        assert "You are a helpful assistant" in content
        assert "Modified content" not in content

    def test_get_version_details(self, test_agent, temp_agents_dir):
        """Test getting details for a specific version."""
        versioning.create_version(test_agent, source="create", message="Initial version")

        details = versioning.get_version_details(test_agent, version_id=1)

        assert details is not None
        assert details["id"] == 1
        assert details["source"] == "create"
        assert details["message"] == "Initial version"

    def test_get_version_details_nonexistent(self, test_agent, temp_agents_dir):
        """Test getting details for a nonexistent version."""
        details = versioning.get_version_details(test_agent, version_id=999)
        assert details is None

    def test_versioning_nonexistent_agent(self):
        """Test that versioning handles nonexistent agents."""
        with pytest.raises(versioning.VersioningError):
            versioning.create_version("nonexistent-agent", source="cli", message="Test")

    def test_revert_nonexistent_version(self, test_agent, temp_agents_dir):
        """Test that reverting to a nonexistent version raises error."""
        versioning.create_version(test_agent, source="create", message="Initial")

        with pytest.raises(versioning.VersioningError):
            versioning.revert_to_version(test_agent, version_id=999)

    def test_mcp_directory_included_in_version(self, test_agent, temp_agents_dir):
        """Test that MCP directory is included when it exists."""
        agent_path = temp_agents_dir / test_agent

        # Add an MCP config
        mcp_dir = agent_path / "mcp"
        mcp_config = {"server": "gmail", "version": "1.0.0", "auth": {"type": "oauth"}}
        with open(mcp_dir / "gmail.yaml", "w") as f:
            yaml.dump(mcp_config, f)

        # Create version
        versioning.create_version(test_agent, source="create", message="With MCP")

        # Check archive contains mcp directory (new canonical location)
        archive_path = temp_agents_dir / test_agent / ".cast" / "changes" / "001.tar.gz"
        import tarfile

        with tarfile.open(archive_path) as tar:
            names = tar.getnames()
            assert "mcp" in names
            assert "mcp/gmail.yaml" in names

    def test_tools_directory_included_when_has_content(self, test_agent, temp_agents_dir):
        """Test that tools directory is included when it has content."""
        agent_path = temp_agents_dir / test_agent

        # Add a custom tool
        tools_dir = agent_path / "tools"
        (tools_dir / "mytool.py").write_text("# Custom tool\n")

        # Create version
        versioning.create_version(test_agent, source="create", message="With tools")

        # Check archive contains tools directory (new canonical location)
        archive_path = temp_agents_dir / test_agent / ".cast" / "changes" / "001.tar.gz"
        import tarfile

        with tarfile.open(archive_path) as tar:
            names = tar.getnames()
            assert "tools" in names
            assert "tools/mytool.py" in names

    def test_parallel_snapshots_get_unique_ids(self, test_agent, temp_agents_dir):
        """Two writers must not both store id 2."""
        import threading

        ids = []
        errors = []

        def snapshot(index: int) -> None:
            try:
                info = versioning.create_version(
                    test_agent,
                    source="builder",
                    message=f"parallel {index}",
                )
                ids.append(info.id)
            except Exception as exc:
                errors.append(exc)

        workers = [threading.Thread(target=snapshot, args=(index,)) for index in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

        assert errors == []
        assert sorted(ids) == list(range(1, 9))

        changes_path = temp_agents_dir / test_agent / ".cast" / "changes" / "changes.json"
        changes = json.loads(changes_path.read_text())
        stored = [entry["id"] for entry in changes["versions"]]
        assert stored == list(range(1, 9))
        assert len(stored) == len(set(stored))

    def test_next_id_skips_a_duplicated_entry(self, test_agent, temp_agents_dir):
        """A log that already has two id 2 entries gets a new id after them."""
        changes_dir = temp_agents_dir / test_agent / ".cast" / "changes"
        changes_dir.mkdir(parents=True)
        (changes_dir / "002.tar.gz").write_bytes(b"")
        payload = {
            "versions": [
                {"id": 1, "timestamp": "t", "source": "create", "message": "one"},
                {"id": 2, "timestamp": "t", "source": "builder", "message": "two"},
                {"id": 2, "timestamp": "t", "source": "builder", "message": "two again"},
            ],
            "current": 2,
            "redo_stack": [],
        }
        (changes_dir / "changes.json").write_text(json.dumps(payload))

        info = versioning.create_version(test_agent, source="builder", message="after duplicate")
        assert info.id == 3

        changes = json.loads((changes_dir / "changes.json").read_text())
        assert [entry["id"] for entry in changes["versions"]] == [1, 2, 2, 3]