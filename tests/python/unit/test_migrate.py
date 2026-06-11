"""Tests for cast.migrate - the migration script for upgrading agents
from the old versioning system to the new releases system.
"""
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from cast import migrate


@pytest.fixture
def temp_home(monkeypatch, tmp_path):
    """Point the migrate module at a temporary ~/.cast directory so we
    don't touch the real user state.
    """
    cast_dir = tmp_path / ".cast"
    cast_dir.mkdir()
    agents_dir = cast_dir / "agents"
    agents_dir.mkdir()
    db_path = cast_dir / "cast.db"

    monkeypatch.setattr(migrate, "AGENTS_DIR", agents_dir)
    monkeypatch.setattr(migrate, "CAST_DB", db_path)
    return cast_dir


@pytest.fixture
def agent_dir_factory(temp_home):
    """Factory to create a pre-migration agent with the old
    .cast/versions/ structure on disk.
    """

    def make_agent(name: str, version_count: int = 0, version_str: str = "1.0"):
        path = temp_home / "agents" / name
        path.mkdir(parents=True, exist_ok=True)
        (path / "mcp").mkdir(exist_ok=True)
        (path / "tools").mkdir(exist_ok=True)

        with open(path / "agent.yaml", "w") as f:
            yaml.dump({
                "name": name,
                "version": version_str,
                "description": f"Test {name}",
                "brain": {"model": "test", "instructions_file": "instructions.md"},
            }, f)
        with open(path / "instructions.md", "w") as f:
            f.write(f"# {name}\n")

        if version_count > 0:
            old_versions_dir = path / ".cast" / "versions"
            old_versions_dir.mkdir(parents=True, exist_ok=True)
            versions = []
            for i in range(1, version_count + 1):
                versions.append({
                    "id": i,
                    "timestamp": f"2024-01-{i:02d}T00:00:00Z",
                    "source": "create" if i == 1 else "cli",
                    "message": f"Version {i}",
                })
            with open(old_versions_dir / "versions.json", "w") as f:
                json.dump({"current": version_count, "versions": versions}, f)

        return path

    return make_agent


# =============================================================================
# migrate_memory_config
# =============================================================================
class TestMigrateMemoryConfig:
    """Tests for migrate.migrate_memory_config."""

    def test_dry_run_creates_no_file(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        result = migrate.migrate_memory_config(agent_dir, dry_run=True)
        assert result["memory_config_created"] is True
        # File should not actually exist
        assert not (agent_dir / "memory" / "config.yaml").exists()

    def test_creates_memory_config(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        result = migrate.migrate_memory_config(agent_dir, dry_run=False)
        assert result["memory_config_created"] is True
        config_path = agent_dir / "memory" / "config.yaml"
        assert config_path.exists()
        data = yaml.safe_load(config_path.read_text())
        assert "memory" in data
        assert data["memory"]["enabled"] is True
        assert "learned" in data["memory"]["categories"]
        assert data["memory"]["max_per_category"] == 100
        assert data["memory"]["relevance_threshold"] == 0.7

    def test_skips_when_config_exists(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        # Plant an existing config
        (agent_dir / "memory").mkdir()
        (agent_dir / "memory" / "config.yaml").write_text("memory:\n  enabled: false\n")
        result = migrate.migrate_memory_config(agent_dir, dry_run=False)
        assert result["memory_config_created"] is False
        # File should remain unchanged
        content = (agent_dir / "memory" / "config.yaml").read_text()
        assert "enabled: false" in content

    def test_records_change_when_live(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        result = migrate.migrate_memory_config(agent_dir, dry_run=False)
        # Should have recorded a change in the versioning system
        assert result["change_recorded"] is True

    def test_no_change_recorded_in_dry_run(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        result = migrate.migrate_memory_config(agent_dir, dry_run=True)
        # In dry run, no change is recorded (because the file isn't created)
        assert result["change_recorded"] is False

    def test_verbose_output(self, temp_home, agent_dir_factory, capsys):
        agent_dir = agent_dir_factory("a1")
        migrate.migrate_memory_config(agent_dir, dry_run=False, verbose=True)
        captured = capsys.readouterr()
        assert "memory config" in captured.out.lower() or "Memory config" in captured.out

    def test_handles_exception(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1")
        # Make the agent_dir read-only to provoke a failure
        with patch("pathlib.Path.mkdir", side_effect=OSError("boom")):
            result = migrate.migrate_memory_config(agent_dir, dry_run=False)
        assert result["error"] is not None
        assert "boom" in result["error"]


# =============================================================================
# migrate_versioning_system
# =============================================================================
class TestMigrateVersioningSystem:
    """Tests for migrate.migrate_versioning_system."""

    def test_no_agents_dir(self, temp_home):
        # Wipe agents dir
        import shutil
        shutil.rmtree(temp_home / "agents")
        result = migrate.migrate_versioning_system(dry_run=True)
        assert result["agents_migrated"] == 0
        assert result["agents_skipped"] == 0

    def test_creates_new_structure_for_new_agent(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        result = migrate.migrate_versioning_system(dry_run=False)
        assert result["agents_migrated"] == 1
        # New structure should exist
        new_dir = temp_home / "agents" / "a1" / ".cast" / "changes"
        assert new_dir.exists()
        assert (new_dir / "changes.json").exists()
        releases_dir = temp_home / "agents" / "a1" / ".cast" / "releases"
        assert releases_dir.exists()
        assert (releases_dir / "releases.json").exists()

    def test_dry_run_does_not_create_files(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        result = migrate.migrate_versioning_system(dry_run=True)
        assert result["agents_migrated"] == 1
        # Files should not exist
        assert not (temp_home / "agents" / "a1" / ".cast" / "changes").exists()

    def test_migrates_old_structure(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1", version_count=3, version_str="1.2")
        result = migrate.migrate_versioning_system(dry_run=False)
        assert result["agents_migrated"] == 1
        # Old data should be copied to new location
        new_json = agent_dir / ".cast" / "changes" / "changes.json"
        assert new_json.exists()
        data = json.loads(new_json.read_text())
        assert data["current"] == 3
        assert len(data["versions"]) == 3
        # Old versions.json should be preserved (we don't delete it)
        old_json = agent_dir / ".cast" / "versions" / "versions.json"
        assert old_json.exists()

    def test_skips_already_migrated(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1", version_count=2)
        # Pre-create the new changes dir AND changes.json to simulate
        # already-migrated (both must exist for the skip check to trigger).
        new_dir = agent_dir / ".cast" / "changes"
        new_dir.mkdir(parents=True, exist_ok=True)
        (new_dir / "changes.json").write_text(
            json.dumps({"current": 5, "versions": []})
        )
        result = migrate.migrate_versioning_system(dry_run=False)
        assert result["agents_skipped"] == 1
        assert result["agents_migrated"] == 0
        # The pre-existing data should be unchanged
        data = json.loads((agent_dir / ".cast" / "changes" / "changes.json").read_text())
        assert data["current"] == 5

    def test_handles_missing_versions_json(self, temp_home, agent_dir_factory):
        """Agent has old versions/ dir but no versions.json inside it."""
        agent_dir = agent_dir_factory("a1", version_count=0)
        # Create empty old dir
        (agent_dir / ".cast" / "versions").mkdir(parents=True, exist_ok=True)
        result = migrate.migrate_versioning_system(dry_run=False)
        assert result["agents_migrated"] == 1

    def test_multiple_agents_mixed_state(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)  # new
        agent_dir_factory("a2", version_count=2)  # has old
        # Pre-migrate a3 - need both the changes/ dir AND changes.json
        a3 = agent_dir_factory("a3", version_count=1)
        a3_changes = a3 / ".cast" / "changes"
        a3_changes.mkdir(parents=True, exist_ok=True)
        (a3_changes / "changes.json").write_text(
            json.dumps({"current": 1, "versions": []})
        )

        result = migrate.migrate_versioning_system(dry_run=False)
        assert result["agents_migrated"] == 2
        assert result["agents_skipped"] == 1

    def test_failed_migration_counted(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=1)
        # Patch create_release to fail
        from cast import releases
        original = releases.create_release
        releases.create_release = lambda *a, **kw: (_ for _ in ()).throw(
            RuntimeError("boom")
        )
        try:
            result = migrate.migrate_versioning_system(dry_run=False)
            # Migration of the file structure should still succeed
            assert result["agents_migrated"] == 1
        finally:
            releases.create_release = original

    def test_verbose_flag(self, temp_home, agent_dir_factory, capsys):
        agent_dir_factory("a1", version_count=1)
        migrate.migrate_versioning_system(dry_run=False, verbose=True)
        captured = capsys.readouterr()
        assert "Processing agent" in captured.out
        assert "a1" in captured.out

    def test_skips_non_directory_entries(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        # Plant a stray file in agents dir
        (temp_home / "agents" / "stray_file.txt").write_text("x")
        result = migrate.migrate_versioning_system(dry_run=False)
        # Only the directory should be processed
        assert result["agents_migrated"] == 1


# =============================================================================
# migrate_database
# =============================================================================
class TestMigrateDatabase:
    """Tests for migrate.migrate_database."""

    def test_no_database_returns_early(self, temp_home):
        # No DB exists
        result = migrate.migrate_database(dry_run=False)
        assert result["releases_table_created"] is False

    def test_creates_releases_table(self, temp_home):
        # Set up a database with an existing deployments table
        db_path = temp_home / "cast.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE deployments (
                id TEXT PRIMARY KEY,
                agent_name TEXT NOT NULL,
                deployed_version INTEGER
            )
        """)
        conn.commit()
        conn.close()

        result = migrate.migrate_database(dry_run=False)
        assert result["releases_table_created"] is True

        # Verify the table now exists
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='releases'"
        )
        assert cursor.fetchone() is not None
        conn.close()

    def test_skips_when_releases_table_exists(self, temp_home):
        db_path = temp_home / "cast.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE deployments (
                id TEXT PRIMARY KEY,
                agent_name TEXT NOT NULL,
                deployed_version INTEGER
            )
        """)
        conn.execute("""
            CREATE TABLE releases (
                agent_name TEXT,
                version TEXT,
                PRIMARY KEY (agent_name, version)
            )
        """)
        conn.commit()
        conn.close()

        result = migrate.migrate_database(dry_run=False)
        assert result["releases_table_created"] is False

    def test_dry_run_creates_no_table(self, temp_home):
        db_path = temp_home / "cast.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE deployments (
                id TEXT PRIMARY KEY,
                agent_name TEXT NOT NULL,
                deployed_version INTEGER
            )
        """)
        conn.commit()
        conn.close()

        result = migrate.migrate_database(dry_run=True)
        assert result["releases_table_created"] is True

        # Verify the table is NOT actually created
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='releases'"
        )
        assert cursor.fetchone() is None
        conn.close()

    def test_collects_errors(self, temp_home):
        # Create the database file so the function actually tries to open it
        (temp_home / "cast.db").touch()
        # Patch the connect method on the sqlite3 module as imported into
        # cast.migrate (not the global sqlite3 module).
        with patch.object(migrate.sqlite3, "connect", side_effect=sqlite3.Error("db error")):
            result = migrate.migrate_database(dry_run=False)
        assert "db error" in result["errors"]


# =============================================================================
# migrate_agent_features
# =============================================================================
class TestMigrateAgentFeatures:
    """Tests for migrate.migrate_agent_features."""

    def test_no_agents_dir(self, temp_home):
        import shutil
        shutil.rmtree(temp_home / "agents")
        result = migrate.migrate_agent_features(dry_run=True)
        assert result["agents_updated"] == 0

    def test_skips_directories_without_agent_yaml(self, temp_home):
        (temp_home / "agents" / "broken").mkdir(parents=True)
        result = migrate.migrate_agent_features(dry_run=False)
        # No agent.yaml means it's not an agent; should be skipped
        assert result["agents_updated"] == 0
        assert result["agents_skipped"] == 0

    def test_creates_memory_config(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        result = migrate.migrate_agent_features(dry_run=False)
        assert result["agents_updated"] == 1
        assert (temp_home / "agents" / "a1" / "memory" / "config.yaml").exists()

    def test_dry_run_does_not_modify(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        result = migrate.migrate_agent_features(dry_run=True)
        assert result["agents_updated"] == 1
        assert not (temp_home / "agents" / "a1" / "memory").exists()

    def test_skips_agent_with_existing_config(self, temp_home, agent_dir_factory):
        agent_dir = agent_dir_factory("a1", version_count=0)
        (agent_dir / "memory").mkdir()
        (agent_dir / "memory" / "config.yaml").write_text("memory:\n  enabled: false\n")
        result = migrate.migrate_agent_features(dry_run=False)
        assert result["agents_updated"] == 0
        assert result["agents_skipped"] == 1

    def test_counts_failed_agents(self, temp_home, agent_dir_factory):
        agent_dir_factory("a1", version_count=0)
        # Force memory config creation to fail
        original_mkdir = Path.mkdir
        def failing_mkdir(self, *args, **kwargs):
            if self.name == "memory":
                raise OSError("nope")
            return original_mkdir(self, *args, **kwargs)
        with patch.object(Path, "mkdir", failing_mkdir):
            result = migrate.migrate_agent_features(dry_run=False)
        assert result["agents_failed"] == 1

    def test_mixed_results(self, temp_home, agent_dir_factory):
        # Agent that needs updating
        a1 = agent_dir_factory("a1", version_count=0)
        # Agent that already has memory config
        a2 = agent_dir_factory("a2", version_count=0)
        (a2 / "memory").mkdir()
        (a2 / "memory" / "config.yaml").write_text("memory:\n  enabled: false\n")
        # Broken agent
        a3 = agent_dir_factory("a3", version_count=0)
        a3_yaml = a3 / "agent.yaml"
        a3_yaml.write_text(": invalid: yaml: [")

        result = migrate.migrate_agent_features(dry_run=False)
        # a1 should be updated; a2 skipped; a3 may fail or be skipped
        # depending on whether the broken YAML matters (it doesn't for this
        # migration, since we only look at the file's existence)
        assert result["agents_updated"] >= 1
        assert result["agents_skipped"] >= 1


# =============================================================================
# run_migration (orchestrator)
# =============================================================================
class TestRunMigration:
    """Tests for migrate.run_migration (the orchestrator)."""

    def test_dry_run_default(self, temp_home, agent_dir_factory, capsys):
        agent_dir_factory("a1", version_count=0)
        migrate.run_migration(dry_run=True, verbose=False)
        captured = capsys.readouterr()
        # Should print the migration banner
        assert "DRY RUN" in captured.out
        assert "Migration complete" in captured.out

    def test_live_mode(self, temp_home, agent_dir_factory, capsys):
        agent_dir_factory("a1", version_count=0)
        migrate.run_migration(dry_run=False, verbose=False)
        captured = capsys.readouterr()
        assert "LIVE" in captured.out
        assert "Migration complete" in captured.out
        # In live mode, file structure should be created
        assert (temp_home / "agents" / "a1" / ".cast" / "changes").exists()
        assert (temp_home / "agents" / "a1" / "memory" / "config.yaml").exists()

    def test_dry_run_invites_live(self, temp_home, agent_dir_factory, capsys):
        agent_dir_factory("a1", version_count=0)
        migrate.run_migration(dry_run=True, verbose=False)
        captured = capsys.readouterr()
        assert "--live" in captured.out
