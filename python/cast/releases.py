"""Agent releases module for semantic versioning."""

import json
import os
import sqlite3
import tarfile
import re
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Any, NamedTuple, Optional
from dataclasses import dataclass, asdict

from cast.castignore import is_ignored, load_rules

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


class _VersionField(NamedTuple):
    """One top-level `version:` line, split so only the scalar is replaced."""

    value: str
    prefix: str
    style: Optional[str]
    trail: str


def _semver_key(version: str) -> Optional[tuple]:
    """Pad a valid semver to (major, minor, patch). `1.0` and `1.0.0` match."""
    if not validate_semver(version):
        return None
    parts = [int(part) for part in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def _is_lower_semver(candidate: str, current: str) -> bool:
    """True when candidate is an older semver than current.

    Versions that are not semver do not count as a floor. Comparison is
    numeric, so 1.2 is lower than 1.10.
    """
    left = _semver_key(candidate)
    right = _semver_key(current.strip())
    if left is None or right is None:
        return False
    return left < right


def _read_preserved_text(path: Path) -> str:
    """Read text without translating newlines."""
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def _write_preserved_text(path: Path, text: str) -> None:
    """Write text without translating newlines."""
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def _parse_top_level_version(body: str) -> Optional[_VersionField]:
    """Parse a top-level `version:` scalar. Block values return None."""
    match = re.match(r"^(version)([ \t]*:)(.*)$", body)
    if match is None:
        return None
    key, colon, after = match.group(1), match.group(2), match.group(3)
    space_match = re.match(r"[ \t]*", after)
    spaces = space_match.group(0) if space_match else ""
    rest = after[len(spaces):]
    if rest == "" or rest.startswith("#"):
        return _VersionField("", key + colon, None, spaces + rest)
    if rest[0] in ('"', "'"):
        quote = rest[0]
        end = rest.find(quote, 1)
        if end < 0:
            return None
        return _VersionField(rest[1:end], key + colon + spaces, quote, rest[end + 1:])
    if rest[0] in ("|", ">"):
        return None
    comment_match = re.search(r"[ \t]+#", rest)
    if comment_match:
        value = rest[:comment_match.start()]
        trail = rest[comment_match.start():]
    else:
        value = rest.rstrip(" \t")
        trail = rest[len(value):]
    return _VersionField(value, key + colon + spaces, None, trail)


def _bare_version_is_yaml_string(version: str) -> bool:
    """True when an unquoted version stays a string under YAML 1.1.

    PyYAML reads `1.0` and `1.10` as floats. `1.0.0` stays a string.
    """
    return bool(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version))


def _render_version_scalar(version: str, style: Optional[str]) -> str:
    """Render a version scalar that loads back as a string.

    An existing quote style is kept. A bare two-part version is quoted
    so PyYAML does not turn it into a float.
    """
    if style == '"':
        return f'"{version}"'
    if style == "'":
        return f"'{version}'"
    if _bare_version_is_yaml_string(version):
        return version
    return f'"{version}"'


def _join_version_line(prefix: str, scalar: str, trail: str) -> str:
    if trail.startswith("#") and not prefix.endswith((" ", "\t")):
        return f"{prefix}{scalar} {trail}"
    return f"{prefix}{scalar}{trail}"


def _read_agent_yaml_version(path: Path) -> Optional[str]:
    """Return the top-level version scalar as written.

    Reading the line avoids PyYAML turning an unquoted `1.10` into `1.1`.
    """
    if not path.is_file():
        return None
    text = _read_preserved_text(path)
    for line in text.splitlines():
        parsed = _parse_top_level_version(line)
        if parsed is not None:
            return parsed.value
    try:
        import yaml
        data = yaml.safe_load(text) or {}
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    value = data.get("version")
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        return f"{int(value)}.0"
    return str(value).strip()


def _set_agent_yaml_version(path: Path, version: str) -> None:
    """Replace the top-level version scalar and leave every other byte alone.

    yaml.dump rewrites quotes and list indentation. A release only needs
    the version field to change.
    """
    if not path.is_file():
        return
    original = _read_preserved_text(path)
    pieces = original.splitlines(keepends=True)
    saw_unparsed = False
    for index, line in enumerate(pieces):
        ending = ""
        body = line
        if body.endswith("\r\n"):
            body, ending = body[:-2], "\r\n"
        elif body.endswith("\n"):
            body, ending = body[:-1], "\n"
        elif body.endswith("\r"):
            body, ending = body[:-1], "\r"
        if re.match(r"version[ \t]*:", body) is None:
            continue
        parsed = _parse_top_level_version(body)
        if parsed is None:
            saw_unparsed = True
            continue
        if parsed.value == version:
            return
        scalar = _render_version_scalar(version, parsed.style)
        pieces[index] = _join_version_line(parsed.prefix, scalar, parsed.trail) + ending
        _write_preserved_text(path, "".join(pieces))
        return
    if saw_unparsed:
        raise ValueError(
            "Could not update agent.yaml version without rewriting the file"
        )
    if "\r\n" in original:
        newline = "\r\n"
    elif "\r" in original:
        newline = "\r"
    else:
        newline = "\n"
    updated = original
    if updated and not updated.endswith(("\n", "\r")):
        updated += newline
    updated += f'version: "{version}"{newline}'
    _write_preserved_text(path, updated)


def _read_optional_bytes(path: Path) -> Optional[bytes]:
    """Return a file's bytes, or None when the path is not a file."""
    if not path.is_file():
        return None
    return path.read_bytes()


def _restore_optional_bytes(path: Path, previous: Optional[bytes]) -> None:
    """Restore a file to the bytes it had before a release write.

    None means the file did not exist and must be removed.
    """
    if previous is None:
        if path.is_file():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(previous)


def create_release(agent_name: str, version: str, message: str = "", agents_dir: Optional[Path] = None) -> ReleaseInfo:
    """Create a semantic release snapshot.

    A version lower than agent.yaml is rejected and no files are changed.
    On success, only the version field in agent.yaml is updated. The
    tarball is then the working tree (project files except .castignore
    paths, .cast/, and .git/), so it records that version. tarball_path
    in releases.json is relative to the agent directory.

    The tarball, releases.json, agent.yaml, and SQLite row are one
    release. If any of those writes fail, the files are restored to the
    bytes they had before this call.

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

    agent_yaml_path = agent_path / "agent.yaml"
    current_yaml_version = _read_agent_yaml_version(agent_yaml_path)
    if current_yaml_version is not None and _is_lower_semver(version, current_yaml_version):
        raise ValueError(
            f"Release version '{version}' is lower than agent.yaml version '{current_yaml_version}'"
        )

    # Get current change number
    change_number = _get_latest_change_number(agent_name)

    # Generate timestamp
    timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    # Changelog reads the previous release. Compute it before writing so a
    # failure here does not leave a tarball behind.
    last_release_change = get_latest_release_change_number(agent_name)
    changelog = generate_changelog(agent_name, last_release_change)

    # Ensure releases directory exists
    releases_dir = _ensure_releases_dir(agent_name)
    tarball_filename = f"{version}.tar.gz"
    tarball_path = releases_dir / tarball_filename
    releases_json_path = _get_releases_json_path(agent_name)
    previous_tarball = _read_optional_bytes(tarball_path)
    previous_json = _read_optional_bytes(releases_json_path)
    previous_yaml = _read_optional_bytes(agent_yaml_path)

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

    if previous_json is None:
        releases_data = {"releases": [], "current": None}
    else:
        releases_data = json.loads(previous_json.decode("utf-8"))

    releases_data["releases"].append(asdict(release_info))
    releases_data["current"] = {"version": version, "change_number": change_number}

    try:
        # Stamp agent.yaml before packing so the tarball and the working
        # copy record the same release version. Only the version scalar
        # changes. The snapshot is the agent working tree: the configured
        # prompt, skills, tools, mcp, tests, and any other project file.
        # .castignore paths are left out. .cast (undo log and this archive)
        # and .git stay on disk and are not packed.
        if previous_yaml is not None:
            _set_agent_yaml_version(agent_yaml_path, version)

        with tarfile.open(tarball_path, "w:gz") as tar:
            for full, rel in _iter_snapshot_paths(agent_path):
                tar.add(full, arcname=rel, recursive=False, filter=_reject_metadata)

        with open(releases_json_path, "w") as f:
            json.dump(releases_data, f, indent=2)

        # Same writer the CLI, TUI, and builder use. Insert-if-absent so a
        # pre-existing SQLite row is not replaced. SQLite is local to this
        # machine, so the synced row stores the resolved absolute path.
        _sync_releases_from_json(agent_name)
    except Exception:
        _restore_optional_bytes(tarball_path, previous_tarball)
        _restore_optional_bytes(releases_json_path, previous_json)
        _restore_optional_bytes(agent_yaml_path, previous_yaml)
        raise

    release_info.tarball_path = str(tarball_path.resolve())
    return release_info


def extract_release(agent_name: str, version: str, target_dir: Path) -> None:
    """Replace a working tree with a release snapshot.

    Files in the tarball are written over target_dir. Project files that
    are not in the release are removed. Paths matched by .castignore, plus
    .cast/ and .git/, are left in place.

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

    with tarfile.open(tarball_path, "r:gz") as tar:
        members = []
        archived: set[str] = set()
        for member in tar.getmembers():
            name = _safe_member_name(member.name)
            if name is None:
                continue
            members.append(member)
            archived.add(name)
        _remove_unreleased(target_dir, archived, load_rules(target_dir))
        _extract_members(tar, target_dir, members)


def _iter_snapshot_paths(agent_path: Path) -> list[tuple[Path, str]]:
    """Project files and directories to pack, in tar-friendly order."""
    rules = load_rules(agent_path)
    items: list[tuple[Path, str]] = []
    for dirpath, dirnames, filenames in os.walk(agent_path, followlinks=False):
        rel_dir = Path(dirpath).relative_to(agent_path).as_posix()
        if rel_dir == ".":
            rel_dir = ""
        kept: list[str] = []
        for dirname in dirnames:
            rel = f"{rel_dir}/{dirname}" if rel_dir else dirname
            full = Path(dirpath) / dirname
            if full.is_symlink():
                if not _snapshot_excluded(rel, False, rules):
                    items.append((full, rel))
                continue
            if _snapshot_excluded(rel, True, rules):
                continue
            kept.append(dirname)
            items.append((full, rel))
        dirnames[:] = kept
        for filename in filenames:
            rel = f"{rel_dir}/{filename}" if rel_dir else filename
            full = Path(dirpath) / filename
            if _snapshot_excluded(rel, False, rules):
                continue
            if not (full.is_symlink() or full.is_file()):
                continue
            items.append((full, rel))
    return items


def _snapshot_excluded(rel: str, is_dir: bool, rules: list) -> bool:
    if _preserved(rel):
        return True
    return is_ignored(rel, is_dir, rules)


def _preserved(rel: str) -> bool:
    """Cast bookkeeping and the git repo are not part of a release."""
    return rel == ".cast" or rel.startswith(".cast/") or rel == ".git" or rel.startswith(".git/")


def _reject_metadata(info: tarfile.TarInfo) -> Optional[tarfile.TarInfo]:
    if _safe_member_name(info.name) is None or _preserved(info.name.replace("\\", "/").strip("/")):
        return None
    return info


def _safe_member_name(name: str) -> Optional[str]:
    rel = name.replace("\\", "/").strip("/")
    while rel.startswith("./"):
        rel = rel[2:]
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    if _preserved(rel):
        return None
    return rel


def _extract_members(tar: tarfile.TarFile, target: Path, members: list) -> None:
    """Extract members. filter='data' is the safe default on Python 3.12+."""
    try:
        tar.extractall(target, members=members, filter="data")
    except TypeError:
        tar.extractall(target, members=members)


def _remove_unreleased(target: Path, archived: set[str], rules: list) -> None:
    """Delete project files that are not in the release snapshot."""
    for dirpath, dirnames, filenames in os.walk(target, topdown=True, followlinks=False):
        rel_dir = Path(dirpath).relative_to(target).as_posix()
        if rel_dir == ".":
            rel_dir = ""
        kept: list[str] = []
        for dirname in list(dirnames):
            rel = f"{rel_dir}/{dirname}" if rel_dir else dirname
            full = Path(dirpath) / dirname
            if full.is_symlink():
                if rel not in archived and not _preserved(rel) and not is_ignored(rel, False, rules):
                    full.unlink()
                continue
            if _preserved(rel) or is_ignored(rel, True, rules):
                continue
            kept.append(dirname)
        dirnames[:] = kept
        for filename in filenames:
            rel = f"{rel_dir}/{filename}" if rel_dir else filename
            if rel in archived or _preserved(rel) or is_ignored(rel, False, rules):
                continue
            (Path(dirpath) / filename).unlink()

    for dirpath, _dirnames, _filenames in os.walk(target, topdown=False, followlinks=False):
        rel_dir = Path(dirpath).relative_to(target).as_posix()
        if rel_dir == ".":
            continue
        if _preserved(rel_dir) or is_ignored(rel_dir, True, rules) or rel_dir in archived:
            continue
        current = Path(dirpath)
        if current.is_symlink():
            current.unlink()
            continue
        if current.is_dir() and not any(current.iterdir()):
            current.rmdir()