"""Migration script for Cast Agent versioning system and features."""

import json
import os
import shutil
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

AGENTS_DIR = Path.home() / ".cast" / "agents"
CAST_DB = Path.home() / ".cast" / "cast.db"

# Default memory configuration
DEFAULT_MEMORY_CONFIG = {
    "memory": {
        "enabled": True,
        "categories": [
            "learned", "decision", "pattern", "error_learned", "accomplishment",
            "preference", "context", "project", "tools_used", "boundary",
            "relationship", "todo", "question_asked", "directive_given"
        ],
        "max_per_category": 100,
        "relevance_threshold": 0.7,
        "reflection_model": None,
    }
}


def migrate_memory_config(agent_dir: Path, dry_run: bool = True, verbose: bool = False) -> dict:
    """
    Migrate memory configuration for an agent.

    Creates memory/config.yaml if it doesn't exist.

    Args:
        agent_dir: Path to the agent directory
        dry_run: If True, don't make changes
        verbose: If True, print detailed progress

    Returns:
        Dict with migration results
    """
    agent_name = agent_dir.name
    memory_dir = agent_dir / "memory"
    memory_config_path = memory_dir / "config.yaml"

    result = {
        "agent": agent_name,
        "memory_config_created": False,
        "change_recorded": False,
        "error": None
    }

    try:
        # Check if memory config already exists
        if memory_config_path.exists():
            if verbose:
                print(f"  Memory config already exists, skipping")
            return result

        if verbose:
            print(f"  Creating memory config...")

        if not dry_run:
            # Create memory directory and config
            memory_dir.mkdir(parents=True, exist_ok=True)
            import yaml
            with open(memory_config_path, "w") as f:
                yaml.dump(DEFAULT_MEMORY_CONFIG, f, default_flow_style=False, sort_keys=False)

            # Record the change in versioning system
            try:
                from cast.versioning import create_version
                create_version(
                    agent_name,
                    source="migration",
                    message="Added memory configuration",
                    agents_dir=AGENTS_DIR
                )
                result["change_recorded"] = True
                if verbose:
                    print(f"    Created change record for memory config")
            except Exception as e:
                if verbose:
                    print(f"    Warning: Could not create change record: {e}")

        result["memory_config_created"] = True
        if verbose:
            print(f"  Memory config created at {memory_config_path}")

    except Exception as e:
        result["error"] = str(e)
        if verbose:
            print(f"  Error creating memory config: {e}")

    return result


def migrate_versioning_system(dry_run: bool = True, verbose: bool = False) -> dict:
    """
    Migrate agents from old versioning system to new.

    Args:
        dry_run: If True, don't make changes (just report what would happen)
        verbose: If True, print detailed progress

    Returns:
        Dict with migration results
    """
    results = {
        "agents_migrated": 0,
        "agents_skipped": 0,
        "agents_failed": 0,
        "details": []
    }

    if not AGENTS_DIR.exists():
        if verbose:
            print(f"Agents directory does not exist: {AGENTS_DIR}")
        return results

    # Find all agents
    for agent_dir in AGENTS_DIR.iterdir():
        if not agent_dir.is_dir():
            continue

        agent_name = agent_dir.name
        old_versions_dir = agent_dir / ".cast" / "versions"

        if verbose:
            print(f"\nProcessing agent: {agent_name}")

        try:
            # Check if already migrated
            new_changes_dir = agent_dir / ".cast" / "changes"
            if new_changes_dir.exists() and (new_changes_dir / "changes.json").exists():
                if verbose:
                    print(f"  Already migrated, skipping")
                results["agents_skipped"] += 1
                results["details"].append({
                    "agent": agent_name,
                    "status": "skipped",
                    "reason": "Already migrated"
                })
                continue

            # Check if old structure exists
            if not old_versions_dir.exists():
                if verbose:
                    print(f"  No old versioning found, creating new structure")
                # Create new structure
                if not dry_run:
                    new_changes_dir.mkdir(parents=True, exist_ok=True)
                    (new_changes_dir / "changes.json").write_text(json.dumps({
                        "current": 0,
                        "versions": []
                    }, indent=2))
                    (agent_dir / ".cast" / "releases").mkdir(parents=True, exist_ok=True)
                    (agent_dir / ".cast" / "releases" / "releases.json").write_text(json.dumps({
                        "current": None,
                        "releases": []
                    }, indent=2))
                results["agents_migrated"] += 1
                results["details"].append({
                    "agent": agent_name,
                    "status": "created",
                    "reason": "New agent structure created"
                })
                continue

            # Migrate old structure
            if verbose:
                print(f"  Migrating from versions to changes")

            if not dry_run:
                # Create new directories
                new_changes_dir = agent_dir / ".cast" / "changes"
                new_changes_dir.mkdir(parents=True, exist_ok=True)

                releases_dir = agent_dir / ".cast" / "releases"
                releases_dir.mkdir(parents=True, exist_ok=True)

                # Copy versions.json to changes.json
                old_json = old_versions_dir / "versions.json"
                new_json = new_changes_dir / "changes.json"

                if old_json.exists():
                    # Read and update the data
                    data = json.loads(old_json.read_text())
                    # Ensure data has correct structure
                    if "versions" not in data:
                        data = {"versions": [], "current": 0}
                    new_json.write_text(json.dumps(data, indent=2))

                # Copy tarballs (renaming if needed)
                for old_file in old_versions_dir.glob("*.tar.gz"):
                    new_file = new_changes_dir / old_file.name
                    shutil.copy2(old_file, new_file)

                # Create empty releases.json
                releases_json = releases_dir / "releases.json"
                releases_json.write_text(json.dumps({
                    "current": None,
                    "releases": []
                }, indent=2))

                # Create initial release from latest version if versions exist
                if old_json.exists():
                    data = json.loads(old_json.read_text())
                    if data.get("current", 0) > 0:
                        # Read agent.yaml for version
                        agent_yaml = agent_dir / "agent.yaml"
                        version = "1.0"  # Default
                        if agent_yaml.exists():
                            import yaml
                            config = yaml.safe_load(agent_yaml.read_text())
                            version = config.get("version", "1.0")

                        # Create initial release matching current state
                        from cast.releases import create_release
                        try:
                            release = create_release(agent_name, version, "Initial release after migration")
                        except Exception as e:
                            if verbose:
                                print(f"  Warning: Could not create initial release: {e}")

                # Optionally remove old structure
                # shutil.rmtree(old_versions_dir)

            results["agents_migrated"] += 1
            results["details"].append({
                "agent": agent_name,
                "status": "migrated"
            })

        except Exception as e:
            if verbose:
                print(f"  Failed: {e}")
            results["agents_failed"] += 1
            results["details"].append({
                "agent": agent_name,
                "status": "failed",
                "error": str(e)
            })

    return results


def migrate_database(dry_run: bool = True, verbose: bool = False) -> dict:
    """
    Migrate the database schema.

    This adds the releases table if it doesn't exist.
    """
    results = {
        "releases_table_created": False,
        "deployments_updated": 0,
        "errors": []
    }

    if not CAST_DB.exists():
        if verbose:
            print("Database does not exist yet, will be created on first use")
        return results

    conn = None
    try:
        conn = sqlite3.connect(CAST_DB)
    except sqlite3.Error as e:
        results["errors"].append(str(e))
        return results

    try:
        cursor = conn.cursor()
        # Check if releases table exists
        cursor.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='releases'
        """)

        if not cursor.fetchone():
            if verbose:
                print("Creating releases table...")
            if not dry_run:
                cursor.execute("""
                    CREATE TABLE releases (
                        agent_name TEXT,
                        version TEXT,
                        change_number INTEGER,
                        message TEXT,
                        changelog TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        tarball_path TEXT,
                        PRIMARY KEY (agent_name, version)
                    )
                """)
                conn.commit()
            results["releases_table_created"] = True
        else:
            if verbose:
                print("Releases table already exists")

        # Check if deployed_version needs updating (from INTEGER to TEXT)
        cursor.execute("PRAGMA table_info(deployments)")
        columns = [col[1] for col in cursor.fetchall()]

        if "deployed_version" in columns:
            # Check current type
            cursor.execute("SELECT deployed_version FROM deployments LIMIT 1")
            sample = cursor.fetchone()
            if sample and isinstance(sample[0], int):
                if verbose:
                    print("Converting deployed_version from INTEGER to TEXT...")
                if not dry_run:
                    # Add new column as TEXT
                    cursor.execute("ALTER TABLE deployments ADD COLUMN deployed_version_text TEXT")
                    # Copy data with "v" prefix
                    cursor.execute("UPDATE deployments SET deployed_version_text = 'v' || deployed_version WHERE deployed_version IS NOT NULL")
                    # The schema migration in TypeScript will handle the final switch
                    conn.commit()
                results["deployments_updated"] = cursor.execute("SELECT COUNT(*) FROM deployments WHERE deployed_version IS NOT NULL").fetchone()[0]

    except Exception as e:
        results["errors"].append(str(e))
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return results


def migrate_agent_features(dry_run: bool = True, verbose: bool = False) -> dict:
    """
    Migrate agent features (memory config, etc.) for all agents.

    Args:
        dry_run: If True, don't make changes
        verbose: If True, print detailed progress

    Returns:
        Dict with migration results
    """
    results = {
        "agents_updated": 0,
        "agents_skipped": 0,
        "agents_failed": 0,
        "details": []
    }

    if not AGENTS_DIR.exists():
        if verbose:
            print(f"Agents directory does not exist: {AGENTS_DIR}")
        return results

    # Find all agents
    for agent_dir in AGENTS_DIR.iterdir():
        if not agent_dir.is_dir():
            continue

        # Skip non-agent directories
        agent_yaml = agent_dir / "agent.yaml"
        if not agent_yaml.exists():
            continue

        agent_name = agent_dir.name

        if verbose:
            print(f"\nProcessing agent: {agent_name}")

        # Migrate memory config
        memory_result = migrate_memory_config(agent_dir, dry_run=dry_run, verbose=verbose)

        if memory_result["error"]:
            results["agents_failed"] += 1
            results["details"].append(memory_result)
        elif memory_result["memory_config_created"]:
            results["agents_updated"] += 1
            results["details"].append(memory_result)
        else:
            results["agents_skipped"] += 1

    return results


def run_migration(dry_run: bool = True, verbose: bool = True):
    """Run full migration."""
    print("=" * 60)
    print("Cast Versioning System Migration")
    print("=" * 60)
    print(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    print()

    # Migrate file structure
    print("Migrating agent file structure...")
    file_results = migrate_versioning_system(dry_run=dry_run, verbose=verbose)
    print(f"  Migrated: {file_results['agents_migrated']}")
    print(f"  Skipped: {file_results['agents_skipped']}")
    print(f"  Failed: {file_results['agents_failed']}")

    # Migrate database
    print()
    print("Migrating database...")
    db_results = migrate_database(dry_run=dry_run, verbose=verbose)
    if db_results["releases_table_created"]:
        print("  Created releases table")
    if db_results["deployments_updated"] > 0:
        print(f"  Updated {db_results['deployments_updated']} deployments")
    if db_results["errors"]:
        print(f"  Errors: {db_results['errors']}")

    # Migrate agent features
    print()
    print("Migrating agent features...")
    feature_results = migrate_agent_features(dry_run=dry_run, verbose=verbose)
    print(f"  Updated: {feature_results['agents_updated']}")
    print(f"  Skipped: {feature_results['agents_skipped']}")
    print(f"  Failed: {feature_results['agents_failed']}")

    print()
    print("Migration complete!")
    if dry_run:
        print("Run with --live to apply changes.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Migrate Cast versioning system")
    parser.add_argument("--live", action="store_true", help="Apply changes (default is dry-run)")
    parser.add_argument("--quiet", action="store_true", help="Suppress verbose output")
    args = parser.parse_args()

    run_migration(dry_run=not args.live, verbose=not args.quiet)