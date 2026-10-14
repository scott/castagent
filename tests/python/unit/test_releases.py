"""Tests for cast.releases - the semantic version release system.

These tests cover the new releases module that supports semantic versioning
(release 1.0, 1.6, 2.0.0) and changelog generation for deployed agents.
"""
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
import warnings
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from cast import releases
from cast import versioning


@pytest.fixture
def temp_agents_dir(monkeypatch):
    """Create a temporary agents directory for testing and patch the
    module-level AGENTS_DIR constants used by both versioning and releases.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        # Match ~/.cast/agents so the SQLite file lands in <cast_home>/cast.db.
        agents_path = Path(tmpdir) / ".cast" / "agents"
        agents_path.mkdir(parents=True)
        # Patch both modules so any code path (including transitive calls
        # like create_version called from create_release) sees the tmpdir.
        monkeypatch.setattr(releases, "AGENTS_DIR", agents_path)
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents_path)
        yield agents_path


@pytest.fixture
def test_agent(temp_agents_dir):
    """Create a test agent on disk with the standard structure."""
    agent_name = "test-agent"
    agent_path = temp_agents_dir / agent_name
    agent_path.mkdir(parents=True, exist_ok=True)
    (agent_path / "mcp").mkdir(exist_ok=True)
    (agent_path / "tools").mkdir(exist_ok=True)

    config = {
        "name": agent_name,
        "version": "0.0",
        "description": "Test agent for releases",
        "brain": {
            "model": "openrouter/anthropic/claude-3-7-sonnet",
            "instructions_file": "instructions.md",
        },
        "tools": {"builtin": ["bash", "read", "glob"], "mcp": [], "custom": []},
    }
    with open(agent_path / "agent.yaml", "w") as f:
        yaml.dump(config, f)

    with open(agent_path / "instructions.md", "w") as f:
        f.write("# Test Agent\n\nYou are a helpful assistant.\n")

    # Seed the changes.json so releases can see prior changes
    (agent_path / ".cast").mkdir(exist_ok=True)
    (agent_path / ".cast" / "changes").mkdir(exist_ok=True)
    (agent_path / ".cast" / "releases").mkdir(exist_ok=True)

    return agent_name


# =============================================================================
# validate_semver
# =============================================================================
class TestValidateSemver:
    """Tests for releases.validate_semver."""

    @pytest.mark.parametrize("version", [
        "1.0",
        "1.6",
        "2.0",
        "1.0.0",
        "2.10.5",
        "100.200.300",
        "0.0.1",
    ])
    def test_valid_semver(self, version):
        assert releases.validate_semver(version) is True

    @pytest.mark.parametrize("version", [
        "1",
        "1.",
        ".1",
        "1.0.0.0",
        "v1.0",
        "1.0-beta",
        "abc",
        "",
        "1.0.0 ",
        " 1.0.0",
        "-1.0",
        "1.-1",
    ])
    def test_invalid_semver(self, version):
        assert releases.validate_semver(version) is False


# =============================================================================
# get_current_release
# =============================================================================
class TestGetCurrentRelease:
    """Tests for releases.get_current_release."""

    def test_returns_none_when_no_releases(self, test_agent, temp_agents_dir):
        assert releases.get_current_release(test_agent) is None

    def test_returns_current_release(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial release")
        assert releases.get_current_release(test_agent) == "1.0"

    def test_returns_latest_release(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "First")
        releases.create_release(test_agent, "1.1", "Second")
        assert releases.get_current_release(test_agent) == "1.1"

    def test_returns_none_for_nonexistent_agent(self, temp_agents_dir):
        assert releases.get_current_release("nonexistent") is None


# =============================================================================
# list_releases / get_release
# =============================================================================
class TestListReleases:
    """Tests for releases.list_releases."""

    def test_empty_list(self, test_agent, temp_agents_dir):
        assert releases.list_releases(test_agent) == []

    def test_returns_releases(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "First")
        releases.create_release(test_agent, "1.1", "Second")

        result = releases.list_releases(test_agent)
        assert len(result) == 2
        # Sorted newest first
        assert result[0].version == "1.1"
        assert result[1].version == "1.0"

    def test_release_fields(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")
        result = releases.list_releases(test_agent)
        assert len(result) == 1
        rel = result[0]
        assert rel.version == "1.0"
        assert rel.message == "Initial"
        assert rel.change_number == 0  # No prior changes
        assert rel.tarball_path  # Non-empty
        assert rel.created_at  # Non-empty


class TestGetRelease:
    """Tests for releases.get_release."""

    def test_returns_existing_release(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")
        result = releases.get_release(test_agent, "1.0")
        assert result is not None
        assert result.version == "1.0"

    def test_returns_none_for_missing(self, test_agent, temp_agents_dir):
        assert releases.get_release(test_agent, "9.9") is None

    def test_returns_none_for_nonexistent_agent(self, temp_agents_dir):
        assert releases.get_release("nonexistent", "1.0") is None


# =============================================================================
# _version_tuple
# =============================================================================
class TestVersionTuple:
    """Tests for releases._version_tuple (sort key)."""

    def test_two_part(self):
        assert releases._version_tuple("1.0") == (1, 0)

    def test_three_part(self):
        assert releases._version_tuple("2.10.5") == (2, 10, 5)

    def test_single_part(self):
        assert releases._version_tuple("5") == (5,)


# =============================================================================
# get_latest_release_change_number
# =============================================================================
class TestGetLatestReleaseChangeNumber:
    """Tests for releases.get_latest_release_change_number."""

    def test_zero_when_no_releases(self, test_agent, temp_agents_dir):
        assert releases.get_latest_release_change_number(test_agent) == 0

    def test_returns_change_number_of_latest(self, test_agent, temp_agents_dir):
        # Create some changes first
        versioning.create_version(test_agent, source="create", message="Initial")
        versioning.create_version(test_agent, source="cli", message="Update 1")
        # Release from the latest change
        releases.create_release(test_agent, "1.0", "First")
        result = releases.get_latest_release_change_number(test_agent)
        assert result == 2  # The release is based on change 2


# =============================================================================
# generate_changelog
# =============================================================================
class TestGenerateChangelog:
    """Tests for releases.generate_changelog."""

    def test_empty_when_no_changes(self, test_agent, temp_agents_dir):
        assert releases.generate_changelog(test_agent) == ""

    def test_empty_when_no_changes_since(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="Initial")
        # since_change is the *exclusive* lower bound; passing in the
        # current change id returns nothing because no later changes exist.
        assert releases.generate_changelog(test_agent, since_change=1) == ""

    def test_groups_features(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="Initial")
        versioning.create_version(test_agent, source="cli", message="Added MCP server")
        result = releases.generate_changelog(test_agent, since_change=0)
        assert "Features" in result
        assert "Added MCP server" in result

    def test_groups_improvements(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="Initial")
        versioning.create_version(test_agent, source="cli", message="Updated instructions")
        result = releases.generate_changelog(test_agent, since_change=0)
        assert "Improvements" in result
        assert "Updated instructions" in result

    def test_groups_patches(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="Initial")
        versioning.create_version(test_agent, source="cli", message="Bumped deps")
        result = releases.generate_changelog(test_agent, since_change=0)
        # No specific keyword matched -> goes into "Bug Fixes" bucket
        assert "Bug Fixes" in result
        assert "Bumped deps" in result

    def test_no_changelog_file(self, temp_agents_dir):
        # No changes.json present at all
        assert releases.generate_changelog("never-existed") == ""


# =============================================================================
# suggest_version
# =============================================================================
class TestSuggestVersion:
    """Tests for releases.suggest_version."""

    def test_no_current_release(self, test_agent, temp_agents_dir):
        result = releases.suggest_version(test_agent)
        assert result == {"patch": "0.1.0", "minor": "0.1.0", "major": "1.0.0"}

    def test_with_current_release(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "First")
        result = releases.suggest_version(test_agent)
        assert result == {
            "patch": "1.0.1",
            "minor": "1.1.0",
            "major": "2.0.0",
        }

    def test_with_two_part_release(self, test_agent, temp_agents_dir):
        # 1.6 -> patch 1.6.1, minor 1.7.0, major 2.0.0
        releases.create_release(test_agent, "1.6", "1.6")
        result = releases.suggest_version(test_agent)
        assert result == {
            "patch": "1.6.1",
            "minor": "1.7.0",
            "major": "2.0.0",
        }

    def test_detects_breaking_changes(self, test_agent, temp_agents_dir):
        """Removing a tool should bump the major version suggestion."""
        releases.create_release(test_agent, "1.0", "First")
        versioning.create_version(test_agent, source="cli", message="Removed tool: bash")
        result = releases.suggest_version(test_agent)
        assert result.get("breaking") is True
        assert result["major"] == "2.0.0"


# =============================================================================
# create_release
# =============================================================================
class TestCreateRelease:
    """Tests for releases.create_release."""

    def test_creates_tarball(self, test_agent, temp_agents_dir):
        info = releases.create_release(test_agent, "1.0", "Initial")
        tarball_path = Path(info.tarball_path)
        assert tarball_path.exists()
        assert tarball_path.name == "1.0.tar.gz"
        # Tarball should be inside releases/ directory
        assert "releases" in tarball_path.parts

    def test_stores_tarball_path_relative_to_agent_directory(self, test_agent, temp_agents_dir):
        """releases.json must not publish an absolute home path."""
        info = releases.create_release(test_agent, "1.0", "Initial")
        manifest_path = temp_agents_dir / test_agent / ".cast" / "releases" / "releases.json"
        stored = json.loads(manifest_path.read_text())["releases"][0]["tarball_path"]
        assert stored == ".cast/releases/1.0.tar.gz"
        assert not Path(stored).is_absolute()
        assert str(temp_agents_dir) not in stored

        resolved = (temp_agents_dir / test_agent / stored).resolve()
        assert Path(info.tarball_path) == resolved
        assert Path(info.tarball_path).is_absolute()
        assert Path(info.tarball_path).exists()

        rows = _sqlite_rows(test_agent)
        assert rows[0][4] == str(resolved)

    def test_relative_tarball_path_works_after_directory_move(
        self, test_agent, temp_agents_dir, monkeypatch
    ):
        """A clone or rename of the agent directory still opens the tarball."""
        releases.create_release(test_agent, "1.0", "Initial")
        source = temp_agents_dir / test_agent

        with tempfile.TemporaryDirectory() as moved_root:
            moved_agents = Path(moved_root) / ".cast" / "agents"
            moved_agents.mkdir(parents=True)
            dest = moved_agents / "renamed-agent"
            shutil.copytree(source, dest)
            monkeypatch.setattr(releases, "AGENTS_DIR", moved_agents)

            listed = releases.list_releases("renamed-agent")
            expected = (dest / ".cast" / "releases" / "1.0.tar.gz").resolve()
            assert Path(listed[0].tarball_path) == expected
            assert expected.exists()

            with tempfile.TemporaryDirectory() as tmpdir:
                target = Path(tmpdir) / "extracted"
                target.mkdir()
                releases.extract_release("renamed-agent", "1.0", target)
                assert (target / "agent.yaml").exists()
                assert (target / "instructions.md").exists()

    def test_creates_releases_json(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")
        path = temp_agents_dir / test_agent / ".cast" / "releases" / "releases.json"
        assert path.exists()
        data = json.loads(path.read_text())
        assert "releases" in data
        assert len(data["releases"]) == 1
        assert data["current"]["version"] == "1.0"

    def test_updates_agent_yaml_version(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.6", "1.6 release")
        yaml_path = temp_agents_dir / test_agent / "agent.yaml"
        data = yaml.safe_load(yaml_path.read_text())
        assert data["version"] == "1.6"

    def test_default_message(self, test_agent, temp_agents_dir):
        info = releases.create_release(test_agent, "1.0")
        assert info.message == "Release 1.0"

    def test_includes_mcp_when_present(self, test_agent, temp_agents_dir):
        mcp_dir = temp_agents_dir / test_agent / "mcp"
        with open(mcp_dir / "gmail.yaml", "w") as f:
            yaml.dump({"server": "gmail", "version": "1.0.0"})

        info = releases.create_release(test_agent, "1.0", "With MCP")
        with tarfile.open(info.tarball_path) as tar:
            names = tar.getnames()
            assert "mcp" in names
            assert "mcp/gmail.yaml" in names

    def test_includes_tools_when_present(self, test_agent, temp_agents_dir):
        tools_dir = temp_agents_dir / test_agent / "tools"
        (tools_dir / "mytool.py").write_text("# custom tool\n")

        info = releases.create_release(test_agent, "1.0", "With tools")
        with tarfile.open(info.tarball_path) as tar:
            names = tar.getnames()
            assert "tools" in names
            assert "tools/mytool.py" in names

    def test_packs_full_agent_except_castignore(self, test_agent, temp_agents_dir):
        """The release is the working tree, not the old allowlist.

        instructions.md can be an unused leftover. The configured prompt
        (bb-prompt.md), skills, tools, memory notes, mcp, and tests belong
        in the tarball. .castignore state, .cast/, and .git/ do not.
        """
        agent = temp_agents_dir / test_agent
        (agent / "instructions.md").write_text("# unused leftover\n")
        (agent / "bb-prompt.md").write_text("PROMPT v1\n")
        config = yaml.safe_load((agent / "agent.yaml").read_text())
        config["brain"]["instructions_file"] = "bb-prompt.md"
        (agent / "agent.yaml").write_text(yaml.dump(config))

        (agent / "skills" / "triage").mkdir(parents=True)
        (agent / "skills" / "triage" / "SKILL.md").write_text("# triage\n")
        (agent / "tools" / "bb.py").write_text("# tool\n")
        (agent / "memory").mkdir()
        (agent / "memory" / "user.md").write_text("notes\n")
        (agent / "memory" / "memory.db").write_bytes(b"db")
        (agent / "memory" / "memory.db-wal").write_bytes(b"wal")
        (agent / "mcp" / "gmail.yaml").write_text("server: gmail\n")
        (agent / "tests").mkdir()
        (agent / "tests" / "scenario.yaml").write_text("name: t\n")
        (agent / ".env").write_text("SECRET=1\n")
        (agent / "debug.log").write_text("log\n")
        (agent / "pkg" / "__pycache__").mkdir(parents=True)
        (agent / "pkg" / "__pycache__" / "x.pyc").write_bytes(b"pyc")
        (agent / "pkg" / "keep.py").write_text("# keep\n")
        (agent / ".git").mkdir()
        (agent / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (agent / ".cast" / "changes").mkdir(parents=True, exist_ok=True)
        (agent / ".cast" / "changes" / "changes.json").write_text("{}\n")
        (agent / ".castignore").write_text(
            ".cast/versions/\n"
            "cast.db\n"
            "*.log\n"
            ".env\n"
            "__pycache__/\n"
            "memory/memory.db\n"
            "memory/memory.db-journal\n"
            "memory/memory.db-wal\n"
            "memory/memory.db-shm\n"
        )

        info = releases.create_release(test_agent, "1.0", "bb rel")
        with tarfile.open(info.tarball_path) as tar:
            names = set(tar.getnames())
            prompt = tar.extractfile("bb-prompt.md").read().decode()
            leftover = tar.extractfile("instructions.md").read().decode()

        assert prompt == "PROMPT v1\n"
        assert leftover == "# unused leftover\n"
        assert "skills/triage/SKILL.md" in names
        assert "tools/bb.py" in names
        assert "memory/user.md" in names
        assert "mcp/gmail.yaml" in names
        assert "tests/scenario.yaml" in names
        assert "pkg/keep.py" in names
        assert ".castignore" in names
        assert "agent.yaml" in names
        assert "memory/memory.db" not in names
        assert "memory/memory.db-wal" not in names
        assert ".env" not in names
        assert "debug.log" not in names
        assert "pkg/__pycache__/x.pyc" not in names
        assert not any(name == ".git" or name.startswith(".git/") for name in names)
        assert not any(name == ".cast" or name.startswith(".cast/") for name in names)

    def test_without_castignore_includes_env(self, test_agent, temp_agents_dir):
        agent = temp_agents_dir / test_agent
        (agent / ".env").write_text("SECRET=1\n")
        (agent / "skills" / "triage").mkdir(parents=True)
        (agent / "skills" / "triage" / "SKILL.md").write_text("# triage\n")

        info = releases.create_release(test_agent, "1.0", "no ignore")
        with tarfile.open(info.tarball_path) as tar:
            names = set(tar.getnames())
        assert ".env" in names
        assert "skills/triage/SKILL.md" in names

    def test_rejects_invalid_version(self, test_agent, temp_agents_dir):
        with pytest.raises(ValueError, match="Invalid semantic version"):
            releases.create_release(test_agent, "not-a-version", "msg")

    def test_rejects_nonexistent_agent(self, temp_agents_dir):
        with pytest.raises(ValueError, match="does not exist"):
            releases.create_release("nonexistent-agent", "1.0", "msg")

    def test_subsequent_release_uses_correct_change_number(
        self, test_agent, temp_agents_dir
    ):
        versioning.create_version(test_agent, source="create", message="v1")
        first = releases.create_release(test_agent, "1.0", "First")
        versioning.create_version(test_agent, source="cli", message="v2")
        second = releases.create_release(test_agent, "1.1", "Second")
        assert first.change_number == 1
        assert second.change_number == 2

    def test_generates_changelog_when_changes_exist(
        self, test_agent, temp_agents_dir
    ):
        versioning.create_version(test_agent, source="create", message="Initial")
        versioning.create_version(test_agent, source="cli", message="Added MCP server")
        info = releases.create_release(test_agent, "1.0", "First")
        assert "Added MCP server" in info.changelog


# =============================================================================
# extract_release
# =============================================================================
class TestExtractRelease:
    """Tests for releases.extract_release."""

    def test_extracts_to_target_dir(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            releases.extract_release(test_agent, "1.0", target)

            assert (target / "agent.yaml").exists()
            assert (target / "instructions.md").exists()

    def test_clears_existing_files(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            # Plant files that should be cleared
            (target / "old_file.txt").write_text("stale")
            (target / "old_dir").mkdir()
            (target / "old_dir" / "x.txt").write_text("stale")

            releases.extract_release(test_agent, "1.0", target)

            assert not (target / "old_file.txt").exists()
            assert not (target / "old_dir").exists()
            assert (target / "agent.yaml").exists()

    def test_preserves_cast_and_git(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "Initial")

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            (target / ".cast").mkdir()
            (target / ".cast" / "important.json").write_text("keep me")
            (target / ".git").mkdir()

            releases.extract_release(test_agent, "1.0", target)

            assert (target / ".cast" / "important.json").exists()
            assert (target / ".git").exists()

    def test_restore_reverts_prompt_and_drops_new_files(self, test_agent, temp_agents_dir):
        """cast restore puts the released tree back.

        The configured prompt returns to the released bytes, a tool added
        later is removed, and .castignore state stays.
        """
        agent = temp_agents_dir / test_agent
        (agent / "bb-prompt.md").write_text("PROMPT v1\n")
        (agent / "tools" / "old.py").write_text("# old\n")
        (agent / "skills" / "triage").mkdir(parents=True)
        (agent / "skills" / "triage" / "SKILL.md").write_text("# triage\n")
        (agent / "memory").mkdir()
        (agent / "memory" / "memory.db").write_bytes(b"db")
        (agent / ".env").write_text("SECRET=1\n")
        (agent / ".git").mkdir()
        (agent / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (agent / ".castignore").write_text(
            "*.log\n.env\n__pycache__/\n"
            "memory/memory.db\nmemory/memory.db-wal\n"
            "memory/memory.db-shm\nmemory/memory.db-journal\n"
        )

        releases.create_release(test_agent, "1.0", "bb rel")

        (agent / "bb-prompt.md").write_text("AFTER\n")
        (agent / "tools" / "bbnew.py").write_text("# new\n")
        (agent / "skills" / "triage" / "SKILL.md").write_text("# edited\n")
        (agent / "notes.md").write_text("later\n")
        (agent / ".env").write_text("SECRET=changed\n")
        (agent / "memory" / "memory.db").write_bytes(b"db2")

        releases.extract_release(test_agent, "1.0", agent)

        assert (agent / "bb-prompt.md").read_text() == "PROMPT v1\n"
        assert (agent / "tools" / "old.py").read_text() == "# old\n"
        assert not (agent / "tools" / "bbnew.py").exists()
        assert (agent / "skills" / "triage" / "SKILL.md").read_text() == "# triage\n"
        assert not (agent / "notes.md").exists()
        assert (agent / ".env").read_text() == "SECRET=changed\n"
        assert (agent / "memory" / "memory.db").read_bytes() == b"db2"
        assert (agent / ".git" / "HEAD").read_text() == "ref: refs/heads/main\n"
        assert (agent / ".cast" / "releases" / "releases.json").exists()
        assert (agent / ".cast" / "releases" / "1.0.tar.gz").exists()

    def test_missing_release_raises(self, test_agent, temp_agents_dir):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            with pytest.raises(ValueError, match="Release .* not found"):
                releases.extract_release(test_agent, "9.9", target)

    def test_legacy_absolute_tarball_path_still_opens(self, test_agent, temp_agents_dir):
        """Manifests written before relative paths keep working in place."""
        info = releases.create_release(test_agent, "1.0", "Initial")
        absolute = info.tarball_path
        manifest_path = temp_agents_dir / test_agent / ".cast" / "releases" / "releases.json"
        data = json.loads(manifest_path.read_text())
        data["releases"][0]["tarball_path"] = absolute
        manifest_path.write_text(json.dumps(data))

        got = releases.get_release(test_agent, "1.0")
        assert got is not None
        assert got.tarball_path == absolute

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            releases.extract_release(test_agent, "1.0", target)
            assert (target / "agent.yaml").exists()

    def test_missing_absolute_path_falls_back_to_local_tarball(
        self, test_agent, temp_agents_dir
    ):
        """A cloned manifest with the author's absolute path uses the local file."""
        releases.create_release(test_agent, "1.0", "Initial")
        manifest_path = temp_agents_dir / test_agent / ".cast" / "releases" / "releases.json"
        data = json.loads(manifest_path.read_text())
        data["releases"][0]["tarball_path"] = "/home/box/.cast/agents/bb-git/.cast/releases/1.0.tar.gz"
        manifest_path.write_text(json.dumps(data))

        local = (temp_agents_dir / test_agent / ".cast" / "releases" / "1.0.tar.gz").resolve()
        got = releases.get_release(test_agent, "1.0")
        assert got is not None
        assert Path(got.tarball_path) == local

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            releases.extract_release(test_agent, "1.0", target)
            assert (target / "instructions.md").exists()

    def test_missing_tarball_raises(self, test_agent, temp_agents_dir):
        info = releases.create_release(test_agent, "1.0", "Initial")
        # Delete the tarball
        Path(info.tarball_path).unlink()

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "extracted"
            target.mkdir()
            with pytest.raises(FileNotFoundError):
                releases.extract_release(test_agent, "1.0", target)


# =============================================================================
# Deprecation warning helper
# =============================================================================
class TestDeprecationHelper:
    """Tests for releases._emit_deprecation_warning."""

    def test_warns_with_deprecation_warning(self):
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            releases._emit_deprecation_warning("old_func", "new_func")
        deprecation_warnings = [
            w for w in captured if issubclass(w.category, DeprecationWarning)
        ]
        assert len(deprecation_warnings) == 1
        msg = str(deprecation_warnings[0].message)
        assert "old_func" in msg
        assert "new_func" in msg


# =============================================================================
# ReleaseInfo dataclass
# =============================================================================
class TestReleaseInfo:
    """Tests for the ReleaseInfo dataclass."""

    def test_fields(self):
        info = releases.ReleaseInfo(
            version="1.0",
            change_number=2,
            message="Initial",
            changelog="",
            created_at="2024-01-01T00:00:00Z",
            tarball_path="/tmp/1.0.tar.gz",
        )
        assert info.version == "1.0"
        assert info.change_number == 2
        assert info.message == "Initial"
        assert info.changelog == ""
        assert info.created_at == "2024-01-01T00:00:00Z"
        assert info.tarball_path == "/tmp/1.0.tar.gz"


def _sqlite_rows(agent_name: str):
    conn = sqlite3.connect(str(releases._cast_db_path()))
    try:
        return conn.execute(
            """
            SELECT version, change_number, message, changelog, tarball_path, created_at
            FROM releases WHERE agent_name = ?
            """,
            (agent_name,),
        ).fetchall()
    finally:
        conn.close()


def _sqlite_current(agent_name: str):
    conn = sqlite3.connect(str(releases._cast_db_path()))
    try:
        row = conn.execute(
            """
            SELECT version FROM releases
            WHERE agent_name = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (agent_name,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def _plant_split_releases(agent_name: str, agents_dir: Path) -> None:
    """JSON has 1.4 through 1.4.4; SQLite only has 1.4, with its own message."""
    releases_dir = agents_dir / agent_name / ".cast" / "releases"
    releases_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "current": {"version": "1.4.4", "change_number": 8},
        "releases": [
            {
                "version": "1.4",
                "change_number": 4,
                "message": "json-old",
                "changelog": "json-log",
                "created_at": "2026-06-09T12:00:00Z",
                "tarball_path": "/tmp/json-1.4.tar.gz",
            },
            {
                "version": "1.4.1",
                "change_number": 5,
                "message": "ssh",
                "changelog": "ssh log",
                "created_at": "2026-06-10T12:00:00Z",
                "tarball_path": "/tmp/1.4.1.tar.gz",
            },
            {
                "version": "1.4.2",
                "change_number": 6,
                "message": "tui2",
                "changelog": "",
                "created_at": "2026-06-11T12:00:00Z",
                "tarball_path": "/tmp/1.4.2.tar.gz",
            },
            {
                "version": "1.4.3",
                "change_number": 7,
                "message": "new-agent-runtime",
                "changelog": "",
                "created_at": "2026-06-12T12:00:00Z",
                "tarball_path": "/tmp/1.4.3.tar.gz",
            },
            {
                "version": "1.4.4",
                "change_number": 8,
                "message": "addedgander",
                "changelog": "gander",
                "created_at": "2026-06-13T12:00:00Z",
                "tarball_path": "/tmp/1.4.4.tar.gz",
            },
        ],
    }
    (releases_dir / "releases.json").write_text(json.dumps(payload))
    db_path = releases._cast_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS releases (
                agent_name TEXT,
                version TEXT,
                change_number INTEGER,
                message TEXT,
                changelog TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                tarball_path TEXT,
                PRIMARY KEY (agent_name, version)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO releases (
                agent_name, version, change_number, message, changelog, created_at, tarball_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (agent_name, "1.4", 4, "db-original", "db-log", "2026-06-09 12:00:00", "/tmp/db-1.4.tar.gz"),
        )
        conn.commit()
    finally:
        conn.close()


# =============================================================================
# SQLite sync
# =============================================================================
class TestReleaseSqliteSync:
    """create_release writes releases.json and the SQLite releases row."""

    def test_temp_home_create_writes_json_and_sqlite(self, monkeypatch, tmp_path):
        home = tmp_path / "home"
        monkeypatch.setenv("HOME", str(home))
        agents = Path.home() / ".cast" / "agents"
        agent = agents / "demo-agent"
        agent.mkdir(parents=True)
        (agent / "agent.yaml").write_text("name: demo-agent\nversion: '0.0'\n")
        (agent / "instructions.md").write_text("# demo\n")
        monkeypatch.setattr(releases, "AGENTS_DIR", agents)
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents)

        versioning.create_version("demo-agent", source="cli", message="Added ssh")
        info = releases.create_release("demo-agent", "1.5.0", "ship it")

        db_path = home / ".cast" / "cast.db"
        assert db_path.exists()
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                """
                SELECT version, change_number, message, changelog, tarball_path
                FROM releases WHERE agent_name = ? AND version = ?
                """,
                ("demo-agent", "1.5.0"),
            ).fetchone()
            current = conn.execute(
                """
                SELECT version FROM releases WHERE agent_name = ?
                ORDER BY created_at DESC LIMIT 1
                """,
                ("demo-agent",),
            ).fetchone()
        finally:
            conn.close()

        assert row[0] == "1.5.0"
        assert row[1] == info.change_number == 1
        assert row[2] == "ship it"
        assert "Added ssh" in row[3]
        assert row[4] == info.tarball_path
        assert current[0] == releases.get_current_release("demo-agent") == "1.5.0"
        manifest = json.loads((agent / ".cast" / "releases" / "releases.json").read_text())
        assert manifest["current"]["version"] == "1.5.0"
        assert manifest["releases"][0]["tarball_path"] == ".cast/releases/1.5.0.tar.gz"

    def test_second_create_does_not_overwrite_sqlite(self, test_agent, temp_agents_dir):
        releases.create_release(test_agent, "1.0", "First")
        conn = sqlite3.connect(str(releases._cast_db_path()))
        try:
            conn.execute(
                """
                UPDATE releases SET message = ?, changelog = ?
                WHERE agent_name = ? AND version = ?
                """,
                ("keep-me", "original-log", test_agent, "1.0"),
            )
            conn.commit()
        finally:
            conn.close()

        releases.create_release(test_agent, "1.0", "Second")
        rows = {row[0]: row for row in _sqlite_rows(test_agent)}
        assert rows["1.0"][2] == "keep-me"
        assert rows["1.0"][3] == "original-log"
        assert len(rows) == 1

    def test_backfill_on_list_and_get_current(self, test_agent, temp_agents_dir):
        _plant_split_releases(test_agent, temp_agents_dir)
        listed = releases.list_releases(test_agent)
        assert [item.version for item in listed] == ["1.4.4", "1.4.3", "1.4.2", "1.4.1", "1.4"]
        self._assert_backfill(test_agent)

        # A second read, and get-current on a fresh split, must not clobber.
        assert releases.get_current_release(test_agent) == "1.4.4"
        self._assert_backfill(test_agent)

    def test_get_current_backfill_without_list(self, test_agent, temp_agents_dir):
        _plant_split_releases(test_agent, temp_agents_dir)
        assert releases.get_current_release(test_agent) == "1.4.4"
        self._assert_backfill(test_agent)
        assert _sqlite_current(test_agent) == "1.4.4"

    def test_create_backfills_missing_versions(self, test_agent, temp_agents_dir):
        _plant_split_releases(test_agent, temp_agents_dir)
        releases.create_release(test_agent, "1.5.0", "from any path")
        rows = {row[0]: row for row in _sqlite_rows(test_agent)}
        assert rows["1.4"][2] == "db-original"
        assert rows["1.4"][3] == "db-log"
        assert rows["1.4"][4] == "/tmp/db-1.4.tar.gz"
        assert rows["1.4.1"][2] == "ssh"
        assert rows["1.4.4"][2] == "addedgander"
        assert rows["1.5.0"][2] == "from any path"
        assert releases.get_current_release(test_agent) == _sqlite_current(test_agent) == "1.5.0"

    def test_migration_adds_columns_without_filling_existing_row(self, test_agent, temp_agents_dir):
        releases_dir = temp_agents_dir / test_agent / ".cast" / "releases"
        releases_dir.mkdir(parents=True, exist_ok=True)
        (releases_dir / "releases.json").write_text(json.dumps({
            "current": {"version": "1.1", "change_number": 2},
            "releases": [
                {
                    "version": "1.0",
                    "change_number": 1,
                    "message": "should-not-replace",
                    "changelog": "nope",
                    "created_at": "2026-01-01T00:00:00Z",
                    "tarball_path": "/tmp/new-1.0.tar.gz",
                },
                {
                    "version": "1.1",
                    "change_number": 2,
                    "message": "newer",
                    "changelog": "notes",
                    "created_at": "2026-02-01T00:00:00Z",
                    "tarball_path": "/tmp/1.1.tar.gz",
                },
            ],
        }))
        db_path = releases._cast_db_path()
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                """
                CREATE TABLE releases (
                    agent_name TEXT,
                    version TEXT,
                    PRIMARY KEY (agent_name, version)
                )
                """
            )
            conn.execute(
                "INSERT INTO releases (agent_name, version) VALUES (?, ?)",
                (test_agent, "1.0"),
            )
            conn.commit()
        finally:
            conn.close()

        releases.list_releases(test_agent)
        conn = sqlite3.connect(str(db_path))
        try:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(releases)")]
            old = conn.execute(
                "SELECT message, changelog, tarball_path, change_number FROM releases WHERE version = '1.0'"
            ).fetchone()
            new = conn.execute(
                "SELECT message, changelog, tarball_path, change_number FROM releases WHERE version = '1.1'"
            ).fetchone()
        finally:
            conn.close()

        for column in ("change_number", "message", "changelog", "created_at", "tarball_path"):
            assert column in columns
        assert old[0] is None
        assert old[1] is None
        assert old[2] is None
        assert new[0] == "newer"
        assert new[1] == "notes"
        assert new[2] == "/tmp/1.1.tar.gz"
        assert new[3] == 2

    def _assert_backfill(self, agent_name: str) -> None:
        rows = {row[0]: row for row in _sqlite_rows(agent_name)}
        assert set(rows) == {"1.4", "1.4.1", "1.4.2", "1.4.3", "1.4.4"}
        assert rows["1.4"][2] == "db-original"
        assert rows["1.4"][3] == "db-log"
        assert rows["1.4"][4] == "/tmp/db-1.4.tar.gz"
        assert rows["1.4.1"][1] == 5
        assert rows["1.4.1"][2] == "ssh"
        assert rows["1.4.1"][3] == "ssh log"
        assert rows["1.4.1"][4] == "/tmp/1.4.1.tar.gz"
        assert rows["1.4.4"][2] == "addedgander"
        assert rows["1.4.4"][3] == "gander"
        assert _sqlite_current(agent_name) == "1.4.4"
