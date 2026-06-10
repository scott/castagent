"""Tests for the new helper functions in cast.builder.

The deploy/builder integration helpers (is_agent_deployed,
get_deployed_version, get_changes_since_release) let the builder
agent reason about whether a release prompt is needed.
"""
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

from cast import builder
from cast import releases
from cast import versioning


@pytest.fixture
def temp_cast_home(monkeypatch, tmp_path):
    """Point the cast.* modules at a temporary ~/.cast directory."""
    cast_dir = tmp_path / ".cast"
    cast_dir.mkdir()
    agents_dir = cast_dir / "agents"
    agents_dir.mkdir()
    db_path = cast_dir / "cast.db"

    monkeypatch.setattr(builder, "AGENTS_DIR", agents_dir)
    monkeypatch.setattr(builder, "CAST_DB_PATH", db_path)
    monkeypatch.setattr(releases, "AGENTS_DIR", agents_dir)
    monkeypatch.setattr(versioning, "AGENTS_DIR", agents_dir)
    return cast_dir


def _seed_db(cast_dir: Path, agent_name: str, deployment_url: str = "https://example.com",
             deployed_version: str = "1.0") -> None:
    """Plant a deployment record for an agent in the test database."""
    db_path = cast_dir / "cast.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS agents (
            name TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            agent_yaml_path TEXT,
            last_run_at DATETIME,
            run_count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS deployments (
            id TEXT PRIMARY KEY,
            agent_name TEXT NOT NULL,
            provider TEXT,
            deployment_url TEXT,
            auth_token_hash TEXT,
            deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_connected_at DATETIME,
            volume_id TEXT,
            volume_config TEXT,
            deployed_version TEXT,
            deleted_at DATETIME
        );
    """)
    conn.execute(
        "INSERT OR REPLACE INTO agents (name) VALUES (?)",
        (agent_name,),
    )
    conn.execute(
        """INSERT INTO deployments
           (id, agent_name, provider, deployment_url, auth_token_hash, deployed_version)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("abc123", agent_name, "docker", deployment_url, "hash", deployed_version),
    )
    conn.commit()
    conn.close()


# =============================================================================
# is_agent_deployed
# =============================================================================
class TestIsAgentDeployed:
    """Tests for builder.is_agent_deployed."""

    def test_returns_false_when_db_missing(self, temp_cast_home):
        # DB doesn't exist
        assert builder.is_agent_deployed("any-agent") is False

    def test_returns_false_when_agent_not_deployed(self, temp_cast_home):
        _seed_db(temp_cast_home, "my-agent", deployment_url="https://example.com")
        assert builder.is_agent_deployed("other-agent") is False

    def test_returns_true_when_deployed(self, temp_cast_home):
        _seed_db(temp_cast_home, "my-agent", deployment_url="https://example.com")
        assert builder.is_agent_deployed("my-agent") is True

    def test_returns_false_when_deployment_url_null(self, temp_cast_home):
        # An entry exists but has no URL (corrupt/partial deploy)
        _seed_db(temp_cast_home, "broken-agent", deployment_url=None)
        assert builder.is_agent_deployed("broken-agent") is False

    def test_handles_sqlite_error(self, temp_cast_home):
        # Simulate DB corruption
        (temp_cast_home / "cast.db").touch()
        with patch.object(builder.sqlite3, "connect",
                          side_effect=sqlite3.Error("db broken")):
            assert builder.is_agent_deployed("any-agent") is False


# =============================================================================
# get_deployed_version
# =============================================================================
class TestGetDeployedVersion:
    """Tests for builder.get_deployed_version."""

    def test_returns_none_when_db_missing(self, temp_cast_home):
        assert builder.get_deployed_version("any-agent") is None

    def test_returns_none_when_not_deployed(self, temp_cast_home):
        _seed_db(temp_cast_home, "deployed-agent")
        assert builder.get_deployed_version("other-agent") is None

    def test_returns_version(self, temp_cast_home):
        _seed_db(temp_cast_home, "agent", deployed_version="1.6")
        assert builder.get_deployed_version("agent") == "1.6"

    def test_returns_latest_version(self, temp_cast_home):
        """When there are multiple deployments, the most recent one wins."""
        db_path = temp_cast_home / "cast.db"
        _seed_db(db_path.parent, "agent", deployed_version="1.0")
        # Add a more recent deployment
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            """INSERT INTO deployments
               (id, agent_name, provider, deployment_url, auth_token_hash, deployed_version, deployed_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 hour'))""",
            ("def456", "agent", "fly", "https://fly.example.com", "hash", "1.7"),
        )
        conn.commit()
        conn.close()

        assert builder.get_deployed_version("agent") == "1.7"

    def test_returns_null_string_as_none(self, temp_cast_home):
        """A deployment with no version recorded should return None."""
        _seed_db(temp_cast_home, "agent", deployed_version=None)
        # Function returns whatever is in the column when not NULL
        result = builder.get_deployed_version("agent")
        # Either None or empty string is acceptable
        assert result is None or result == ""

    def test_handles_sqlite_error(self, temp_cast_home):
        (temp_cast_home / "cast.db").touch()
        with patch.object(builder.sqlite3, "connect",
                          side_effect=sqlite3.Error("db broken")):
            assert builder.get_deployed_version("any-agent") is None


# =============================================================================
# get_changes_since_release
# =============================================================================
class TestGetChangesSinceRelease:
    """Tests for builder.get_changes_since_release."""

    def test_no_changes_no_releases(self, temp_cast_home):
        # No versions, no releases
        assert builder.get_changes_since_release("agent") == 0

    def test_no_releases_returns_current(self, temp_cast_home):
        """Without any releases, every change counts."""
        agent_path = temp_cast_home / "agents" / "agent"
        agent_path.mkdir(parents=True, exist_ok=True)
        changes_dir = agent_path / ".cast" / "changes"
        changes_dir.mkdir(parents=True, exist_ok=True)

        import json
        (changes_dir / "changes.json").write_text(json.dumps({
            "current": 3,
            "versions": [
                {"id": 1, "timestamp": "2024-01-01T00:00:00Z",
                 "source": "create", "message": "Initial"},
                {"id": 2, "timestamp": "2024-01-02T00:00:00Z",
                 "source": "cli", "message": "Update"},
                {"id": 3, "timestamp": "2024-01-03T00:00:00Z",
                 "source": "cli", "message": "More update"},
            ],
        }))

        assert builder.get_changes_since_release("agent") == 3

    def test_returns_changes_after_latest_release(self, temp_cast_home):
        """Only changes AFTER the latest release count."""
        # Create 5 changes
        agent_path = temp_cast_home / "agents" / "agent"
        agent_path.mkdir(parents=True, exist_ok=True)
        changes_dir = agent_path / ".cast" / "changes"
        changes_dir.mkdir(parents=True, exist_ok=True)

        import json
        (changes_dir / "changes.json").write_text(json.dumps({
            "current": 5,
            "versions": [
                {"id": i, "timestamp": f"2024-01-{i:02d}T00:00:00Z",
                 "source": "create" if i == 1 else "cli", "message": f"v{i}"}
                for i in range(1, 6)
            ],
        }))
        # Create a release based on change 3
        releases_dir = agent_path / ".cast" / "releases"
        releases_dir.mkdir(exist_ok=True)
        # Plant an empty tarball to make get_release work
        import tarfile
        tarball = releases_dir / "1.0.tar.gz"
        with tarfile.open(tarball, "w:gz"):
            pass
        (releases_dir / "releases.json").write_text(json.dumps({
            "current": {"version": "1.0", "change_number": 3},
            "releases": [{
                "version": "1.0",
                "change_number": 3,
                "message": "First release",
                "changelog": "",
                "created_at": "2024-01-03T00:00:00Z",
                "tarball_path": str(tarball),
            }],
        }))

        # 5 - 3 = 2 changes since release
        assert builder.get_changes_since_release("agent") == 2

    def test_zero_when_no_changes_after_release(self, temp_cast_home):
        """If the latest release covers all changes, the count is 0."""
        agent_path = temp_cast_home / "agents" / "agent"
        agent_path.mkdir(parents=True, exist_ok=True)
        changes_dir = agent_path / ".cast" / "changes"
        changes_dir.mkdir(parents=True, exist_ok=True)

        import json
        (changes_dir / "changes.json").write_text(json.dumps({
            "current": 3,
            "versions": [
                {"id": i, "timestamp": f"2024-01-{i:02d}T00:00:00Z",
                 "source": "create" if i == 1 else "cli", "message": f"v{i}"}
                for i in range(1, 4)
            ],
        }))
        releases_dir = agent_path / ".cast" / "releases"
        releases_dir.mkdir(exist_ok=True)
        import tarfile
        tarball = releases_dir / "1.0.tar.gz"
        with tarfile.open(tarball, "w:gz"):
            pass
        (releases_dir / "releases.json").write_text(json.dumps({
            "current": {"version": "1.0", "change_number": 3},
            "releases": [{
                "version": "1.0",
                "change_number": 3,
                "message": "First release",
                "changelog": "",
                "created_at": "2024-01-03T00:00:00Z",
                "tarball_path": str(tarball),
            }],
        }))

        assert builder.get_changes_since_release("agent") == 0
