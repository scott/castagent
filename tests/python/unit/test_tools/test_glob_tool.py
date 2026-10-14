"""Tests for glob_tool."""
import os
import pytest
from pathlib import Path

from cast.tools.glob import glob_tool


class TestGlobTool:
    """Tests for the glob_tool function."""

    def test_glob_finds_matching_files(self, tmp_path):
        """Should find files matching the pattern."""
        # Create test files
        (tmp_path / "test1.txt").write_text("content1")
        (tmp_path / "test2.txt").write_text("content2")
        (tmp_path / "other.txt").write_text("content3")

        # Change to temp directory
        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*.txt"})

            # Should find txt files
            assert "test1.txt" in result
            assert "test2.txt" in result
            assert "other.txt" in result
        finally:
            os.chdir(original_cwd)

    def test_glob_returns_no_files_for_nonexistent_pattern(self, tmp_path):
        """Should return message for non-matching pattern."""
        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*.nonexistent"})

            assert "No files found" in result
        finally:
            os.chdir(original_cwd)

    def test_glob_recursive_pattern(self, tmp_path):
        """Should handle recursive patterns."""
        # Create nested directories
        (tmp_path / "dir1").mkdir()
        (tmp_path / "dir1" / "file1.txt").write_text("content")
        (tmp_path / "dir2").mkdir()
        (tmp_path / "dir2" / "file2.txt").write_text("content")
        (tmp_path / "root.txt").write_text("content")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "**/*.txt"})

            # Should find all txt files recursively
            assert "dir1" in result or "file1.txt" in result
            assert "dir2" in result or "file2.txt" in result
        finally:
            os.chdir(original_cwd)

    def test_glob_with_specific_directory(self, tmp_path):
        """Should glob files in specific directory."""
        (tmp_path / "subdir").mkdir()
        (tmp_path / "subdir" / "data.csv").write_text("data")
        (tmp_path / "other.csv").write_text("data")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "subdir/*.csv"})

            assert "data.csv" in result
            assert "other.csv" not in result
        finally:
            os.chdir(original_cwd)

    def test_glob_handles_multiple_extensions(self, tmp_path):
        """Should handle patterns with multiple file types."""
        (tmp_path / "file1.py").write_text("python")
        (tmp_path / "file2.py").write_text("python")
        (tmp_path / "file3.js").write_text("javascript")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*.py"})

            assert "file1.py" in result
            assert "file2.py" in result
            assert "file3.js" not in result
        finally:
            os.chdir(original_cwd)

    def test_glob_with_hidden_files(self, tmp_path):
        """Should handle hidden files."""
        (tmp_path / ".hidden").write_text("hidden content")
        (tmp_path / "visible.txt").write_text("visible content")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": ".*"})

            # Should find hidden files
            assert ".hidden" in result or "hidden" in result.lower()
        finally:
            os.chdir(original_cwd)


class TestGlobToolEdgeCases:
    """Edge case tests for glob_tool."""

    def test_glob_empty_directory(self, tmp_path):
        """Should handle empty directory."""
        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*"})

            assert "No files found" in result
        finally:
            os.chdir(original_cwd)

    def test_glob_with_special_characters_in_filename(self, tmp_path):
        """Should handle special characters in filenames."""
        (tmp_path / "file with spaces.txt").write_text("content")
        (tmp_path / "file-with-dashes.txt").write_text("content")
        (tmp_path / "file_with_underscores.txt").write_text("content")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*.txt"})

            # Should find all files
            assert "file with spaces.txt" in result or "spaces" in result
        finally:
            os.chdir(original_cwd)

    def test_glob_unicode_filenames(self, tmp_path):
        """Should handle unicode filenames."""
        (tmp_path / "日本語.txt").write_text("japanese")
        (tmp_path / "中文.txt").write_text("chinese")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "*.txt"})

            assert "日本語" in result or "japanese" in result.lower()
        finally:
            os.chdir(original_cwd)

    def test_glob_with_absolute_path(self, tmp_path):
        """Should handle absolute paths."""
        (tmp_path / "test.txt").write_text("content")

        result = glob_tool.invoke({"pattern": str(tmp_path / "*.txt")})

        assert "test.txt" in result

    def test_glob_error_handling(self, tmp_path):
        """Should handle errors gracefully."""
        # Invalid pattern might cause issues
        result = glob_tool.invoke({"pattern": "[invalid"})

        # Should either return error or empty result
        assert result is not None

    def test_glob_directory_pattern(self, tmp_path):
        """Should find directories matching pattern."""
        (tmp_path / "dir1").mkdir()
        (tmp_path / "dir2").mkdir()
        (tmp_path / "file.txt").write_text("content")

        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            result = glob_tool.invoke({"pattern": "dir*"})

            # Should find directories
            assert "dir1" in result or "dir2" in result
        finally:
            os.chdir(original_cwd)

    def test_relative_pattern_uses_agent_directory(self, tmp_path, monkeypatch):
        """memory/*.md is matched inside CAST_AGENT_PATH."""
        agent = tmp_path / "agent"
        notes = agent / "memory" / "notes.md"
        notes.parent.mkdir(parents=True)
        notes.write_text("QUINCE-BB2\n")
        other = tmp_path / "elsewhere"
        other.mkdir()
        monkeypatch.setenv("CAST_AGENT_PATH", str(agent))
        monkeypatch.chdir(other)

        result = glob_tool.invoke({"pattern": "memory/*.md"})

        assert "memory/notes.md" in result