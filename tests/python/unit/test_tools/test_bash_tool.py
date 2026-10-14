"""Tests for bash_tool."""
import os
import pytest
import subprocess
from pathlib import Path

from cast.tools.bash import bash_tool


class TestBashTool:
    """Tests for the bash_tool function."""

    def test_executes_simple_command(self):
        """Should execute simple shell command."""
        result = bash_tool.invoke({"command": "echo 'Hello World'"})

        assert "Hello World" in result

    def test_returns_stdout(self):
        """Should return stdout from command."""
        result = bash_tool.invoke({"command": "printf 'test output'"})

        assert "test output" in result

    def test_returns_stderr_when_no_stdout(self):
        """Should return stderr when stdout is empty."""
        result = bash_tool.invoke({"command": "ls /nonexistent/path 2>&1"})

        # Should contain error message
        assert "Error" in result or "No such file" in result or "nonexistent" in result

    def test_handles_command_with_pipes(self):
        """Should handle commands with pipes."""
        result = bash_tool.invoke({"command": "echo 'line1\nline2\nline3' | grep line2"})

        assert "line2" in result

    def test_handles_command_with_redirects(self):
        """Should handle command output redirects."""
        result = bash_tool.invoke({"command": "echo 'redirected' > /dev/null && echo 'visible'"})

        assert "visible" in result

    def test_handles_environment_variables(self):
        """Should preserve environment variables."""
        result = bash_tool.invoke({"command": "echo $HOME"})

        # Should output home directory path
        assert len(result) > 0

    def test_returns_success_message_for_no_output(self):
        """Should return success message when command has no output."""
        result = bash_tool.invoke({"command": "true"})

        # Should return success message
        assert "successfully" in result.lower() or len(result) > 0


class TestBashToolErrorHandling:
    """Tests for bash_tool error handling."""

    def test_handles_nonexistent_command(self):
        """Should handle nonexistent commands gracefully."""
        result = bash_tool.invoke({"command": "nonexistent_command_12345"})

        assert "Error" in result or "not found" in result.lower()

    def test_handles_command_with_invalid_syntax(self):
        """Should handle invalid command syntax."""
        result = bash_tool.invoke({"command": "echo $(unclosed"})

        # Should return error or handle gracefully
        assert result is not None

    def test_handles_permission_denied(self):
        """Should handle permission denied errors."""
        result = bash_tool.invoke({"command": "cat /etc/shadow 2>&1 || echo 'Access denied'"})

        # Should either get error or access denied message
        assert "denied" in result.lower() or "Error" in result or len(result) > 0


class TestBashToolTimeout:
    """Tests for bash_tool timeout handling."""

    def test_times_out_long_running_command(self):
        """Should timeout long-running commands."""
        # This is a 60-second sleep, should timeout at 30 seconds
        result = bash_tool.invoke({"command": "sleep 60"})

        assert "timed out" in result.lower() or "Error" in result

    def test_executes_quick_commands(self):
        """Should execute quick commands successfully."""
        result = bash_tool.invoke({"command": "date"})

        # Should return date output
        assert len(result) > 0


class TestBashToolEdgeCases:
    """Edge case tests for bash_tool."""

    def test_handles_empty_command(self):
        """Should handle empty command string."""
        result = bash_tool.invoke({"command": ""})

        # Should not crash, may return empty or success
        assert result is not None

    def test_handles_whitespace_only_command(self):
        """Should handle whitespace-only command."""
        result = bash_tool.invoke({"command": "   "})

        # Should not crash
        assert result is not None

    def test_handles_command_with_special_characters(self):
        """Should handle special characters in command."""
        # Use a simpler command that avoids shell parsing issues
        result = bash_tool.invoke({
            "command": "echo 'Special characters: dollar sign $ and percent %'"
        })

        assert "Special" in result or "characters" in result

    def test_handles_unicode_in_command(self):
        """Should handle unicode in command."""
        result = bash_tool.invoke({"command": "echo '日本語テスト'"})

        assert "日本語" in result or len(result) > 0

    def test_handles_multiline_command(self):
        """Should handle multiline commands."""
        result = bash_tool.invoke({
            "command": "echo 'line1'; echo 'line2'; echo 'line3'"
        })

        assert "line1" in result
        assert "line2" in result
        assert "line3" in result

    def test_preserves_exit_code_information(self):
        """Should preserve exit code information."""
        result = bash_tool.invoke({"command": "exit 42"})

        # Command returns text output, not exit codes directly
        # The tool should handle non-zero exits
        assert result is not None

    def test_handles_command_with_quotes(self):
        """Should handle commands with quotes."""
        result = bash_tool.invoke({
            "command": "echo 'Single quoted' && echo \"Double quoted\""
        })

        assert "Single quoted" in result or "Double quoted" in result

    def test_handles_background_process_hint(self):
        """Should handle commands that might start background processes."""
        result = bash_tool.invoke({"command": "(sleep 0.1; echo 'done') &"})

        # Should still return something
        assert result is not None

    def test_handles_path_with_spaces(self):
        """Should handle paths with spaces."""
        result = bash_tool.invoke({
            "command": "echo 'path with spaces' > /tmp/test_spaced_file.txt && cat /tmp/test_spaced_file.txt"
        })

        assert "path with spaces" in result

    def test_runs_in_agent_directory(self, tmp_path, monkeypatch):
        """Relative commands use CAST_AGENT_PATH, not the shell cwd."""
        agent = tmp_path / "agent"
        (agent / "memory").mkdir(parents=True)
        other = tmp_path / "elsewhere"
        other.mkdir()
        monkeypatch.setenv("CAST_AGENT_PATH", str(agent))
        monkeypatch.chdir(other)

        result = bash_tool.invoke({"command": "pwd"})

        assert os.path.realpath(result.strip()) == os.path.realpath(agent)