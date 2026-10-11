"""Tests for cast.sessions — the conversation session storage layer."""
import json
import sqlite3
import tempfile
from pathlib import Path
from datetime import datetime, timezone

import pytest

from cast import sessions


@pytest.fixture
def temp_cast_home(monkeypatch, tmp_path):
    """Redirect ~/.cast to a temp directory and reset the SessionStore."""
    monkeypatch.setattr(sessions, "CAST_HOME", tmp_path)
    monkeypatch.setattr(sessions, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(sessions, "DB_PATH", tmp_path / "cast.db")
    return tmp_path


@pytest.fixture
def store(temp_cast_home):
    return sessions.SessionStore()


class TestSessionCreate:
    def test_create_returns_session_with_unique_id(self, store):
        s1 = store.create("alpha")
        s2 = store.create("beta")
        assert s1.id != s2.id
        assert s1.agent_name == "alpha"
        assert s2.agent_name == "beta"

    def test_create_writes_json_file(self, store, temp_cast_home):
        s = store.create("alpha")
        json_path = temp_cast_home / "sessions" / f"{s.id}.json"
        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert data["id"] == s.id
        assert data["agent_name"] == "alpha"
        assert data["messages"] == []

    def test_create_inserts_sqlite_row(self, store, temp_cast_home):
        s = store.create("alpha")
        db = sqlite3.connect(str(temp_cast_home / "cast.db"))
        try:
            row = db.execute(
                "SELECT * FROM sessions WHERE id = ?", (s.id,)
            ).fetchone()
            assert row is not None
            cols = [c[1] for c in db.execute("PRAGMA table_info(sessions)").fetchall()]
            assert "id" in cols
            assert "agent_name" in cols
            assert "json_path" in cols
            assert "message_count" in cols
        finally:
            db.close()

    def test_create_with_parent_and_name(self, store):
        parent = store.create("alpha")
        child = store.create(
            "alpha",
            parent_session_id=parent.id,
            name="experiment-1",
        )
        assert child.parent_session_id == parent.id
        assert child.name == "experiment-1"

    def test_create_rejects_missing_agent(self, store):
        with pytest.raises(sessions.SessionError):
            store.create("")

    def test_default_mode_and_ui_mode(self, store):
        s = store.create("alpha")
        assert s.mode == "build"
        assert s.ui_mode == "dev"


class TestSessionAppend:
    def test_append_user_message_updates_count_and_db(self, store):
        s = store.create("alpha")
        store.append_message(s.id, "user", "Hello")
        refreshed = store.get(s.id)
        assert refreshed is not None
        assert len(refreshed.messages) == 1
        assert refreshed.messages[0].role == "user"
        assert refreshed.messages[0].text == "Hello"
        meta = store._get_meta_row(s.id)
        assert meta.message_count == 1
        assert meta.first_user_message == "Hello"
        assert meta.last_user_message == "Hello"

    def test_append_agent_message_updates_last_user(self, store):
        s = store.create("alpha")
        store.append_message(s.id, "user", "Hello")
        store.append_message(s.id, "agent", "Hi there!")
        meta = store._get_meta_row(s.id)
        assert meta.first_user_message == "Hello"
        assert meta.last_user_message == "Hello"
        assert meta.message_count == 2

    def test_append_invalid_role_raises(self, store):
        s = store.create("alpha")
        with pytest.raises(sessions.SessionError):
            store.append_message(s.id, "system", "boom")

    def test_append_to_missing_session_raises(self, store):
        with pytest.raises(sessions.SessionError):
            store.append_message("does-not-exist", "user", "hi")

    def test_append_persists_to_json(self, store, temp_cast_home):
        s = store.create("alpha")
        store.append_message(s.id, "user", "Hello")
        store.append_message(s.id, "agent", "Hi!")
        data = json.loads(
            (temp_cast_home / "sessions" / f"{s.id}.json").read_text()
        )
        assert len(data["messages"]) == 2
        assert data["messages"][0]["role"] == "user"
        assert data["messages"][1]["role"] == "agent"


class TestSessionList:
    def test_list_returns_newest_first(self, store):
        a = store.create("alpha")
        b = store.create("alpha")
        c = store.create("alpha")
        items = store.list()
        assert [m.id for m in items] == [c.id, b.id, a.id]

    def test_list_filter_by_agent(self, store):
        store.create("alpha")
        store.create("beta")
        store.create("alpha")
        items = store.list(agent_name="alpha")
        assert len(items) == 2
        assert all(m.agent_name == "alpha" for m in items)

    def test_list_excludes_ended_when_requested(self, store):
        s = store.create("alpha")
        store.create("alpha")
        store.end(s.id)
        active = store.list(include_ended=False)
        all_ = store.list(include_ended=True)
        assert len(active) == 1
        assert len(all_) == 2

    def test_list_respects_limit(self, store):
        for _ in range(5):
            store.create("alpha")
        items = store.list(limit=2)
        assert len(items) == 2


class TestSessionGet:
    def test_get_by_id(self, store):
        s = store.create("alpha")
        store.append_message(s.id, "user", "Hello")
        got = store.get(s.id)
        assert got is not None
        assert got.id == s.id
        assert got.messages[0].text == "Hello"

    def test_get_by_name(self, store):
        s = store.create("alpha", name="my-session")
        got = store.get("my-session")
        assert got is not None
        assert got.id == s.id

    def test_get_missing_returns_none(self, store):
        assert store.get("nope") is None

    def test_get_with_missing_json_returns_stub(self, store, temp_cast_home):
        s = store.create("alpha")
        # Delete just the JSON file
        (temp_cast_home / "sessions" / f"{s.id}.json").unlink()
        got = store.get(s.id)
        assert got is not None
        assert got.id == s.id
        assert got.messages == []


class TestSessionRename:
    def test_rename_updates_db_and_json(self, store, temp_cast_home):
        s = store.create("alpha")
        store.rename(s.id, "renamed")
        meta = store._get_meta_row(s.id)
        assert meta.name == "renamed"
        data = json.loads(
            (temp_cast_home / "sessions" / f"{s.id}.json").read_text()
        )
        assert data["name"] == "renamed"

    def test_rename_missing_raises(self, store):
        with pytest.raises(sessions.SessionError):
            store.rename("nope", "foo")


class TestSessionFork:
    def test_fork_copies_messages(self, store):
        s = store.create("alpha", name="original")
        store.append_message(s.id, "user", "first")
        store.append_message(s.id, "agent", "reply")
        forked = store.fork(s.id, name="branch")
        assert forked.id != s.id
        assert forked.parent_session_id == s.id
        assert forked.name == "branch"
        assert len(forked.messages) == 2
        assert forked.messages[0].text == "first"
        assert forked.messages[1].text == "reply"

    def test_fork_does_not_mutate_original(self, store):
        s = store.create("alpha")
        store.append_message(s.id, "user", "hi")
        forked = store.fork(s.id)
        store.append_message(forked.id, "user", "fork-only")
        original = store.get(s.id)
        assert original is not None
        assert len(original.messages) == 1


class TestSessionEnd:
    def test_end_sets_ended_at(self, store):
        s = store.create("alpha")
        store.end(s.id)
        meta = store._get_meta_row(s.id)
        assert meta.ended_at is not None

    def test_end_missing_raises(self, store):
        with pytest.raises(sessions.SessionError):
            store.end("nope")


class TestSessionDelete:
    def test_delete_removes_json_and_db(self, store, temp_cast_home):
        s = store.create("alpha")
        json_path = temp_cast_home / "sessions" / f"{s.id}.json"
        assert json_path.exists()
        store.delete(s.id)
        assert not json_path.exists()
        assert store._get_meta_row(s.id) is None

    def test_delete_missing_raises(self, store):
        with pytest.raises(sessions.SessionError):
            store.delete("nope")


class TestSessionExportImport:
    def test_export_writes_json(self, store, temp_cast_home):
        s = store.create("alpha", name="to-export")
        store.append_message(s.id, "user", "hi")
        out = temp_cast_home / "exports" / "session.json"
        returned = store.export(s.id, out)
        assert returned == out
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["id"] == s.id
        assert data["name"] == "to-export"
        assert len(data["messages"]) == 1

    def test_import_with_new_id(self, store, temp_cast_home):
        s = store.create("alpha", name="orig")
        store.append_message(s.id, "user", "hi")
        out = temp_cast_home / "exports" / "session.json"
        store.export(s.id, out)
        imported = store.import_(out, new_id=True)
        assert imported.id != s.id
        assert imported.parent_session_id is None
        assert len(imported.messages) == 1

    def test_import_with_same_id(self, store, temp_cast_home):
        s = store.create("alpha")
        store.append_message(s.id, "user", "hi")
        out = temp_cast_home / "exports" / "session.json"
        store.export(s.id, out)
        imported = store.import_(out, new_id=False)
        assert imported.id == s.id

    def test_import_missing_file_raises(self, store, temp_cast_home):
        with pytest.raises(sessions.SessionError):
            store.import_(temp_cast_home / "does-not-exist.json")


class TestSessionPrune:
    def test_prune_deletes_old_ended_sessions(self, store):
        s1 = store.create("alpha")
        s2 = store.create("alpha")
        store.end(s1.id)
        # Backdate s1 by manipulating the DB
        db = sqlite3.connect(str(sessions.DB_PATH))
        try:
            db.execute(
                "UPDATE sessions SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?",
                (s1.id,),
            )
            db.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                (sessions._now_iso(), s2.id),
            )
            db.commit()
        finally:
            db.close()
        deleted = store.prune(older_than_days=30)
        assert deleted == 1
        assert store._get_meta_row(s1.id) is None
        assert store._get_meta_row(s2.id) is not None

    def test_prune_keeps_active_sessions(self, store):
        s = store.create("alpha")
        # Even with an old timestamp, an active session is kept
        db = sqlite3.connect(str(sessions.DB_PATH))
        try:
            db.execute(
                "UPDATE sessions SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?",
                (s.id,),
            )
            db.commit()
        finally:
            db.close()
        deleted = store.prune(older_than_days=30)
        assert deleted == 0


class TestSessionDeleteForAgent:
    def test_cascade_delete_removes_all_sessions(self, store, temp_cast_home):
        store.create("alpha")
        store.create("alpha")
        store.create("beta")
        deleted = store.delete_for_agent("alpha")
        assert deleted == 2
        items = store.list()
        assert len(items) == 1
        assert items[0].agent_name == "beta"
