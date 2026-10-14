import os
import sqlite3
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Iterator
from dataclasses import dataclass, field
from contextlib import contextmanager


@dataclass
class MemoryHighlight:
    id: Optional[int] = None
    timestamp: str = ""
    category: str = ""
    content: str = ""
    source: str = ""
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        result = {
            "id": self.id,
            "timestamp": self.timestamp,
            "category": self.category,
            "content": self.content,
            "source": self.source,
            "tags": self.tags,
        }
        if self.id is None:
            del result["id"]
        return result


def _get_memory_path(agent_path: Path) -> Path:
    memory_path = os.environ.get('CAST_MEMORY_PATH')
    if memory_path:
        return Path(memory_path)
    return agent_path / "memory"


def _passed_memory_directory(agent_path: Path) -> bool:
    """True when agent_path points at a memory directory.

    The database is stored at <agent root>/memory/memory.db. A path whose
    last component is "memory" would nest another memory directory. A
    directory named memory that contains agent.yaml is an agent root.
    CAST_MEMORY_PATH stores the database outside that directory.
    """
    if os.environ.get("CAST_MEMORY_PATH"):
        return False
    if agent_path.name.lower() != "memory":
        return False
    return not (agent_path / "agent.yaml").is_file()


class MemoryStore:
    def __init__(self, agent_path: Path, warn_on_new: bool = True):
        self.agent_path = Path(agent_path)
        self.memory_dir = _get_memory_path(self.agent_path)
        self.db_path = self.memory_dir / "memory.db"
        
        self._was_new = not self.db_path.exists()
        
        # A new database at the agent root is the normal cast dev path.
        # Warn only when the caller passed the memory directory itself.
        if warn_on_new and self._was_new and _passed_memory_directory(self.agent_path):
            import warnings

            warnings.warn(
                f"MemoryStore path '{agent_path}' appears to be a memory directory. "
                f"Expected agent root path. This will create nested structure at "
                f"{self.db_path}. Pass the agent root path instead.",
                UserWarning,
                stacklevel=2
            )
        
        self._ensure_memory_dir()
        self._init_db()

    def _ensure_memory_dir(self):
        self.memory_dir.mkdir(parents=True, exist_ok=True)

    def _init_db(self):
        with self._get_conn() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS highlights (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL,
                    tags TEXT NOT NULL DEFAULT '[]'
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_category ON highlights(category)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_timestamp ON highlights(timestamp)
            """)
            conn.commit()

    @contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def append(self, highlight: MemoryHighlight) -> int:
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO highlights (timestamp, category, content, source, tags)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    highlight.timestamp,
                    highlight.category,
                    highlight.content,
                    highlight.source,
                    json.dumps(highlight.tags),
                ),
            )
            conn.commit()
            return cursor.lastrowid or 0

    def get_all(self) -> list[MemoryHighlight]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM highlights ORDER BY timestamp DESC"
            ).fetchall()
        return [self._row_to_highlight(row) for row in rows]

    def get_by_category(self, category: str) -> list[MemoryHighlight]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM highlights WHERE category = ? ORDER BY timestamp DESC",
                (category,),
            ).fetchall()
        return [self._row_to_highlight(row) for row in rows]

    def get_recent(self, limit: int = 50) -> list[MemoryHighlight]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM highlights ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._row_to_highlight(row) for row in rows]

    def search(
        self, query: str, categories: Optional[list[str]] = None, limit: int = 20
    ) -> list[MemoryHighlight]:
        query_lower = f"%{query.lower()}%"
        with self._get_conn() as conn:
            if categories:
                placeholders = ",".join("?" * len(categories))
                rows = conn.execute(
                    f"""
                    SELECT * FROM highlights
                    WHERE (LOWER(content) LIKE ? OR LOWER(tags) LIKE ?)
                    AND category IN ({placeholders})
                    ORDER BY timestamp DESC
                    LIMIT ?
                    """,
                    [query_lower, query_lower] + categories + [limit],
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM highlights
                    WHERE LOWER(content) LIKE ? OR LOWER(tags) LIKE ?
                    ORDER BY timestamp DESC
                    LIMIT ?
                    """,
                    (query_lower, query_lower, limit),
                ).fetchall()
        return [self._row_to_highlight(row) for row in rows]

    def get_by_id(self, id: int) -> Optional[MemoryHighlight]:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM highlights WHERE id = ?", (id,)
            ).fetchone()
        return self._row_to_highlight(row) if row else None

    def delete(self, id: int) -> bool:
        with self._get_conn() as conn:
            cursor = conn.execute("DELETE FROM highlights WHERE id = ?", (id,))
            conn.commit()
            return cursor.rowcount > 0

    def count(self) -> int:
        with self._get_conn() as conn:
            row = conn.execute("SELECT COUNT(*) as count FROM highlights").fetchone()
        return row["count"] if row else 0

    def count_by_category(self, category: str) -> int:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as count FROM highlights WHERE category = ?", (category,)
            ).fetchone()
        return row["count"] if row else 0

    def clear_category(self, category: str) -> int:
        with self._get_conn() as conn:
            cursor = conn.execute("DELETE FROM highlights WHERE category = ?", (category,))
            conn.commit()
            return cursor.rowcount

    def _row_to_highlight(self, row: sqlite3.Row) -> MemoryHighlight:
        return MemoryHighlight(
            id=row["id"],
            timestamp=row["timestamp"],
            category=row["category"],
            content=row["content"],
            source=row["source"],
            tags=json.loads(row["tags"]),
        )

    @property
    def is_new(self) -> bool:
        return self._was_new