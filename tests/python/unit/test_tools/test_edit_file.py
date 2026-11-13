"""Tests for edit_file."""

from pathlib import Path

import pytest
from cast.harness.permissions import PermissionGate, guard_tool
from cast.tools.files import edit_file


def _agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    agent = tmp_path / "agent"
    agent.mkdir()
    monkeypatch.setenv("CAST_AGENT_PATH", str(agent))
    return agent


class TestEditFile:
    def test_replaces_one_exact_occurrence(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        target.write_text("def greet():\n    return 'hi'\n", encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "main.py",
            "old_string": "return 'hi'",
            "new_string": "return 'hello'",
        })
        assert result == "Edited main.py"
        assert target.read_text(encoding="utf-8") == "def greet():\n    return 'hello'\n"

    def test_missing_text_leaves_the_file_unchanged(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        original = "alpha\n"
        target.write_text(original, encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "main.py",
            "old_string": "beta",
            "new_string": "gamma",
        })
        assert "not found" in result
        assert target.read_text(encoding="utf-8") == original

    def test_repeated_text_leaves_the_file_unchanged(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        original = "value = 1\nvalue = 1\n"
        target.write_text(original, encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "main.py",
            "old_string": "value = 1",
            "new_string": "value = 2",
        })
        assert "2 times" in result
        assert "not changed" in result
        assert target.read_text(encoding="utf-8") == original

    def test_empty_old_string_does_not_change_the_file(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        target.write_text("keep\n", encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "main.py",
            "old_string": "",
            "new_string": "x",
        })
        assert result.startswith("Error:")
        assert target.read_text(encoding="utf-8") == "keep\n"

    def test_identical_strings_do_not_change_the_file(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        target.write_text("same\n", encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "main.py",
            "old_string": "same",
            "new_string": "same",
        })
        assert "same" in result
        assert "not changed" in result
        assert target.read_text(encoding="utf-8") == "same\n"

    def test_missing_file_is_not_created(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        result = edit_file.invoke({
            "file_path": "missing.py",
            "old_string": "a",
            "new_string": "b",
        })
        assert "not found" in result.lower()
        assert not (agent / "missing.py").exists()

    def test_refuses_a_path_outside_the_workspace(self, tmp_path, monkeypatch):
        _agent(tmp_path, monkeypatch)
        outside = tmp_path / "outside.txt"
        outside.write_text("safe\n", encoding="utf-8")
        result = edit_file.invoke({
            "file_path": str(outside),
            "old_string": "safe",
            "new_string": "pwn",
        })
        assert "outside" in result
        assert outside.read_text(encoding="utf-8") == "safe\n"

    def test_refuses_a_symlink(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        outside = tmp_path / "secret.txt"
        outside.write_text("safe\n", encoding="utf-8")
        (agent / "link").symlink_to(outside)
        result = edit_file.invoke({
            "file_path": "link",
            "old_string": "safe",
            "new_string": "pwn",
        })
        assert "symlink" in result
        assert outside.read_text(encoding="utf-8") == "safe\n"

    def test_scrubs_notes_after_the_edit(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text("fruit is quince\n", encoding="utf-8")
        result = edit_file.invoke({
            "file_path": "memory/notes.md",
            "old_string": "fruit is quince",
            "new_string": "key sk-or-v1-dummy",
        })
        assert result == "Edited memory/notes.md"
        text = notes.read_text(encoding="utf-8")
        assert "sk-or-v1-dummy" not in text
        assert "[REDACTED]" in text

    def test_default_permission_does_not_edit(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "main.py"
        target.write_text("keep\n", encoding="utf-8")
        tool = guard_tool(edit_file, "edit_file", PermissionGate({}))
        result = tool.invoke({
            "file_path": "main.py",
            "old_string": "keep",
            "new_string": "changed",
        })
        assert "Approval is required" in result
        assert target.read_text(encoding="utf-8") == "keep\n"

    def test_tool_name_matches_the_permission_name(self):
        assert edit_file.name == "edit_file"
