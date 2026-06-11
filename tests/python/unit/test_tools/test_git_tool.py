"""Tests for git_tool functions."""
import os
import sys
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Check if git module is available before importing
try:
    import git
    HAS_GIT = True
except ImportError:
    HAS_GIT = False

if not HAS_GIT:
    pytest.skip("GitPython not installed", allow_module_level=True)

from cast.tools.git import (
    git_status,
    git_commit,
    git_push,
    git_log,
    git_diff,
    git_add,
    get_agent_path,
    load_agent_config,
)


class TestGetAgentPath:
    """Tests for get_agent_path function."""

    def test_uses_environment_variable_if_set(self):
        """Should use CAST_AGENT_DIR env var if set."""
        with patch.dict(os.environ, {"CAST_AGENT_DIR": "/custom/path"}):
            path = get_agent_path()
            assert path == "/custom/path"

    def test_uses_default_path_when_no_env_var(self):
        """Should use default ~/.cast/agents path."""
        with patch.dict(os.environ, {}, clear=True):
            path = get_agent_path()
            expected = str(Path.home() / ".cast" / "agents")
            assert path == expected

    def test_expands_home_directory(self):
        """Should expand ~ to home directory."""
        with patch.dict(os.environ, {}, clear=True):
            path = get_agent_path()
            assert path.startswith(str(Path.home()))


class TestLoadAgentConfig:
    """Tests for load_agent_config function."""

    def test_loads_existing_config(self, tmp_path):
        """Should load existing agent.yaml."""
        config_content = """
name: test-agent
version: "1.0"
description: "Test agent"
"""
        config_path = tmp_path / "agent.yaml"
        config_path.write_text(config_content)

        config = load_agent_config(str(tmp_path))

        assert config["name"] == "test-agent"
        assert config["version"] == "1.0"

    def test_returns_empty_dict_for_missing_config(self, tmp_path):
        """Should return empty dict for missing config."""
        config = load_agent_config(str(tmp_path))

        assert config == {}

    def test_handles_invalid_yaml(self, tmp_path):
        """Should handle invalid YAML gracefully."""
        config_path = tmp_path / "agent.yaml"
        config_path.write_text("invalid: yaml: content:")

        config = load_agent_config(str(tmp_path))

        # Should return empty dict for invalid YAML
        assert config == {}


class TestGitStatus:
    """Tests for git_status tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_status.invoke({})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_returns_clean_status_for_repo_with_no_changes(self, mock_repo, tmp_path):
        """Should return clean status for repo with no changes."""
        # Setup mock
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.git.status.return_value = ""
        mock_repo_instance.branches = []
        mock_repo_instance.head.is_detached = False
        mock_repo_instance.index.diff.return_value = []
        mock_repo_instance.untracked_files = []

        # Create fake .git directory
        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_status.invoke({})

            assert "Working tree is clean" in result or "branch" in result.lower()

    @patch("cast.tools.git.git.Repo")
    def test_shows_modified_files(self, mock_repo, tmp_path):
        """Should show modified files in status."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.git.status.return_value = "M file.txt"
        mock_repo_instance.branches = []
        mock_repo_instance.head.is_detached = False

        # Mock diffs - use side_effect to return different values for different args
        mock_diff = MagicMock()
        mock_diff.a_path = "file.txt"
        mock_repo_instance.index.diff.side_effect = lambda x: [mock_diff] if x else []
        mock_repo_instance.untracked_files = []

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_status.invoke({})

            assert "file.txt" in result or "Modified" in result

    @patch("cast.tools.git.git.Repo")
    def test_shows_untracked_files(self, mock_repo, tmp_path):
        """Should show untracked files in status."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.branches = []
        mock_repo_instance.head.is_detached = False
        mock_repo_instance.index.diff.side_effect = lambda x: []  # Return empty for both staged and unstaged
        mock_repo_instance.untracked_files = ["new_file.txt"]

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_status.invoke({})

            assert "new_file.txt" in result or "Untracked" in result


class TestGitCommit:
    """Tests for git_commit tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_commit.invoke({"message": "test commit"})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_commits_successfully(self, mock_repo, tmp_path):
        """Should commit successfully."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance

        mock_commit = MagicMock()
        mock_commit.hexsha = "abc123def456"
        mock_repo_instance.index.commit.return_value = mock_commit
        mock_repo_instance.untracked_files = []
        mock_repo_instance.index.diff.return_value = []

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_commit.invoke({"message": "Test commit message"})

            assert "Committed successfully" in result
            assert "abc123" in result


class TestGitPush:
    """Tests for git_push tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_push.invoke({})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_pushes_successfully(self, mock_repo, tmp_path):
        """Should push successfully."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.head.is_detached = False
        mock_repo_instance.active_branch.name = "main"
        mock_repo_instance.active_branch.tracking_branch.return_value = None

        mock_remote = MagicMock()
        mock_remote.name = "origin"
        mock_info = [MagicMock()]
        mock_info[0].flags = 1  # Indicates push happened
        mock_remote.push.return_value = mock_info

        # Create a mock remotes object that supports both iteration and indexing
        mock_remotes = MagicMock()
        mock_remotes.__iter__ = lambda self: iter([mock_remote])
        mock_remotes.__getitem__ = lambda self, key: mock_remote
        mock_repo_instance.remotes = mock_remotes

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_push.invoke({})

            assert "successfully" in result.lower() or "up-to-date" in result.lower()

    @patch("cast.tools.git.git.Repo")
    def test_returns_error_for_missing_remote(self, mock_repo, tmp_path):
        """Should return error for missing remote."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance

        mock_repo_instance.remotes = []
        mock_repo_instance.head.is_detached = False

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_push.invoke({"remote": "nonexistent"})

            assert "not found" in result.lower() or "error" in result.lower()


class TestGitLog:
    """Tests for git_log tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_log.invoke({})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_shows_commit_history(self, mock_repo, tmp_path):
        """Should show commit history."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance

        mock_commit = MagicMock()
        mock_commit.hexsha = "abc123def456789"
        mock_commit.author.name = "Test Author"
        mock_commit.author.email = "test@example.com"
        mock_commit.message = "Test commit message"
        mock_commit.committed_datetime = MagicMock()
        mock_commit.committed_datetime.strftime.return_value = "2024-01-01 12:00:00"

        mock_repo_instance.iter_commits.return_value = [mock_commit]

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_log.invoke({})

            assert "abc123" in result or "Test Author" in result

    @patch("cast.tools.git.git.Repo")
    def test_returns_message_for_no_commits(self, mock_repo, tmp_path):
        """Should return message for repo with no commits."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.iter_commits.return_value = []

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_log.invoke({})

            assert "No commits" in result


class TestGitDiff:
    """Tests for git_diff tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_diff.invoke({})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_returns_no_changes_when_clean(self, mock_repo, tmp_path):
        """Should return message for clean working tree."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.git.diff.return_value = ""

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_diff.invoke({})

            assert "No changes" in result

    @patch("cast.tools.git.git.Repo")
    def test_shows_changes_for_modified_file(self, mock_repo, tmp_path):
        """Should show changes for modified file."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.git.diff.return_value = "diff --git a/file.txt b/file.txt\n-old\n+new"

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_diff.invoke({})

            assert "diff" in result or "file.txt" in result


class TestGitAdd:
    """Tests for git_add tool."""

    def test_returns_error_for_non_git_directory(self, tmp_path):
        """Should return error for non-Git directory."""
        result = git_add.invoke({})

        assert "Not a Git repository" in result

    @patch("cast.tools.git.git.Repo")
    def test_stages_specific_files(self, mock_repo, tmp_path):
        """Should stage specific files."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_add.invoke({"files": ["file1.txt", "file2.txt"]})

            mock_repo_instance.index.add.assert_called_once()

    @patch("cast.tools.git.git.Repo")
    def test_stages_all_files_when_none_specified(self, mock_repo, tmp_path):
        """Should stage all non-ignored files when none specified."""
        mock_repo_instance = MagicMock()
        mock_repo.return_value = mock_repo_instance
        mock_repo_instance.untracked_files = ["new.txt"]
        mock_repo_instance.index.diff.return_value = []

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        with patch.dict(os.environ, {"CAST_AGENT_DIR": str(tmp_path)}):
            result = git_add.invoke({})

            assert "Staged" in result or "staged" in result.lower()