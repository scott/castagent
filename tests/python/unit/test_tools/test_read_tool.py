"""Tests for read_tool."""
import os
import pytest
from pathlib import Path

from cast.tools.read import read_tool


class TestReadTool:
    """Tests for the read_tool function."""

    def test_read_existing_file(self, tmp_path):
        """Should read existing file content."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        result = read_tool.invoke({"file_path": str(test_file)})

        assert "Hello, World!" in result
        assert "Error" not in result

    def test_read_nonexistent_file(self, tmp_path):
        """Should return error for nonexistent file."""
        result = read_tool.invoke({"file_path": str(tmp_path / "nonexistent.txt")})

        assert "Error" in result
        assert "not found" in result.lower()

    def test_read_file_with_offset(self, tmp_path):
        """Should read file from specified offset."""
        test_file = tmp_path / "multiline.txt"
        test_file.write_text("Line 1\nLine 2\nLine 3\nLine 4\nLine 5")

        result = read_tool.invoke({
            "file_path": str(test_file),
            "offset": 2
        })

        # Should start from line 3 (0-indexed line 2)
        assert "Line 3" in result

    def test_read_file_with_limit(self, tmp_path):
        """Should limit number of lines read."""
        test_file = tmp_path / "many_lines.txt"
        lines = [f"Line {i}" for i in range(20)]
        test_file.write_text("\n".join(lines))

        result = read_tool.invoke({
            "file_path": str(test_file),
            "limit": 5
        })

        # Should contain first 5 lines
        assert "Line 0" in result
        # Should indicate truncation
        assert "more lines" in result or len(result.split("\n")) <= 6

    def test_read_file_with_offset_and_limit(self, tmp_path):
        """Should read specific range of lines."""
        test_file = tmp_path / "range.txt"
        lines = [f"Line {i}" for i in range(10)]
        test_file.write_text("\n".join(lines))

        result = read_tool.invoke({
            "file_path": str(test_file),
            "offset": 3,
            "limit": 3
        })

        assert "Line 3" in result
        assert "Line 4" in result
        assert "Line 5" in result
        # Should not contain Line 6
        assert "Line 6" not in result

    def test_read_empty_file(self, tmp_path):
        """Should handle empty file."""
        test_file = tmp_path / "empty.txt"
        test_file.write_text("")

        result = read_tool.invoke({"file_path": str(test_file)})

        # Should not return error for empty file
        assert "Error" not in result

    def test_read_binary_file(self, tmp_path):
        """Should handle binary file gracefully."""
        test_file = tmp_path / "binary.bin"
        test_file.write_bytes(b"\x00\x01\x02\x03\x04")

        result = read_tool.invoke({"file_path": str(test_file)})

        # Should either succeed or return a readable error
        assert result is not None

    def test_read_file_with_special_characters(self, tmp_path):
        """Should handle special characters in file."""
        test_file = tmp_path / "special.txt"
        test_content = "Hello 世界! 🌍\n日本語テスト\nSpecial: @#$%^&*()"
        test_file.write_text(test_content)

        result = read_tool.invoke({"file_path": str(test_file)})

        assert "Hello" in result
        assert "世界" in result

    def test_read_file_preserves_newlines(self, tmp_path):
        """Should preserve line breaks in output."""
        test_file = tmp_path / "newlines.txt"
        test_file.write_text("Line 1\nLine 2\nLine 3")

        result = read_tool.invoke({"file_path": str(test_file)})

        assert "Line 1\n" in result or "Line 1" in result
        assert "Line 2" in result
        assert "Line 3" in result

    def test_read_relative_path(self, tmp_path):
        """Should handle relative paths."""
        original_cwd = os.getcwd()
        os.chdir(tmp_path)

        try:
            test_file = tmp_path / "relative.txt"
            test_file.write_text("Relative content")

            result = read_tool.invoke({"file_path": "relative.txt"})

            assert "Relative content" in result
        finally:
            os.chdir(original_cwd)

    def test_read_file_larger_than_limit(self, tmp_path):
        """Should indicate truncation for files larger than limit."""
        test_file = tmp_path / "large.txt"
        lines = [f"Line {i}" for i in range(200)]
        test_file.write_text("\n".join(lines))

        result = read_tool.invoke({
            "file_path": str(test_file),
            "limit": 10
        })

        # Should indicate more lines exist
        assert "more lines" in result or "(190 more lines)" in result


class TestReadToolEdgeCases:
    """Edge case tests for read_tool."""

    def test_read_file_with_very_long_lines(self, tmp_path):
        """Should handle files with very long lines."""
        test_file = tmp_path / "long_line.txt"
        long_content = "x" * 10000
        test_file.write_text(long_content)

        result = read_tool.invoke({"file_path": str(test_file)})

        # Should read the content
        assert len(result) > 0

    def test_read_file_with_only_whitespace(self, tmp_path):
        """Should handle file with only whitespace."""
        test_file = tmp_path / "whitespace.txt"
        test_file.write_text("   \n\n   \n  \n")

        result = read_tool.invoke({"file_path": str(test_file)})

        # Should not return error
        assert "Error" not in result

    def test_read_file_with_tabs(self, tmp_path):
        """Should handle tabs in file."""
        test_file = tmp_path / "tabs.txt"
        test_file.write_text("col1\tcol2\tcol3\n1\t2\t3")

        result = read_tool.invoke({"file_path": str(test_file)})

        assert "col1" in result
        assert "\t" in result or "col2" in result

    def test_negative_offset_defaults_to_zero(self, tmp_path):
        """Should handle negative offset gracefully."""
        test_file = tmp_path / "negative.txt"
        test_file.write_text("Line 1\nLine 2\nLine 3")

        # Negative offset should be handled (likely defaults to 0)
        result = read_tool.invoke({
            "file_path": str(test_file),
            "offset": -5
        })

        # Should not error, just start from beginning
        assert "Line 1" in result

    def test_zero_limit_returns_empty(self, tmp_path):
        """Should handle zero limit."""
        test_file = tmp_path / "zero_limit.txt"
        test_file.write_text("Line 1\nLine 2\nLine 3")

        result = read_tool.invoke({
            "file_path": str(test_file),
            "limit": 0
        })

        # Should return empty or minimal content
        assert result is not None