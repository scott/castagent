"""MemoryStore path warnings for cast dev.

The agent root is the path cast dev passes. A new memory/memory.db at that
root is expected, including when memory/config.yaml is already there.
"""

import os
import warnings
from pathlib import Path

import pytest

from cast.memory.store import MemoryStore


def _assert_no_user_warning(agent_path: Path) -> MemoryStore:
    with warnings.catch_warnings():
        warnings.simplefilter("error", UserWarning)
        return MemoryStore(agent_path, warn_on_new=True)


class TestMemoryStorePathWarning:
    def test_agent_root_with_existing_memory_dir_does_not_warn(self, tmp_path: Path):
        agent = tmp_path / "bb-summarizer"
        memory = agent / "memory"
        memory.mkdir(parents=True)
        (memory / "config.yaml").write_text("memory:\n  enabled: true\n")

        store = _assert_no_user_warning(agent)

        assert store.db_path == agent / "memory" / "memory.db"
        assert store.db_path.is_file()
        assert store.is_new is True

    def test_path_containing_memory_substring_does_not_warn(self, tmp_path: Path):
        agent = tmp_path / "memory-scratch" / "bb-summarizer"
        agent.parent.mkdir(parents=True)

        store = _assert_no_user_warning(agent)

        assert store.db_path == agent / "memory" / "memory.db"

    def test_agent_named_memory_does_not_warn(self, tmp_path: Path):
        agent = tmp_path / "agents" / "memory"
        agent.mkdir(parents=True)
        (agent / "agent.yaml").write_text("name: memory\n")

        store = _assert_no_user_warning(agent)

        assert store.db_path == agent / "memory" / "memory.db"

    def test_second_open_does_not_warn(self, tmp_path: Path):
        agent = tmp_path / "bb-summarizer"
        MemoryStore(agent, warn_on_new=False)

        store = _assert_no_user_warning(agent)

        assert store.is_new is False

    def test_memory_directory_still_warns(self, tmp_path: Path):
        memory_path = tmp_path / "agent" / "memory"
        memory_path.mkdir(parents=True)

        with pytest.warns(UserWarning, match="appears to be a memory directory"):
            store = MemoryStore(memory_path, warn_on_new=True)

        assert store.db_path == memory_path / "memory" / "memory.db"

    def test_cast_memory_path_does_not_warn(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        memory_path = tmp_path / "agent" / "memory"
        memory_path.mkdir(parents=True)
        external = tmp_path / "volume"
        monkeypatch.setenv("CAST_MEMORY_PATH", str(external))

        store = _assert_no_user_warning(memory_path)

        assert store.db_path == external / "memory.db"
        assert os.environ["CAST_MEMORY_PATH"] == str(external)
