"""Tests for write_file."""

from pathlib import Path

import pytest
from cast.harness.permissions import PermissionGate, guard_tool
from cast.tools.files import write_file


def _agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    agent = tmp_path / "agent"
    agent.mkdir()
    monkeypatch.setenv("CAST_AGENT_PATH", str(agent))
    return agent


class TestWriteFile:
    def test_writes_a_new_file_and_creates_parents(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        result = write_file.invoke({
            "file_path": "src/main.py",
            "content": "print(1)\n",
        })
        assert result == "Wrote 9 bytes to src/main.py"
        assert (agent / "src" / "main.py").read_text(encoding="utf-8") == "print(1)\n"

    def test_replaces_an_existing_file(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "note.txt"
        target.write_text("old")
        result = write_file.invoke({"file_path": "note.txt", "content": "new"})
        assert result.startswith("Wrote ")
        assert target.read_text(encoding="utf-8") == "new"

    def test_absolute_path_inside_the_workspace(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        target = agent / "inside.txt"
        result = write_file.invoke({"file_path": str(target), "content": "ok"})
        assert "Error" not in result
        assert target.read_text(encoding="utf-8") == "ok"

    def test_refuses_parent_traversal(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        result = write_file.invoke({"file_path": "../owned.txt", "content": "x"})
        assert result.startswith("Error:")
        assert "outside" in result
        assert not (tmp_path / "owned.txt").exists()
        assert list(agent.iterdir()) == []

    def test_refuses_an_absolute_path_outside_the_workspace(self, tmp_path, monkeypatch):
        _agent(tmp_path, monkeypatch)
        outside = tmp_path / "owned.txt"
        result = write_file.invoke({"file_path": str(outside), "content": "x"})
        assert result.startswith("Error:")
        assert "outside" in result
        assert not outside.exists()

    def test_refuses_a_symlink_leaf(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        outside = tmp_path / "secret.txt"
        outside.write_text("safe")
        (agent / "link").symlink_to(outside)
        result = write_file.invoke({"file_path": "link", "content": "pwn"})
        assert "symlink" in result
        assert outside.read_text(encoding="utf-8") == "safe"

    def test_refuses_a_symlink_directory_that_leaves_the_workspace(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        outside = tmp_path / "outside"
        outside.mkdir()
        (agent / "escape").symlink_to(outside)
        result = write_file.invoke({"file_path": "escape/pwned.txt", "content": "x"})
        assert result.startswith("Error:")
        assert "outside" in result
        assert not (outside / "pwned.txt").exists()

    def test_follows_a_symlink_that_stays_inside_the_workspace(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        real = agent / "real"
        real.mkdir()
        (agent / "alias").symlink_to(real)
        result = write_file.invoke({"file_path": "alias/note.txt", "content": "inside"})
        assert result.startswith("Wrote ")
        assert (real / "note.txt").read_text(encoding="utf-8") == "inside"

    def test_requires_an_agent_workspace(self, tmp_path, monkeypatch):
        monkeypatch.delenv("CAST_AGENT_PATH", raising=False)
        result = write_file.invoke({"file_path": "note.txt", "content": "x"})
        assert "CAST_AGENT_PATH" in result
        assert not (tmp_path / "note.txt").exists()

    def test_rejects_a_null_byte(self, tmp_path, monkeypatch):
        _agent(tmp_path, monkeypatch)
        result = write_file.invoke({"file_path": "bad\x00name", "content": "x"})
        assert result.startswith("Error:")

    def test_scrubs_provider_keys_in_notes(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        result = write_file.invoke({
            "file_path": "memory/notes.md",
            "content": "remember this permanently sk-or-v1-dummy\nfruit is quince\n",
        })
        assert result.startswith("Wrote ")
        text = (agent / "memory" / "notes.md").read_text(encoding="utf-8")
        assert "sk-or-v1-dummy" not in text
        assert "[REDACTED]" in text
        assert "quince" in text

    def test_does_not_scrub_a_project_file(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        content = "token = 'sk-or-v1-dummy'\n"
        write_file.invoke({"file_path": "config.py", "content": content})
        assert (agent / "config.py").read_text(encoding="utf-8") == content

    def test_default_permission_does_not_write(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        tool = guard_tool(write_file, "write_file", PermissionGate({}))
        result = tool.invoke({"file_path": "note.txt", "content": "secret"})
        assert "Approval is required" in result
        assert not (agent / "note.txt").exists()

    def test_explicit_allow_writes(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path, monkeypatch)
        tool = guard_tool(
            write_file,
            "write_file",
            PermissionGate({"write_file": "always-allow"}),
        )
        result = tool.invoke({"file_path": "note.txt", "content": "ok"})
        assert result.startswith("Wrote ")
        assert (agent / "note.txt").read_text(encoding="utf-8") == "ok"

    def test_tool_name_matches_the_permission_name(self):
        assert write_file.name == "write_file"
