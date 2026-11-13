"""Git tools follow CAST_AGENT_PATH when CAST_AGENT_DIR is unset."""

import os
from pathlib import Path

import git
from cast.runtime import configure_runtime_env
from cast.tools.git import get_agent_path, git_status


def test_cast_agent_dir_still_wins(monkeypatch):
    monkeypatch.setenv("CAST_AGENT_DIR", "/explicit")
    monkeypatch.setenv("CAST_AGENT_PATH", "/runtime")
    assert get_agent_path() == "/explicit"


def test_falls_back_to_cast_agent_path(monkeypatch):
    monkeypatch.delenv("CAST_AGENT_DIR", raising=False)
    monkeypatch.setenv("CAST_AGENT_PATH", "/from/runtime")
    assert get_agent_path() == "/from/runtime"


def test_empty_cast_agent_dir_falls_back(monkeypatch):
    monkeypatch.setenv("CAST_AGENT_DIR", "")
    monkeypatch.setenv("CAST_AGENT_PATH", "/runtime")
    assert get_agent_path() == "/runtime"


def test_agent_path_flag_is_the_git_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("CAST_AGENT_DIR", raising=False)
    configure_runtime_env(str(tmp_path))
    assert get_agent_path() == os.path.abspath(str(tmp_path))


def test_status_reads_the_cast_agent_path_repo(tmp_path, monkeypatch):
    repo_dir = tmp_path / "agent"
    repo_dir.mkdir()
    repo = git.Repo.init(repo_dir)
    (repo_dir / "README.md").write_text("hello\n", encoding="utf-8")
    repo.index.add(["README.md"])
    actor = git.Actor("Cast Test", "cast-test@example.com")
    repo.index.commit("init", author=actor, committer=actor)

    monkeypatch.delenv("CAST_AGENT_DIR", raising=False)
    monkeypatch.setenv("CAST_AGENT_PATH", str(repo_dir))
    result = git_status.invoke({})

    assert "Not a Git repository" not in result
    assert "Working tree is clean" in result
    assert Path(get_agent_path()) == repo_dir
