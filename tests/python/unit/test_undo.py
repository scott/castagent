"""Tests for cast.undo — the user-facing undo/redo surface.

These tests build on cast.versioning and exercise the redo stack,
history navigation, and clear-on-new-edit semantics.
"""
import json
import tempfile
from pathlib import Path

import pytest
import yaml

from cast import versioning
from cast import undo


@pytest.fixture
def temp_agents_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(versioning, "AGENTS_DIR", tmp_path)
    monkeypatch.setattr(undo, "AGENTS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def test_agent(temp_agents_dir):
    agent_name = "undo-test-agent"
    agent_path = temp_agents_dir / agent_name
    agent_path.mkdir(parents=True, exist_ok=True)
    (agent_path / "mcp").mkdir(exist_ok=True)
    (agent_path / "tools").mkdir(exist_ok=True)
    config = {
        "name": agent_name,
        "version": "0.0",
        "description": "Agent for undo/redo tests",
        "brain": {"model": "test-model", "instructions_file": "instructions.md"},
        "tools": {"builtin": ["bash"], "mcp": [], "custom": []},
    }
    with open(agent_path / "agent.yaml", "w") as f:
        yaml.dump(config, f)
    with open(agent_path / "instructions.md", "w") as f:
        f.write("# Initial\n\nYou are a helpful assistant.\n")
    return agent_name


def _set_instructions(agent_path: Path, text: str) -> None:
    (agent_path / "instructions.md").write_text(text)


def _read_instructions(agent_path: Path) -> str:
    return (agent_path / "instructions.md").read_text()


class TestCanUndoRedo:
    def test_can_undo_false_when_no_changes(self, test_agent, temp_agents_dir):
        assert undo.can_undo(test_agent) is False
        assert undo.can_redo(test_agent) is False

    def test_can_undo_true_after_one_change(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="initial")
        assert undo.can_undo(test_agent) is True
        assert undo.can_redo(test_agent) is False

    def test_can_redo_true_after_undo(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="initial")
        _set_instructions(temp_agents_dir / test_agent, "# v2 content\n")
        versioning.create_version(test_agent, source="builder", message="v2")
        undo.undo(test_agent)
        assert undo.can_redo(test_agent) is True


class TestUndo:
    def test_undo_restores_previous_state(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2 content\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        undone = undo.undo(test_agent)
        assert len(undone) == 1
        assert _read_instructions(temp_agents_dir / test_agent) == "# Initial\n\nYou are a helpful assistant.\n"

    def test_undo_multiple_steps(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")
        _set_instructions(temp_agents_dir / test_agent, "# v3\n")
        versioning.create_version(test_agent, source="builder", message="v3")

        undone = undo.undo(test_agent, steps=2)
        assert len(undone) == 2
        assert _read_instructions(temp_agents_dir / test_agent) == "# Initial\n\nYou are a helpful assistant.\n"

    def test_undo_pushed_to_redo_stack(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        undo.undo(test_agent)
        stack = undo.get_redo_stack(test_agent)
        assert len(stack) == 1
        # The top of the stack is the entry we just undid (id=2)
        assert stack[0].id == 2

    def test_undo_with_nothing_to_undo_raises(self, test_agent, temp_agents_dir):
        with pytest.raises(undo.UndoError):
            undo.undo(test_agent)

    def test_undo_steps_exceeds_history_raises(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        with pytest.raises(undo.UndoError):
            undo.undo(test_agent, steps=5)


class TestRedo:
    def test_redo_restores_undone_state(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2 content\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        undo.undo(test_agent)
        redone = undo.redo(test_agent)
        assert len(redone) == 1
        assert _read_instructions(temp_agents_dir / test_agent) == "# v2 content\n"

    def test_redo_with_empty_stack_raises(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        with pytest.raises(undo.UndoError):
            undo.redo(test_agent)

    def test_redo_clears_after_full_redo(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")
        _set_instructions(temp_agents_dir / test_agent, "# v3\n")
        versioning.create_version(test_agent, source="builder", message="v3")

        undo.undo(test_agent, steps=2)
        assert len(undo.get_redo_stack(test_agent)) == 2
        undo.redo(test_agent, steps=2)
        assert len(undo.get_redo_stack(test_agent)) == 0

    def test_new_edit_clears_redo_stack(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        undo.undo(test_agent)
        assert undo.can_redo(test_agent) is True

        # New edit should clear the redo stack
        _set_instructions(temp_agents_dir / test_agent, "# divergent\n")
        versioning.create_version(test_agent, source="builder", message="v3 new path")
        assert undo.can_redo(test_agent) is False


class TestUndoHistory:
    def test_get_undo_history_returns_newest_first(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        versioning.create_version(test_agent, source="builder", message="v2")
        versioning.create_version(test_agent, source="builder", message="v3")
        history = undo.get_undo_history(test_agent)
        assert [c.id for c in history] == [3, 2, 1]


def _write_config(agent_path: Path, config: dict) -> None:
    with open(agent_path / "agent.yaml", "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)


def _read_config(agent_path: Path) -> dict:
    with open(agent_path / "agent.yaml") as f:
        return yaml.safe_load(f)


class TestUndoLeavesUntrackedFiles:
    def test_undo_and_redo_keep_files_and_sections_outside_the_snapshot(
        self, test_agent, temp_agents_dir
    ):
        agent_path = temp_agents_dir / test_agent
        versioning.create_version(test_agent, source="create", message="v1")

        config = _read_config(agent_path)
        config["description"] = "updated description"
        _write_config(agent_path, config)
        _set_instructions(agent_path, "# v2 content\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        # Added after the snapshot. These paths are not in either tarball.
        (agent_path / "tools" / "keep.py").write_text("KEEPME\n")
        (agent_path / "skills" / "triage").mkdir(parents=True)
        (agent_path / "skills" / "triage" / "SKILL.md").write_text("# triage\n")
        (agent_path / "mcp" / "extra.yaml").write_text("server: extra\n")
        (agent_path / "memory").mkdir()
        (agent_path / "memory" / "config.yaml").write_text("memory: {}\n")
        (agent_path / "tests" / "cli").mkdir(parents=True)
        (agent_path / "tests" / "cli" / "test_agent.py").write_text("def test_ok():\n    pass\n")
        (agent_path / ".gitignore").write_text("node_modules\n")
        (agent_path / "README.md").write_text("# readme\n")
        (agent_path / "PROMPT.md").write_text("custom prompt\n")
        config = _read_config(agent_path)
        config["repository"] = {
            "remote": "origin",
            "url": "https://github.com/acme/bb2",
        }
        config["skills"] = [{"name": "triage", "description": "Sort mail"}]
        _write_config(agent_path, config)

        undo.undo(test_agent)

        assert (agent_path / "tools" / "keep.py").read_text() == "KEEPME\n"
        assert (agent_path / "skills" / "triage" / "SKILL.md").read_text() == "# triage\n"
        assert (agent_path / "mcp" / "extra.yaml").read_text() == "server: extra\n"
        assert (agent_path / "memory" / "config.yaml").read_text() == "memory: {}\n"
        assert (agent_path / "tests" / "cli" / "test_agent.py").is_file()
        assert (agent_path / ".gitignore").read_text() == "node_modules\n"
        assert (agent_path / "README.md").read_text() == "# readme\n"
        assert (agent_path / "PROMPT.md").read_text() == "custom prompt\n"
        restored = _read_config(agent_path)
        assert restored["description"] == "Agent for undo/redo tests"
        assert restored["repository"]["url"] == "https://github.com/acme/bb2"
        assert restored["skills"][0]["name"] == "triage"
        assert _read_instructions(agent_path) == "# Initial\n\nYou are a helpful assistant.\n"

        undo.redo(test_agent)

        assert (agent_path / "tools" / "keep.py").read_text() == "KEEPME\n"
        assert (agent_path / "skills" / "triage" / "SKILL.md").is_file()
        assert (agent_path / "mcp" / "extra.yaml").is_file()
        assert (agent_path / "memory" / "config.yaml").is_file()
        assert (agent_path / "tests" / "cli" / "test_agent.py").is_file()
        assert (agent_path / ".gitignore").is_file()
        assert (agent_path / "README.md").is_file()
        assert (agent_path / "PROMPT.md").read_text() == "custom prompt\n"
        redone = _read_config(agent_path)
        assert redone["description"] == "updated description"
        assert redone["repository"]["url"] == "https://github.com/acme/bb2"
        assert redone["skills"][0]["name"] == "triage"
        assert _read_instructions(agent_path) == "# v2 content\n"

    def test_undo_restores_tracked_tool_and_keeps_a_later_sibling(
        self, test_agent, temp_agents_dir
    ):
        agent_path = temp_agents_dir / test_agent
        (agent_path / "tools" / "tracked.py").write_text("v1\n")
        (agent_path / "mcp" / "gmail.yaml").write_text("v1\n")
        versioning.create_version(test_agent, source="create", message="v1")

        (agent_path / "tools" / "tracked.py").write_text("v2\n")
        (agent_path / "mcp" / "gmail.yaml").write_text("v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")

        (agent_path / "tools" / "keep.py").write_text("KEEPME\n")
        (agent_path / "mcp" / "extra.yaml").write_text("extra\n")

        undo.undo(test_agent)
        assert (agent_path / "tools" / "tracked.py").read_text() == "v1\n"
        assert (agent_path / "tools" / "keep.py").read_text() == "KEEPME\n"
        assert (agent_path / "mcp" / "gmail.yaml").read_text() == "v1\n"
        assert (agent_path / "mcp" / "extra.yaml").read_text() == "extra\n"

        undo.redo(test_agent)
        assert (agent_path / "tools" / "tracked.py").read_text() == "v2\n"
        assert (agent_path / "tools" / "keep.py").read_text() == "KEEPME\n"
        assert (agent_path / "mcp" / "gmail.yaml").read_text() == "v2\n"
        assert (agent_path / "mcp" / "extra.yaml").read_text() == "extra\n"

    def test_snapshot_repository_and_skills_are_restored(
        self, test_agent, temp_agents_dir
    ):
        agent_path = temp_agents_dir / test_agent
        config = _read_config(agent_path)
        config["repository"] = {"url": "https://github.com/acme/v1"}
        config["skills"] = [{"name": "v1"}]
        _write_config(agent_path, config)
        versioning.create_version(test_agent, source="create", message="v1")

        config = _read_config(agent_path)
        config["description"] = "updated description"
        config["repository"] = {"url": "https://github.com/acme/v2"}
        config["skills"] = [{"name": "v2"}]
        _write_config(agent_path, config)
        versioning.create_version(test_agent, source="builder", message="v2")

        undo.undo(test_agent)
        restored = _read_config(agent_path)
        assert restored["description"] == "Agent for undo/redo tests"
        assert restored["repository"]["url"] == "https://github.com/acme/v1"
        assert restored["skills"] == [{"name": "v1"}]

        undo.redo(test_agent)
        redone = _read_config(agent_path)
        assert redone["description"] == "updated description"
        assert redone["repository"]["url"] == "https://github.com/acme/v2"
        assert redone["skills"] == [{"name": "v2"}]


class TestClearRedoStack:
    def test_clear_drops_entries(self, test_agent, temp_agents_dir):
        versioning.create_version(test_agent, source="create", message="v1")
        _set_instructions(temp_agents_dir / test_agent, "# v2\n")
        versioning.create_version(test_agent, source="builder", message="v2")
        undo.undo(test_agent)
        assert len(undo.get_redo_stack(test_agent)) == 1
        undo.clear_redo_stack(test_agent)
        assert len(undo.get_redo_stack(test_agent)) == 0

    def test_clear_is_safe_when_no_changes(self, temp_agents_dir):
        # Should not raise
        undo.clear_redo_stack("nonexistent-agent")
