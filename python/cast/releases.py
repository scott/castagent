"""Agent releases module for semantic versioning."""

import json
import os
import sqlite3
import tarfile
import shutil
import re
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict

AGENTS_DIR = Path.home() / ".cast" / "agents"

# Deprecation warning helper
def _emit_deprecation_warning(old_name: str, new_name: str) -> None:
    """Emit a deprecation warning for renamed functions."""
    warnings.warn(
        f"'{old_name}' is deprecated. Use '{new_name}' instead.",
        DeprecationWarning,
        stacklevel=3
    )


@dataclass
class ReleaseInfo:
    """Information about a release."""
    version: str  # Semantic version: "1.0", "1.6", "2.0.0"
    change_number: int  # Which change this was based on
    message: str
    changelog: str
    created_at: str
    tarball_path: str


def _get_releases_dir(name: str) -> Path:
    """Get the releases directory path for an agent."""
    return AGENTS_DIR / name / ".cast" / "releases"


def _get_releases_json_path(name: str) -> Path:
    """Get the releases.json path for an agent."""
    return _get_releases_dir(name) / "releases.json"


def _stored_tarball_path(filename: str) -> str:
    """Path recorded in releases.json, relative to the agent directory.

    The manifest is committed with the agent, so an absolute path would
    publish the author's home directory and break after a clone or move.
    """
    return f".cast/releases/{filename}"


def _resolve_tarball_path(agent_name: str, stored: Any) -> str:
    """Absolute path used to open a release tarball.

    New manifests store a path relative to the agent directory. Older
    manifests store an absolute path. An absolute path that is missing
    falls back to the same filename under this agent's releases directory,
    which is where a cloned tarball lives.
    """
    if stored is None:
        return ""
    text = str(stored).strip()
    if not text:
        return ""
    path = Path(text)
    agent_dir = Path(AGENTS_DIR) / agent_name
    if not path.is_absolute():
        return str((agent_dir / path).resolve())
    if path.exists():
        return str(path)
    local = agent_dir / ".cast" / "releases" / path.name
    if local.exists():
        return str(local.resolve())
    return str(path)


def _release_info(agent_name: str, entry: dict[str, Any]) -> ReleaseInfo:
    """Build ReleaseInfo, resolving tarball_path for the local agent."""
    data = dict(entry)
    data["tarball_path"] = _resolve_tarball_path(agent_name, data.get("tarball_path"))
    return ReleaseInfo(**data)


def _cast_db_path() -> Path:
    """cast.db beside the agents directory (~/.cast/cast.db).

    When tests point AGENTS_DIR at a temp folder that is not named
    "agents", the database stays inside that folder.
    """
    agents = Path(AGENTS_DIR)
    if agents.name == "agents":
        return agents.parent / "cast.db"
    return agents / "cast.db"


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _parse_created_at(value: Any) -> Optional[datetime]:
    """Parse an ISO or SQLite timestamp into naive UTC."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _format_created_at(value: datetime) -> str:
    """SQLite-sortable UTC timestamp. Fractional seconds keep same-second creates ordered."""
    return value.strftime("%Y-%m-%d %H:%M:%S.%f")


def _load_releases_document(agent_name: str) -> Optional[Dict[str, Any]]:
    releases_json_path = _get_releases_json_path(agent_name)
    if not releases_json_path.exists():
        return None
    with open(releases_json_path, "r") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return None
    return data


def _ensure_releases_schema(conn: sqlite3.Connection) -> None:
    """Create the releases table and add any columns the TS schema already has.

    Mirrors typescript/cast-cli/src/lib/sqlite.ts. ALTER is idempotent and
    does not rewrite or renumber existing rows.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS releases (
            agent_name TEXT,
            version TEXT,
            change_number INTEGER,
            message TEXT,
            changelog TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            tarball_path TEXT,
            PRIMARY KEY (agent_name, version)
        )
        """
    )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(releases)")}
    for name, decl in (
        ("change_number", "INTEGER"),
        ("message", "TEXT"),
        ("changelog", "TEXT"),
        ("created_at", "DATETIME"),
        ("tarball_path", "TEXT"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE releases ADD COLUMN {name} {decl}")


def _sync_releases_from_json(agent_name: str) -> None:
    """Insert releases.json rows missing from SQLite.

    A row that is already stored for (agent_name, version) is not updated,
    so a second create cannot blank message or changelog.
    """
    document = _load_releases_document(agent_name)
    if document is None:
        return
    raw_releases = document.get("releases") or []
    if not isinstance(raw_releases, list) or not raw_releases:
        return

    current_version = None
    current = document.get("current")
    if isinstance(current, dict):
        current_version = current.get("version")

    db_path = _cast_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5, isolation_level=None)
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        _ensure_releases_schema(conn)
        existing_versions = {
            str(row[0])
            for row in conn.execute(
                "SELECT version FROM releases WHERE agent_name = ?",
                (agent_name,),
            )
        }
        existing_times: List[datetime] = []
        for (stamp,) in conn.execute(
            "SELECT created_at FROM releases WHERE agent_name = ? AND created_at IS NOT NULL",
            (agent_name,),
        ):
            parsed = _parse_created_at(stamp)
            if parsed is not None:
                existing_times.append(parsed)

        pending: List[Dict[str, Any]] = []
        seen = set(existing_versions)
        for entry in raw_releases:
            if not isinstance(entry, dict):
                continue
            version = entry.get("version")
            if not version or str(version) in seen:
                continue
            seen.add(str(version))
            pending.append(entry)
        if not pending:
            return

        stamps: List[datetime] = []
        for index, entry in enumerate(pending):
            parsed = _parse_created_at(entry.get("created_at"))
            if parsed is None:
                parsed = datetime(1970, 1, 1) + timedelta(seconds=index)
            stamps.append(parsed)

        if current_version is not None:
            for index, entry in enumerate(pending):
                if str(entry.get("version")) != str(current_version):
                    continue
                others = [stamp for i, stamp in enumerate(stamps) if i != index]
                others.extend(existing_times)
                if others and stamps[index] <= max(others):
                    stamps[index] = max(others) + timedelta(microseconds=1)
                break

        with conn:
            for entry, stamp in zip(pending, stamps):
                conn.execute(
                    """
                    INSERT OR IGNORE INTO releases (
                        agent_name, version, change_number, message,
                        changelog, created_at, tarball_path
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        agent_name,
                        str(entry.get("version")),
                        _coerce_int(entry.get("change_number")),
                        "" if entry.get("message") is None else str(entry.get("message")),
                        "" if entry.get("changelog") is None else str(entry.get("changelog")),
                        _format_created_at(stamp),
                        _resolve_tarball_path(agent_name, entry.get("tarball_path")),
                    ),
                )
    finally:
        conn.close()


def _ensure_releases_dir(name: str) -> Path:
    """Ensure the releases directory exists."""
    releases_dir = _get_releases_dir(name)
    releases_dir.mkdir(parents=True, exist_ok=True)
    return releases_dir


def validate_semver(version: str) -> bool:
    """Validate semantic version format (1.0, 1.6, 2.0.0, etc.)."""
    pattern = r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$|^(0|[1-9]\d*)\.(0|[1-9]\d*)$'
    return bool(re.match(pattern, version))


def get_current_release(agent_name: str) -> Optional[str]:
    """Get the current (latest) semantic version for an agent."""
    _sync_releases_from_json(agent_name)
    releases_json_path = _get_releases_json_path(agent_name)
    if not releases_json_path.exists():
        return None
    with open(releases_json_path, "r") as f:
        data = json.load(f)
    current = data.get("current")
    if current:
        return current.get("version")
    return None


def list_releases(agent_name: str) -> List[ReleaseInfo]:
    """List all releases for an agent."""
    _sync_releases_from_json(agent_name)
    releases_json_path = _get_releases_json_path(agent_name)
    if not releases_json_path.exists():
        return []
    with open(releases_json_path, "r") as f:
        data = json.load(f)
    releases = []
    for r in data.get("releases", []):
        releases.append(_release_info(agent_name, r))
    return sorted(releases, key=lambda r: _version_tuple(r.version), reverse=True)


def _version_tuple(version: str) -> tuple:
    """Convert version string to tuple for sorting."""
    parts = version.split('.')
    return tuple(int(p) for p in parts)


def get_release(agent_name: str, version: str) -> Optional[ReleaseInfo]:
    """Get a specific release."""
    releases_json_path = _get_releases_json_path(agent_name)
    if not releases_json_path.exists():
        return None
    with open(releases_json_path, "r") as f:
        data = json.load(f)
    for r in data.get("releases", []):
        if r.get("version") == version:
            return _release_info(agent_name, r)
    return None


def get_latest_release_change_number(agent_name: str) -> int:
    """Get the change number of the latest release (for changelog generation)."""
    releases = list_releases(agent_name)
    if releases:
        return releases[0].change_number
    return 0


def generate_changelog(agent_name: str, since_change: int = 0) -> str:
    """Generate changelog from changes since a given change number.

    Reads from the changes.json file (formerly versions.json).
    Groups changes by type and generates a human-readable summary.
    """
    changes_json_path = AGENTS_DIR / agent_name / ".cast" / "changes" / "changes.json"
    if not changes_json_path.exists():
        return ""

    with open(changes_json_path, "r") as f:
        data = json.load(f)

    changes = data.get("versions", [])

    # Filter changes after since_change
    relevant_changes = [c for c in changes if c.get("id", 0) > since_change]

    if not relevant_changes:
        return ""

    # Group by message keywords
    features = []
    improvements = []
    patches = []

    for change in relevant_changes:
        msg = change.get("message", "").lower()
        if "added" in msg or "new" in msg or "create" in msg:
            features.append(f"- {change.get('message')}")
        elif "updated" in msg or "change" in msg:
            improvements.append(f"- {change.get('message')}")
        else:
            patches.append(f"- {change.get('message')}")

    lines = []
    if features:
        lines.append("### Features")
        lines.extend(features)
        lines.append("")
    if improvements:
        lines.append("### Improvements")
        lines.extend(improvements)
        lines.append("")
    if patches:
        lines.append("### Bug Fixes")
        lines.extend(patches)
        lines.append("")

    return "\n".join(lines).strip()


def suggest_version(agent_name: str) -> Dict[str, str]:
    """Suggest next semantic version based on recent changes.

    Returns dict with 'patch', 'minor', 'major' suggestions.
    Detects breaking changes (removed tools, permissions changes).
    """
    current = get_current_release(agent_name)
    if not current:
        return {"patch": "0.1.0", "minor": "0.1.0", "major": "1.0.0"}

    parts = current.split('.')
    major = int(parts[0])
    minor = int(parts[1]) if len(parts) > 1 else 0
    patch = int(parts[2]) if len(parts) > 2 else 0

    # Check for breaking changes in recent changes
    latest_change = _get_latest_change_number(agent_name)
    if latest_change > 0:
        changes_json_path = AGENTS_DIR / agent_name / ".cast" / "changes" / "changes.json"
        if changes_json_path.exists():
            with open(changes_json_path, "r") as f:
                data = json.load(f)
            # Look for breaking change indicators
            for change in data.get("versions", []):
                msg = change.get("message", "").lower()
                if "remove" in msg or "delete" in msg or "break" in msg:
                    return {
                        "patch": f"{major}.{minor}.{patch + 1}",
                        "minor": f"{major}.{minor + 1}.0",
                        "major": f"{major + 1}.0.0",
                        "breaking": True
                    }

    return {
        "patch": f"{major}.{minor}.{patch + 1}",
        "minor": f"{major}.{minor + 1}.0",
        "major": f"{major + 1}.0.0"
    }


def _get_latest_change_number(agent_name: str) -> int:
    """Get the current (latest) change number."""
    changes_json_path = AGENTS_DIR / agent_name / ".cast" / "changes" / "changes.json"
    if not changes_json_path.exists():
        return 0
    with open(changes_json_path, "r") as f:
        data = json.load(f)
    return data.get("current", 0)


def create_release(agent_name: str, version: str, message: str = "", agents_dir: Optional[Path] = None) -> ReleaseInfo:
    """Create a semantic release snapshot.

    Args:
        agent_name: The name of the agent.
        version: The semantic version (e.g., "1.6").
        message: Optional release message.
        agents_dir: Optional path to agents directory.

    Returns:
        ReleaseInfo about the created release.
    """
    if agents_dir is None:
        agents_dir = AGENTS_DIR
    agent_path = agents_dir / agent_name

    if not agent_path.exists():
        raise ValueError(f"Agent '{agent_name}' does not exist")

    if not validate_semver(version):
        raise ValueError(f"Invalid semantic version: '{version}'")

    # Ensure releases directory exists
    releases_dir = _ensure_releases_dir(agent_name)

    # Get current change number
    change_number = _get_latest_change_number(agent_name)

    # Generate timestamp
    timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    # Files to include in the snapshot (same as versioning.py)
    files_to_snapshot = [
        "agent.yaml",
        "instructions.md",
    ]

    mcp_dir = agent_path / "mcp"
    if mcp_dir.exists() and any(mcp_dir.iterdir()):
        files_to_snapshot.append("mcp")

    tools_dir = agent_path / "tools"
    if tools_dir.exists() and any(tools_dir.iterdir()):
        files_to_snapshot.append("tools")

    # Create tar.gz archive
    tarball_filename = f"{version}.tar.gz"
    tarball_path = releases_dir / tarball_filename

    with tarfile.open(tarball_path, "w:gz") as tar:
        for file_or_dir in files_to_snapshot:
            file_path = agent_path / file_or_dir
            if file_path.exists():
                tar.add(file_path, arcname=file_or_dir)

    # Generate changelog
    last_release_change = get_latest_release_change_number(agent_name)
    changelog = generate_changelog(agent_name, last_release_change)

    # Persist a path relative to the agent directory. Callers receive
    # the absolute path of the tarball that was just written.
    stored_tarball_path = _stored_tarball_path(tarball_filename)
    release_info = ReleaseInfo(
        version=version,
        change_number=change_number,
        message=message or f"Release {version}",
        changelog=changelog,
        created_at=timestamp,
        tarball_path=stored_tarball_path,
    )

    # Update releases.json
    releases_json_path = _get_releases_json_path(agent_name)
    if releases_json_path.exists():
        with open(releases_json_path, "r") as f:
            releases_data = json.load(f)
    else:
        releases_data = {"releases": [], "current": None}

    releases_data["releases"].append(asdict(release_info))
    releases_data["current"] = {"version": version, "change_number": change_number}

    with open(releases_json_path, "w") as f:
        json.dump(releases_data, f, indent=2)

    # Update agent.yaml version
    agent_yaml_path = agent_path / "agent.yaml"
    if agent_yaml_path.exists():
        import yaml
        with open(agent_yaml_path, "r") as f:
            yaml_data = yaml.safe_load(f) or {}
        yaml_data["version"] = version
        with open(agent_yaml_path, "w") as f:
            yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False)

    # Same writer the CLI, TUI, and builder use. Insert-if-absent so a
    # pre-existing SQLite row is not replaced. SQLite is local to this
    # machine, so the synced row stores the resolved absolute path.
    _sync_releases_from_json(agent_name)

    release_info.tarball_path = str(tarball_path.resolve())
    return release_info


def extract_release(agent_name: str, version: str, target_dir: Path) -> None:
    """Extract a release tarball to a directory.

    Args:
        agent_name: The name of the agent.
        version: The semantic version to extract.
        target_dir: The directory to extract to.
    """
    release = get_release(agent_name, version)
    if not release:
        raise ValueError(f"Release {version} not found for agent '{agent_name}'")

    tarball_path = Path(release.tarball_path)
    if not tarball_path.exists():
        raise FileNotFoundError(f"Release tarball not found: {tarball_path}")

    # Clear existing files in target_dir (except .cast, .git)
    for item in target_dir.iterdir():
        if item.name not in ('.cast', '.git'):
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()

    # Extract tarball
    with tarfile.open(tarball_path, "r:gz") as tar:
        tar.extractall(target_dir)