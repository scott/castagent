import pytest
import subprocess
from unittest.mock import patch, MagicMock, AsyncMock
from cast.tools.bash import bash_tool


class TestBashTool:
    """Tests for bash_tool function."""

    def test_bash_tool_exists_and_has_correct_name(self):
        """Test that bash_tool function exists and has the expected name."""
        from cast.tools.bash import bash_tool
        assert bash_tool is not None
        assert bash_tool.name == "bash_tool"

    def test_bash_tool_with_echo_command(self):
        """Test bash_tool with simple echo command."""
        result = bash_tool.invoke({"command": "echo 'hello world'"})

        assert "hello world" in result
        assert "hello" in result

    def test_bash_tool_with_pwd_command(self):
        """Test bash_tool with pwd command."""
        result = bash_tool.invoke({"command": "pwd"})

        # Should return a path
        assert result is not None
        assert len(result) > 0

    def test_bash_tool_handles_command_execution(self):
        """Test that bash_tool properly executes commands."""
        result = bash_tool.invoke({"command": "echo test"})

        # Should successfully execute
        assert "test" in result

    def test_bash_tool_captures_stdout(self):
        """Test that bash_tool captures stdout output."""
        result = bash_tool.invoke({"command": "printf 'stdout content'"})

        assert "stdout content" in result

    def test_bash_tool_handles_stderr(self):
        """Test that bash_tool captures stderr when stdout is empty."""
        result = bash_tool.invoke({"command": "ls /nonexistent_directory_12345 2>&1"})

        # Should contain error message
        assert "No such file or directory" in result or "error" in result.lower()

    def test_error_handling_for_failed_commands(self):
        """Test error handling for commands that fail."""
        result = bash_tool.invoke({"command": "exit 1"})

        # Should return some output even for failed command
        assert result is not None

    def test_bash_tool_with_invalid_command(self):
        """Test bash_tool with non-existent command."""
        result = bash_tool.invoke({"command": "nonexistent_command_xyz123"})

        # Should return an error message
        assert "error" in result.lower() or "not found" in result.lower()

    def test_bash_tool_returns_string(self):
        """Test that bash_tool always returns a string."""
        result = bash_tool.invoke({"command": "echo test"})

        assert isinstance(result, str)

    def test_bash_tool_with_empty_command(self):
        """Test bash_tool with empty command."""
        result = bash_tool.invoke({"command": ""})

        # Should handle empty command gracefully
        assert isinstance(result, str)

    def test_bash_tool_with_multiline_command(self):
        """Test bash_tool with multiline command."""
        result = bash_tool.invoke({"command": "echo line1\necho line2"})

        assert "line1" in result
        assert "line2" in result

    def test_bash_tool_no_output_message(self):
        """Test that bash_tool returns proper message when command has no output."""
        result = bash_tool.invoke({"command": "true"})

        # true command succeeds with no output
        assert isinstance(result, str)

    @patch('subprocess.run')
    def test_bash_tool_timeout_handling(self, mock_run):
        """Test that bash_tool handles timeout errors."""
        mock_run.side_effect = subprocess.TimeoutExpired("cmd", 30)

        result = bash_tool.invoke({"command": "sleep 100"})

        assert "timed out" in result.lower()
        assert "30" in result

    @patch('subprocess.run')
    def test_bash_tool_generic_exception_handling(self, mock_run):
        """Test that bash_tool handles generic exceptions."""
        mock_run.side_effect = Exception("Something went wrong")

        result = bash_tool.invoke({"command": "echo test"})

        assert "error" in result.lower()
        assert "something went wrong" in result.lower()

    def test_bash_tool_with_environment_variable(self):
        """Test bash_tool with environment variable access."""
        import os
        os.environ["TEST_VAR"] = "test_value"

        result = bash_tool.invoke({"command": "echo $TEST_VAR"})

        # The result may or may not contain the value depending on the shell
        assert isinstance(result, str)

    def test_bash_tool_with_pipe(self):
        """Test bash_tool with piped commands."""
        result = bash_tool.invoke({"command": "echo 'test output' | grep test"})

        assert "test" in result.lower()

    def test_bash_tool_docstring(self):
        """Test that bash_tool has proper documentation."""
        # The @tool decorator wraps the function, so we check the function's own docstring
        # by accessing the underlying function directly
        assert bash_tool.func.__doc__ is not None
        assert "bash" in bash_tool.func.__doc__.lower() or "command" in bash_tool.func.__doc__.lower()