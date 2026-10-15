"""Issue #255: bare provider keys must not land in notes, sqlite, or git.

The strings below are dummy shapes. They are not real credentials.
"""

import asyncio
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from cast.harness.permissions import ApprovalBroker, PermissionGate, guard_tool
from cast.memory.filter import PrivacyFilter
from cast.memory.middleware import MemoryMiddleware
from cast.memory.store import MemoryHighlight
from cast.memory.filter import scrub_notes_text
from cast.tools.bash import bash_tool
from cast.tools.git import git_add, git_commit, git_push


OPENROUTER_DUMMY = "sk-or-v1-dummy"
PROVIDER_DUMMY = "sk-dummykeyvalue123456"
DIGITALOCEAN_DUMMY = "dop_v1_dummy"
OAUTH_DUMMY = "doo_v1_dummy"
REFRESH_DUMMY = "dor_v1_dummy"
SECRETS = (
    OPENROUTER_DUMMY,
    PROVIDER_DUMMY,
    DIGITALOCEAN_DUMMY,
    OAUTH_DUMMY,
    REFRESH_DUMMY,
)


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def _init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", "main")
    _git(path, "config", "user.email", "cast-test@example.com")
    _git(path, "config", "user.name", "Cast Test")
    (path / "README.md").write_text("public\n", encoding="utf-8")
    _git(path, "add", "README.md")
    _git(path, "commit", "-m", "init")
    return path


def _write_agent(agent_dir: Path) -> Path:
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "agent.yaml").write_text(
        "name: privacy-agent\n"
        "version: '1.0'\n"
        "description: privacy test\n"
        "brain:\n"
        "  model: openrouter/anthropic/claude-3-7-sonnet\n"
        "tools:\n"
        "  builtin: [bash, read, glob]\n",
        encoding="utf-8",
    )
    memory = agent_dir / "memory"
    memory.mkdir()
    (memory / "config.yaml").write_text("memory:\n  enabled: true\n", encoding="utf-8")
    return agent_dir


def _memory_bytes(agent_dir: Path) -> bytes:
    memory = agent_dir / "memory"
    chunks = [path.read_bytes() for path in memory.rglob("*") if path.is_file()]
    return b"\n".join(chunks)


def _assert_secrets_absent(blob: bytes) -> None:
    for secret in SECRETS:
        assert secret.encode() not in blob


def _head_text(repo: Path) -> str:
    show = _git(repo, "show", "--format=", "HEAD")
    names = _git(repo, "ls-tree", "-r", "--name-only", "HEAD")
    return show.stdout + "\n" + names.stdout


class TestBareProviderKeys:
    def test_filter_scrubs_bare_provider_keys(self):
        privacy = PrivacyFilter()
        text = (
            f"openrouter {OPENROUTER_DUMMY} provider {PROVIDER_DUMMY} "
            f"deploy {DIGITALOCEAN_DUMMY} oauth {OAUTH_DUMMY} refresh {REFRESH_DUMMY}"
        )
        result = privacy.scrub(text)
        for secret in SECRETS:
            assert secret not in result
            assert privacy.is_sensitive(secret) is True
        assert result.count("[REDACTED]") >= len(SECRETS)
        assert privacy.is_sensitive("Install sk-learn for the model") is False
        assert privacy.scrub("Install sk-learn for the model") == "Install sk-learn for the model"

    def test_uppercase_openrouter_shape_is_scrubbed(self):
        privacy = PrivacyFilter()
        result = privacy.scrub("Key SK-OR-V1-DUMMY")
        assert "SK-OR-V1-DUMMY" not in result
        assert "[REDACTED]" in result


class TestRememberScrubsBothSinks:
    def test_explicit_remember_scrubs_notes_and_sqlite(self, tmp_path):
        agent = _write_agent(tmp_path / "privacy-agent")
        middleware = MemoryMiddleware(agent)
        message = (
            "remember: openrouter "
            f"{OPENROUTER_DUMMY} and deploy {DIGITALOCEAN_DUMMY}"
        )
        saved = middleware.remember_explicit(message)

        assert saved is not None
        assert OPENROUTER_DUMMY not in saved.content
        assert DIGITALOCEAN_DUMMY not in saved.content
        assert "[REDACTED]" in saved.content

        notes = (agent / "memory" / "notes.md").read_text(encoding="utf-8")
        assert OPENROUTER_DUMMY not in notes
        assert DIGITALOCEAN_DUMMY not in notes
        assert "[REDACTED]" in notes

        _assert_secrets_absent(_memory_bytes(agent))

        with sqlite3.connect(agent / "memory" / "memory.db") as conn:
            rows = [row[0] for row in conn.execute("SELECT content FROM highlights")]
        assert rows
        assert all(OPENROUTER_DUMMY not in row for row in rows)
        assert all(DIGITALOCEAN_DUMMY not in row for row in rows)

    def test_ordinary_fact_is_still_stored(self, tmp_path):
        agent = _write_agent(tmp_path / "privacy-agent")
        middleware = MemoryMiddleware(agent)
        saved = middleware.remember_explicit("remember: my favorite fruit is quince")
        assert saved is not None
        assert saved.content == "my favorite fruit is quince"
        notes = (agent / "memory" / "notes.md").read_text(encoding="utf-8")
        assert "quince" in notes

    def test_record_sync_scrubs_before_the_sqlite_row(self, tmp_path):
        agent = _write_agent(tmp_path / "privacy-agent")
        middleware = MemoryMiddleware(agent)
        raw = MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content=f"pasted {OPENROUTER_DUMMY}",
            source="test",
            tags=[DIGITALOCEAN_DUMMY, "public-tag"],
        )
        middleware.reflection.reflect_sync = lambda *_args, **_kwargs: raw

        stored = middleware.record_sync("hello", "ok", "chat")

        assert stored is not None
        assert OPENROUTER_DUMMY not in stored.content
        assert DIGITALOCEAN_DUMMY not in stored.tags
        assert "public-tag" in stored.tags
        assert OPENROUTER_DUMMY.encode() not in _memory_bytes(agent)
        assert DIGITALOCEAN_DUMMY.encode() not in _memory_bytes(agent)


class TestBashNotesWrites:
    """Issue #274: bash is a notes write path, including "remember this permanently"."""

    def test_scrub_notes_text_keeps_line_breaks(self):
        text = (
            "Install sk-learn for the model\n"
            f"key {OPENROUTER_DUMMY} and {DIGITALOCEAN_DUMMY}\n"
            "favorite fruit is quince\n"
        )
        result = scrub_notes_text(text)
        assert OPENROUTER_DUMMY not in result
        assert DIGITALOCEAN_DUMMY not in result
        assert result.splitlines() == [
            "Install sk-learn for the model",
            "key [REDACTED] and [REDACTED]",
            "favorite fruit is quince",
        ]

    def _agent(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        agent = tmp_path / "agent"
        (agent / "memory").mkdir(parents=True)
        monkeypatch.setenv("CAST_AGENT_PATH", str(agent))
        return agent

    def test_bash_permanent_note_scrubs_bare_key(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        command = (
            "cat > memory/notes.md << 'EOF'\n"
            f"remember this permanently {OPENROUTER_DUMMY}\n"
            "favorite fruit is quince\n"
            "EOF\n"
        )
        bash_tool.invoke({"command": command})
        text = (agent / "memory" / "notes.md").read_text(encoding="utf-8")
        assert OPENROUTER_DUMMY not in text
        assert "[REDACTED]" in text
        assert "remember this permanently" in text
        assert "quince" in text

    def test_bash_append_scrubs_provider_keys_and_keeps_other_lines(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        notes.write_text("favorite fruit is quince\n", encoding="utf-8")
        command = (
            "printf '%s\\n' "
            f"'deploy {DIGITALOCEAN_DUMMY} provider {PROVIDER_DUMMY} "
            f"oauth {OAUTH_DUMMY} refresh {REFRESH_DUMMY}' >> memory/notes.md"
        )
        bash_tool.invoke({"command": command})
        text = notes.read_text(encoding="utf-8")
        for secret in (DIGITALOCEAN_DUMMY, PROVIDER_DUMMY, OAUTH_DUMMY, REFRESH_DUMMY):
            assert secret not in text
        assert "quince" in text
        assert text.count("[REDACTED]") >= 4

    def test_absolute_path_write_is_scrubbed(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        command = f"printf '%s\\n' '{OPENROUTER_DUMMY}' > {notes}"
        result = bash_tool.invoke({"command": command})
        assert OPENROUTER_DUMMY not in result
        text = notes.read_text(encoding="utf-8")
        assert text == "[REDACTED]\n"
        assert OPENROUTER_DUMMY not in text

    def test_failed_command_still_scrubs_a_notes_write(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        command = f"printf '%s\\n' '{OPENROUTER_DUMMY}' > memory/notes.md; exit 1"
        bash_tool.invoke({"command": command})
        assert OPENROUTER_DUMMY not in notes.read_text(encoding="utf-8")
        assert "[REDACTED]" in notes.read_text(encoding="utf-8")

    def test_unrelated_bash_leaves_clean_notes_unchanged(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        original = "favorite fruit is quince\n"
        notes.write_text(original, encoding="utf-8")
        before = notes.stat().st_mtime_ns
        bash_tool.invoke({"command": "echo hello"})
        assert notes.read_text(encoding="utf-8") == original
        assert notes.stat().st_mtime_ns == before

    @pytest.mark.parametrize("launch", (
        "(sleep 0.4; {body}) >/dev/null 2>&1 &",
        "setsid sh -c \"sleep 0.4; {body}\" </dev/null >/dev/null 2>&1 &",
        "nohup sh -c \"sleep 0.4; {body}\" >/dev/null 2>&1 &",
        "sh -c \"sleep 0.4; {body}\" >/dev/null 2>&1 &",
    ))
    def test_background_bash_write_scrubs_provider_keys(self, tmp_path, monkeypatch, launch):
        """Issue #293: a background write must get the foreground scrub."""
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        notes.write_text("favorite fruit is quince\n", encoding="utf-8")
        body = (
            "printf '%s\\n' "
            f"'deploy {OPENROUTER_DUMMY} provider {PROVIDER_DUMMY} "
            f"token {DIGITALOCEAN_DUMMY}' >> memory/notes.md"
        )
        bash_tool.invoke({"command": launch.format(body=body)})
        text = _wait_for_notes(
            notes,
            lambda value: (
                "quince" in value
                and "[REDACTED]" in value
                and all(secret not in value for secret in (
                    OPENROUTER_DUMMY,
                    PROVIDER_DUMMY,
                    DIGITALOCEAN_DUMMY,
                ))
            ),
        )
        assert "quince" in text
        assert "[REDACTED]" in text
        assert text.count("[REDACTED]") >= 3
        for secret in (OPENROUTER_DUMMY, PROVIDER_DUMMY, DIGITALOCEAN_DUMMY):
            assert secret not in text

    def test_setsid_write_is_scrubbed_without_a_delay(self, tmp_path, monkeypatch):
        """A detached write can finish after the shell has already returned."""
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        notes.write_text("favorite fruit is quince\n", encoding="utf-8")
        command = (
            "setsid sh -c \"printf '%s\\n' "
            f"'{OPENROUTER_DUMMY}' >> memory/notes.md\" "
            "</dev/null >/dev/null 2>&1 &"
        )
        bash_tool.invoke({"command": command})
        text = _wait_for_notes(
            notes,
            lambda value: OPENROUTER_DUMMY not in value and "[REDACTED]" in value,
        )
        assert OPENROUTER_DUMMY not in text
        assert "[REDACTED]" in text
        assert "quince" in text

    def test_background_bash_keeps_a_non_secret_line(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)
        notes = agent / "memory" / "notes.md"
        notes.write_text("favorite fruit is quince\n", encoding="utf-8")
        command = (
            "(sleep 0.2; printf '%s\\n' 'favorite color is teal' "
            ">> memory/notes.md) >/dev/null 2>&1 &"
        )
        bash_tool.invoke({"command": command})
        text = _wait_for_notes(notes, lambda value: "teal" in value)
        assert text == "favorite fruit is quince\nfavorite color is teal\n"
        assert "[REDACTED]" not in text


def _wait_for_notes(notes: Path, predicate, timeout: float = 3.0) -> str:
    deadline = time.monotonic() + timeout
    text = ""
    while time.monotonic() < deadline:
        text = notes.read_text(encoding="utf-8") if notes.is_file() else ""
        if predicate(text):
            return text
        time.sleep(0.02)
    return text


class TestGitDoesNotPublishNotes:
    def test_commit_leaves_untracked_notes_out_of_the_commit(self, tmp_path, monkeypatch):
        repo = _init_repo(tmp_path / "agent")
        monkeypatch.setenv("CAST_AGENT_DIR", str(repo))
        notes = repo / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text(f"{OPENROUTER_DUMMY}\n", encoding="utf-8")
        (repo / "public.txt").write_text("public v2\n", encoding="utf-8")

        result = git_commit.invoke({"message": "public only"})

        assert "Committed successfully" in result
        assert "memory/notes.md is private and was not staged" in result
        committed = _head_text(repo)
        assert OPENROUTER_DUMMY not in committed
        assert "memory/notes.md" not in committed.splitlines()
        assert "public v2" in committed
        assert "public.txt" in committed.splitlines()
        assert notes.read_text(encoding="utf-8") == f"{OPENROUTER_DUMMY}\n"

    def test_commit_of_only_notes_creates_no_commit(self, tmp_path, monkeypatch):
        repo = _init_repo(tmp_path / "agent")
        monkeypatch.setenv("CAST_AGENT_DIR", str(repo))
        before = _git(repo, "rev-parse", "HEAD").stdout
        notes = repo / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text(f"{DIGITALOCEAN_DUMMY}\n", encoding="utf-8")

        result = git_commit.invoke({"message": "should not publish"})

        assert result.startswith("Nothing to commit")
        assert "not staged" in result
        assert _git(repo, "rev-parse", "HEAD").stdout == before
        assert DIGITALOCEAN_DUMMY not in _head_text(repo)
        assert notes.read_text(encoding="utf-8") == f"{DIGITALOCEAN_DUMMY}\n"

    def test_commit_unstages_notes_that_were_already_staged(self, tmp_path, monkeypatch):
        repo = _init_repo(tmp_path / "agent")
        monkeypatch.setenv("CAST_AGENT_DIR", str(repo))
        notes = repo / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text(f"{OPENROUTER_DUMMY}\n", encoding="utf-8")
        _git(repo, "add", "-f", "memory/notes.md")
        (repo / "public.txt").write_text("public v3\n", encoding="utf-8")

        result = git_commit.invoke({"message": "public after unstage"})

        assert "Committed successfully" in result
        committed = _head_text(repo)
        assert OPENROUTER_DUMMY not in committed
        assert "public v3" in committed
        assert "memory/notes.md" not in _git(repo, "ls-files").stdout.splitlines()
        assert notes.read_text(encoding="utf-8") == f"{OPENROUTER_DUMMY}\n"

    def test_commit_stops_tracking_notes_already_in_history(self, tmp_path, monkeypatch):
        repo = _init_repo(tmp_path / "agent")
        monkeypatch.setenv("CAST_AGENT_DIR", str(repo))
        notes = repo / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text(f"{OPENROUTER_DUMMY}\n", encoding="utf-8")
        _git(repo, "add", "-f", "memory/notes.md")
        _git(repo, "commit", "-m", "old notes")
        (repo / "public.txt").write_text("later\n", encoding="utf-8")

        result = git_commit.invoke({"message": "drop private notes"})

        assert "Committed successfully" in result
        tree = _git(repo, "ls-tree", "-r", "--name-only", "HEAD").stdout.splitlines()
        assert "memory/notes.md" not in tree
        assert "public.txt" in tree
        assert notes.read_text(encoding="utf-8") == f"{OPENROUTER_DUMMY}\n"
        assert "memory/notes.md" not in _git(repo, "ls-files").stdout.splitlines()
        parent = _git(repo, "ls-tree", "-r", "--name-only", "HEAD~1").stdout
        assert "memory/notes.md" in parent.splitlines()

    def test_add_skips_notes_and_stages_other_files(self, tmp_path, monkeypatch):
        repo = _init_repo(tmp_path / "agent")
        monkeypatch.setenv("CAST_AGENT_DIR", str(repo))
        notes = repo / "memory" / "notes.md"
        notes.parent.mkdir()
        notes.write_text(f"{PROVIDER_DUMMY}\n", encoding="utf-8")
        (repo / "public.txt").write_text("ok\n", encoding="utf-8")

        result = git_add.invoke({"files": ["./memory/notes.md", "public.txt"]})

        assert "Skipped private memory/notes.md" in result
        staged = _git(repo, "diff", "--cached", "--name-only").stdout.splitlines()
        assert staged == ["public.txt"]
        only_notes = git_add.invoke({"files": ["memory/notes.md"]})
        assert "not staged" in only_notes
        assert "memory/notes.md" not in _git(repo, "diff", "--cached", "--name-only").stdout


def _pushable_repo(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "remote.git"
    agent = _init_repo(tmp_path / "agent")
    _git(tmp_path, "init", "--bare", str(remote))
    _git(agent, "remote", "add", "origin", str(remote))
    return agent, remote


def _remote_has_main(remote: Path) -> bool:
    probe = _git(remote, "rev-parse", "refs/heads/main", check=False)
    return probe.returncode == 0


class TestGitPushDefaultsToAsk:
    def test_default_git_push_does_not_push(self, tmp_path, monkeypatch):
        agent, remote = _pushable_repo(tmp_path)
        monkeypatch.setenv("CAST_AGENT_DIR", str(agent))
        tool = guard_tool(git_push, "git_push", PermissionGate({}))

        result = tool.invoke({})

        assert "not executed" in result
        assert _remote_has_main(remote) is False

    @pytest.mark.asyncio
    async def test_default_git_push_waits_for_approval(self, tmp_path, monkeypatch):
        agent, remote = _pushable_repo(tmp_path)
        monkeypatch.setenv("CAST_AGENT_DIR", str(agent))
        broker = ApprovalBroker()
        queue: asyncio.Queue = asyncio.Queue()
        broker.attach(queue)
        tool = guard_tool(git_push, "git_push", PermissionGate({}, broker))

        async def approve():
            kind, payload = await queue.get()
            assert kind == "permission"
            assert payload["tool"] == "git_push"
            assert broker.respond(payload["id"], True)

        waiter = asyncio.create_task(approve())
        result = await tool.ainvoke({})
        await waiter

        assert "successfully" in result.lower()
        assert _remote_has_main(remote) is True

    def test_explicit_always_allow_still_pushes(self, tmp_path, monkeypatch):
        agent, remote = _pushable_repo(tmp_path)
        monkeypatch.setenv("CAST_AGENT_DIR", str(agent))
        tool = guard_tool(git_push, "git_push", PermissionGate({"git_push": "always-allow"}))

        result = tool.invoke({})

        assert "successfully" in result.lower()
        assert _remote_has_main(remote) is True

    @pytest.mark.asyncio
    async def test_denied_approval_does_not_push(self, tmp_path, monkeypatch):
        agent, remote = _pushable_repo(tmp_path)
        monkeypatch.setenv("CAST_AGENT_DIR", str(agent))
        broker = ApprovalBroker()
        queue: asyncio.Queue = asyncio.Queue()
        broker.attach(queue)
        tool = guard_tool(git_push, "git_push", PermissionGate({}, broker))

        async def deny():
            _kind, payload = await queue.get()
            assert broker.respond(payload["id"], False)

        waiter = asyncio.create_task(deny())
        result = await tool.ainvoke({})
        await waiter

        assert "not executed" in result
        assert _remote_has_main(remote) is False
