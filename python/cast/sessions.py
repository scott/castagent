"""Conversation sessions for Cast agents.

A session is a saved, named conversation tied to an agent. Sessions are
distinct from changes (which are internal agent-state snapshots used for
undo/redo) and releases (which are the user-facing deployment artifact).

This module owns the JSON-per-session storage layer at ~/.cast/sessions/.
The directory is mode 0700 and each transcript is created mode 0600.
The SQLite index for fast listing lives in cast.db and is managed by the
TypeScript cast-cli. cast.db is created mode 0600.
"""

import json
import os
import re
import secrets
import shutil
import sqlite3
import time
import uuid
from dataclasses import dataclass, asdict, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional

CAST_HOME = Path.home() / ".cast"
SESSIONS_DIR = CAST_HOME / "sessions"
DB_PATH = CAST_HOME / "cast.db"


@dataclass
class SessionMeta:
    """Lightweight session metadata. Mirrored in cast.db for fast listing."""
    id: str
    name: Optional[str]
    agent_name: str
    mode: str               # 'plan' | 'build'
    ui_mode: str            # 'dev' | 'production' | 'on-host'
    created_at: str
    updated_at: str
    ended_at: Optional[str]
    message_count: int
    parent_session_id: Optional[str]
    first_user_message: Optional[str]
    last_user_message: Optional[str]
    json_path: str
    # Cached one-line topic. Null on rows written before the column existed.
    topic: Optional[str] = None
    topic_message_count: Optional[int] = None

    def to_db_row(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_db_row(cls, row: Dict[str, Any]) -> "SessionMeta":
        # SELECT * returns every column. Unknown keys are ignored so a newer
        # database does not break this process. Missing topic keys default,
        # which is how a row written before the column existed still lists.
        known = {item.name for item in fields(cls)}
        cleaned: Dict[str, Any] = {}
        for key, value in row.items():
            if key not in known:
                continue
            cleaned[key] = None if value == "" else value
        cleaned.setdefault("topic", None)
        cleaned.setdefault("topic_message_count", None)
        return cls(**cleaned)


@dataclass
class SessionMessage:
    role: str            # 'user' | 'agent'
    text: str
    ts: str
    ui_action: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionMessage":
        return cls(
            role=d.get("role", "user"),
            text=d.get("text", ""),
            ts=d.get("ts", ""),
            ui_action=d.get("ui_action"),
        )


@dataclass
class Session:
    """Full session content, including the message transcript."""
    id: str
    name: Optional[str]
    agent_name: str
    agent_version_at_start: Optional[str]
    created_at: str
    updated_at: str
    ended_at: Optional[str]
    mode: str
    ui_mode: str
    messages: List[SessionMessage] = field(default_factory=list)
    files_in_context: List[str] = field(default_factory=list)
    parent_session_id: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    topic: Optional[str] = None
    topic_message_count: Optional[int] = None

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> "Session":
        raw_count = data.get("topic_message_count")
        if raw_count is None or raw_count == "":
            topic_message_count = None
        else:
            try:
                topic_message_count = int(raw_count)
            except (TypeError, ValueError):
                topic_message_count = None
        topic = data.get("topic")
        if not isinstance(topic, str) or not topic.strip():
            topic = None
        return cls(
            id=data["id"],
            name=data.get("name"),
            agent_name=data["agent_name"],
            agent_version_at_start=data.get("agent_version_at_start"),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            ended_at=data.get("ended_at"),
            mode=data.get("mode", "build"),
            ui_mode=data.get("ui_mode", "dev"),
            messages=[SessionMessage.from_dict(m) for m in data.get("messages", [])],
            files_in_context=data.get("files_in_context", []),
            parent_session_id=data.get("parent_session_id"),
            tags=data.get("tags", []),
            topic=topic,
            topic_message_count=topic_message_count,
        )

    def to_json(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "agent_name": self.agent_name,
            "agent_version_at_start": self.agent_version_at_start,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "ended_at": self.ended_at,
            "mode": self.mode,
            "ui_mode": self.ui_mode,
            "messages": [m.to_dict() for m in self.messages],
            "files_in_context": self.files_in_context,
            "parent_session_id": self.parent_session_id,
            "tags": self.tags,
            "topic": self.topic,
            "topic_message_count": self.topic_message_count,
        }

    def meta(self, json_path: str) -> SessionMeta:
        first_user = next((m.text for m in self.messages if m.role == "user"), None)
        last_user = next(
            (m.text for m in reversed(self.messages) if m.role == "user"),
            None,
        )
        return SessionMeta(
            id=self.id,
            name=self.name,
            agent_name=self.agent_name,
            mode=self.mode,
            ui_mode=self.ui_mode,
            created_at=self.created_at,
            updated_at=self.updated_at,
            ended_at=self.ended_at,
            message_count=len(self.messages),
            parent_session_id=self.parent_session_id,
            first_user_message=first_user,
            last_user_message=last_user,
            json_path=json_path,
            topic=self.topic,
            topic_message_count=self.topic_message_count,
        )


class SessionError(Exception):
    """Raised on session storage errors."""
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


_PRIVATE_DIR_MODE = 0o700
_PRIVATE_FILE_MODE = 0o600


def _path_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _ensure_private_dir(path: Path) -> None:
    """Create path mode 0700. An existing directory is tightened in place.

    mkdir applies the process umask, so the mode argument is not the mode
    the directory is born with. umask 077 makes 0700 stick. chmod runs
    only when the directory already had a looser mode.
    """
    previous = os.umask(0o077)
    try:
        path.mkdir(parents=True, exist_ok=True, mode=_PRIVATE_DIR_MODE)
    finally:
        os.umask(previous)
    if path.is_dir() and _path_mode(path) != _PRIVATE_DIR_MODE:
        os.chmod(path, _PRIVATE_DIR_MODE)


def _ensure_private_database(path: Path) -> None:
    """Create a missing database file mode 0600, then tighten an older one."""
    if not path.exists():
        previous = os.umask(0o077)
        try:
            fd = os.open(
                str(path),
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                _PRIVATE_FILE_MODE,
            )
            os.close(fd)
        except FileExistsError:
            pass
        finally:
            os.umask(previous)
    if path.is_file() and _path_mode(path) != _PRIVATE_FILE_MODE:
        os.chmod(path, _PRIVATE_FILE_MODE)


def _write_private_text(path: Path, text: str) -> None:
    """Write text via a temp file created mode 0600 in the same directory."""
    tmp = path.with_name(
        f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    )
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    previous = os.umask(0o077)
    fd = None
    try:
        fd = os.open(str(tmp), flags, _PRIVATE_FILE_MODE)
    finally:
        os.umask(previous)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = None
            handle.write(text)
        os.replace(tmp, path)
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _ensure_sessions_dir() -> Path:
    _ensure_private_dir(CAST_HOME)
    _ensure_private_dir(SESSIONS_DIR)
    return SESSIONS_DIR


def _new_session_id() -> str:
    """Sortable-ish session ID: time prefix + random suffix."""
    ts = int(time.time() * 1000)
    rand = secrets.token_hex(6)
    return f"{ts:x}-{rand}"


def _ensure_sessions_table(db_path: Optional[Path] = None) -> None:
    """Create the sessions table if it does not exist. Mirrors the schema
    declared in typescript/cast-cli/src/lib/sqlite.ts so both sides agree."""
    path = Path(db_path) if db_path is not None else DB_PATH
    _ensure_private_dir(path.parent)
    _ensure_private_database(path)
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT,
                agent_name TEXT NOT NULL,
                mode TEXT,
                ui_mode TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                message_count INTEGER DEFAULT 0,
                parent_session_id TEXT,
                first_user_message TEXT,
                last_user_message TEXT,
                topic TEXT,
                topic_message_count INTEGER,
                json_path TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
            """
        )
        _ensure_session_topic_columns(conn)
        conn.commit()
    finally:
        conn.close()


def _ensure_session_topic_columns(conn: sqlite3.Connection) -> None:
    """Idempotent ALTER for databases that already have sessions."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "topic" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN topic TEXT")
    if "topic_message_count" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN topic_message_count INTEGER")


def _read_session_json(json_path: str) -> Optional[Dict[str, Any]]:
    p = Path(json_path)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _write_session_json(json_path: str, data: Dict[str, Any]) -> None:
    destination = Path(json_path)
    # Transcripts live in the session store. Export writes a copy somewhere
    # else and must not chmod that destination directory.
    if _is_under(destination, SESSIONS_DIR):
        _ensure_private_dir(CAST_HOME)
        _ensure_private_dir(SESSIONS_DIR)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
    _write_private_text(
        destination,
        json.dumps(data, indent=2, ensure_ascii=False),
    )


def _delete_session_json(json_path: str) -> None:
    p = Path(json_path)
    if p.exists():
        try:
            p.unlink()
        except OSError:
            pass


def _row_to_meta(row: sqlite3.Row) -> SessionMeta:
    return SessionMeta.from_db_row(dict(row))


class SessionStore:
    """High-level session storage. Uses SQLite for metadata, JSON for content."""

    def __init__(self, sessions_dir: Optional[Path] = None, db_path: Optional[Path] = None):
        self.sessions_dir = sessions_dir or SESSIONS_DIR
        self.db_path = db_path or DB_PATH
        _ensure_private_dir(self.sessions_dir)
        _ensure_sessions_table(self.db_path)

    # -- low-level db helpers -------------------------------------------------

    def _db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _insert_meta(self, meta: SessionMeta) -> None:
        conn = self._db()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO sessions (
                    id, name, agent_name, mode, ui_mode, created_at, updated_at,
                    ended_at, message_count, parent_session_id,
                    first_user_message, last_user_message, topic,
                    topic_message_count, json_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    meta.id,
                    meta.name,
                    meta.agent_name,
                    meta.mode,
                    meta.ui_mode,
                    meta.created_at,
                    meta.updated_at,
                    meta.ended_at,
                    meta.message_count,
                    meta.parent_session_id,
                    meta.first_user_message,
                    meta.last_user_message,
                    meta.topic,
                    meta.topic_message_count,
                    meta.json_path,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _update_meta_fields(self, session_id: str, fields: Dict[str, Any]) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields.keys())
        values = list(fields.values()) + [session_id]
        conn = self._db()
        try:
            conn.execute(f"UPDATE sessions SET {cols} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()

    def _get_meta_row(self, session_id: str) -> Optional[SessionMeta]:
        conn = self._db()
        try:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not row:
                return None
            return _row_to_meta(row)
        finally:
            conn.close()

    def _resolve_meta(self, identifier: str) -> Optional[SessionMeta]:
        """Resolve a session by id (exact) or by name (exact, single match)."""
        meta = self._get_meta_row(identifier)
        if meta:
            return meta
        conn = self._db()
        try:
            row = conn.execute(
                "SELECT * FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1",
                (identifier,),
            ).fetchone()
            if not row:
                return None
            return _row_to_meta(row)
        finally:
            conn.close()

    def _save_session(self, session: Session) -> str:
        """Write the session JSON. Keep a topic already on disk if this copy lacks one."""
        json_path = str(self.sessions_dir / f"{session.id}.json")
        data = session.to_json()
        if not data.get("topic"):
            existing = _read_session_json(json_path)
            if existing and isinstance(existing.get("topic"), str) and existing.get("topic").strip():
                data["topic"] = existing.get("topic")
                data["topic_message_count"] = existing.get("topic_message_count")
                session.topic = data["topic"]
                raw_count = data["topic_message_count"]
                try:
                    session.topic_message_count = None if raw_count is None else int(raw_count)
                except (TypeError, ValueError):
                    session.topic_message_count = None
        _write_session_json(json_path, data)
        return json_path

    def _write_topic(self, session_id: str, topic: str, message_count: int) -> bool:
        """Persist a topic only if the transcript length is still the one we summarized."""
        meta = self._get_meta_row(session_id)
        if meta is None:
            return False
        data = _read_session_json(meta.json_path)
        if data is None:
            return False
        messages = data.get("messages") or []
        if len(messages) != message_count:
            return False
        data["topic"] = topic
        data["topic_message_count"] = message_count
        _write_session_json(meta.json_path, data)
        self._update_meta_fields(session_id, {
            "topic": topic,
            "topic_message_count": message_count,
        })
        return True

    def refresh_topic(
        self,
        identifier: str,
        *,
        provider: Any = None,
        completer: Optional[Any] = None,
        agents_dir: Optional[Path] = None,
    ) -> Optional[str]:
        """Fill a missing or stale topic from that agent's model.

        Returns the stored topic, or None when the call is skipped or fails.
        A failure does not write a topic and does not change ``name``.
        A fresh topic is returned without calling the model.
        """
        meta = self._resolve_meta(identifier)
        if meta is None:
            return None
        session = self.get(meta.id)
        if session is None:
            return None
        if isinstance(session.name, str) and session.name.strip():
            return None
        if not any(
            message.role == "user" and isinstance(message.text, str) and message.text.strip()
            for message in session.messages
        ):
            return None
        if (
            isinstance(session.topic, str)
            and session.topic.strip()
            and session.topic_message_count is not None
            and session.topic_message_count == len(session.messages)
        ):
            return session.topic
        from cast.providers.session_topic import (
            bounded_transcript,
            complete_session_topic,
            resolve_agent_model,
            sanitize_topic,
        )
        root = agents_dir if agents_dir is not None else (Path.home() / ".cast" / "agents")
        model = resolve_agent_model(session.agent_name, root)
        if not model:
            return None
        transcript = bounded_transcript(session.messages)
        if not transcript.strip():
            return None
        if completer is None:
            def completer(model_name: str, text: str) -> Optional[str]:
                return complete_session_topic(model_name, text, provider=provider)
        try:
            raw = completer(model, transcript)
        except Exception:
            return None
        if not isinstance(raw, str):
            return None
        topic = sanitize_topic(raw)
        if not topic:
            return None
        message_count = len(session.messages)
        if not self._write_topic(session.id, topic, message_count):
            return None
        return topic

    # -- public API ----------------------------------------------------------

    def create(
        self,
        agent_name: str,
        mode: str = "build",
        ui_mode: str = "dev",
        parent_session_id: Optional[str] = None,
        name: Optional[str] = None,
        agent_version_at_start: Optional[str] = None,
    ) -> Session:
        if not agent_name or not isinstance(agent_name, str):
            raise SessionError("agent_name is required")

        session_id = _new_session_id()
        json_path = str(self.sessions_dir / f"{session_id}.json")
        now = _now_iso()

        session = Session(
            id=session_id,
            name=name,
            agent_name=agent_name,
            agent_version_at_start=agent_version_at_start,
            created_at=now,
            updated_at=now,
            ended_at=None,
            mode=mode,
            ui_mode=ui_mode,
            parent_session_id=parent_session_id,
        )
        _write_session_json(json_path, session.to_json())
        self._insert_meta(session.meta(json_path))
        return session

    def get(self, identifier: str) -> Optional[Session]:
        meta = self._resolve_meta(identifier)
        if not meta:
            return None
        data = _read_session_json(meta.json_path)
        if data is None:
            # JSON missing — return a stub session with no messages
            return Session(
                id=meta.id,
                name=meta.name,
                agent_name=meta.agent_name,
                agent_version_at_start=None,
                created_at=meta.created_at,
                updated_at=meta.updated_at,
                ended_at=meta.ended_at,
                mode=meta.mode,
                ui_mode=meta.ui_mode,
                parent_session_id=meta.parent_session_id,
                topic=meta.topic,
                topic_message_count=meta.topic_message_count,
            )
        return Session.from_json(data)

    def list(
        self,
        agent_name: Optional[str] = None,
        limit: int = 50,
        include_ended: bool = True,
    ) -> List[SessionMeta]:
        conn = self._db()
        try:
            if agent_name:
                if include_ended:
                    rows = conn.execute(
                        "SELECT * FROM sessions WHERE agent_name = ? "
                        "ORDER BY updated_at DESC LIMIT ?",
                        (agent_name, limit),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM sessions WHERE agent_name = ? AND ended_at IS NULL "
                        "ORDER BY updated_at DESC LIMIT ?",
                        (agent_name, limit),
                    ).fetchall()
            else:
                if include_ended:
                    rows = conn.execute(
                        "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM sessions WHERE ended_at IS NULL "
                        "ORDER BY updated_at DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
            return [_row_to_meta(r) for r in rows]
        finally:
            conn.close()

    def append_message(
        self,
        session_id: str,
        role: str,
        text: str,
        ui_action: Optional[Dict[str, Any]] = None,
    ) -> None:
        if role not in ("user", "agent"):
            raise SessionError(f"Invalid role: {role!r}")
        session = self.get(session_id)
        if session is None:
            raise SessionError(f"Session not found: {session_id}")
        ts = _now_iso()
        session.messages.append(
            SessionMessage(role=role, text=text, ts=ts, ui_action=ui_action)
        )
        session.updated_at = ts
        self._save_session(session)

        # Refresh SQLite metadata fields. Topic columns stay as they were:
        # a new message makes topic_message_count stale instead of clearing it.
        new_meta = session.meta(str(self.sessions_dir / f"{session.id}.json"))
        self._update_meta_fields(
            session_id,
            {
                "updated_at": new_meta.updated_at,
                "message_count": new_meta.message_count,
                "first_user_message": new_meta.first_user_message,
                "last_user_message": new_meta.last_user_message,
            },
        )

    def rename(self, identifier: str, name: str) -> Session:
        meta = self._resolve_meta(identifier)
        if not meta:
            raise SessionError(f"Session not found: {identifier}")
        session = self.get(meta.id)
        if session is None:
            raise SessionError(f"Session JSON missing: {meta.id}")
        session.name = name
        session.updated_at = _now_iso()
        self._save_session(session)
        self._update_meta_fields(
            session_id=session.id,
            fields={"name": name, "updated_at": session.updated_at},
        )
        return session

    def fork(self, identifier: str, name: Optional[str] = None) -> Session:
        meta = self._resolve_meta(identifier)
        if not meta:
            raise SessionError(f"Session not found: {identifier}")
        original = self.get(meta.id)
        if original is None:
            raise SessionError(f"Session JSON missing: {meta.id}")
        forked = self.create(
            agent_name=original.agent_name,
            mode=original.mode,
            ui_mode=original.ui_mode,
            parent_session_id=original.id,
            name=name,
            agent_version_at_start=original.agent_version_at_start,
        )
        # Copy the transcript so the fork starts with the same history
        forked.messages = list(original.messages)
        forked.files_in_context = list(original.files_in_context)
        forked.tags = list(original.tags)
        forked.topic = original.topic
        forked.topic_message_count = original.topic_message_count
        forked.updated_at = _now_iso()
        json_path = self._save_session(forked)
        new_meta = forked.meta(json_path)
        self._update_meta_fields(
            forked.id,
            {
                "updated_at": new_meta.updated_at,
                "message_count": new_meta.message_count,
                "first_user_message": new_meta.first_user_message,
                "last_user_message": new_meta.last_user_message,
                "topic": new_meta.topic,
                "topic_message_count": new_meta.topic_message_count,
            },
        )
        return forked

    def end(self, identifier: str) -> None:
        meta = self._resolve_meta(identifier)
        if not meta:
            raise SessionError(f"Session not found: {identifier}")
        now = _now_iso()
        self._update_meta_fields(meta.id, {"ended_at": now, "updated_at": now})

    def delete(self, identifier: str) -> None:
        meta = self._resolve_meta(identifier)
        if not meta:
            raise SessionError(f"Session not found: {identifier}")
        conn = self._db()
        try:
            conn.execute("DELETE FROM sessions WHERE id = ?", (meta.id,))
            conn.commit()
        finally:
            conn.close()
        _delete_session_json(meta.json_path)

    def export(self, identifier: str, out_path: Path) -> Path:
        meta = self._resolve_meta(identifier)
        if not meta:
            raise SessionError(f"Session not found: {identifier}")
        session = self.get(meta.id)
        if session is None:
            raise SessionError(f"Session JSON missing: {meta.id}")
        out = Path(out_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        _write_session_json(str(out), session.to_json())
        return out

    def import_(self, in_path: Path, new_id: bool = True) -> Session:
        """Import a session JSON. By default assigns a new id to avoid
        collisions with existing sessions."""
        p = Path(in_path)
        if not p.exists():
            raise SessionError(f"Import file not found: {p}")
        data = _read_session_json(str(p))
        if data is None:
            raise SessionError(f"Failed to parse session JSON: {p}")
        if new_id:
            data["id"] = _new_session_id()
            data["parent_session_id"] = None
        data["updated_at"] = _now_iso()
        # Re-write under the new id
        session = Session.from_json(data)
        json_path = str(self.sessions_dir / f"{session.id}.json")
        _write_session_json(json_path, session.to_json())
        self._insert_meta(session.meta(json_path))
        return session

    def prune(self, older_than_days: int = 30) -> int:
        """Delete sessions that have ended and were last updated more than
        N days ago. Returns the number of sessions deleted."""
        if older_than_days < 1:
            raise SessionError("older_than_days must be >= 1")
        # Compute cutoff in ISO format
        cutoff = datetime.now(timezone.utc).timestamp() - (older_than_days * 86400)
        cutoff_iso = (
            datetime.fromtimestamp(cutoff, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
        conn = self._db()
        try:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE ended_at IS NOT NULL AND updated_at < ?",
                (cutoff_iso,),
            ).fetchall()
        finally:
            conn.close()

        deleted = 0
        for row in rows:
            meta = _row_to_meta(row)
            try:
                self.delete(meta.id)
                deleted += 1
            except SessionError:
                continue
        return deleted

    def delete_for_agent(self, agent_name: str) -> int:
        """Cascade-delete all sessions for an agent. Called by `cast delete`."""
        conn = self._db()
        try:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE agent_name = ?", (agent_name,)
            ).fetchall()
        finally:
            conn.close()
        deleted = 0
        for row in rows:
            meta = _row_to_meta(row)
            _delete_session_json(meta.json_path)
            deleted += 1
        conn = self._db()
        try:
            conn.execute("DELETE FROM sessions WHERE agent_name = ?", (agent_name,))
            conn.commit()
        finally:
            conn.close()
        return deleted
