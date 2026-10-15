"""Agent versioning module for creating and managing agent snapshots.

This module handles automatic version snapshots (changes).
For semantic releases, use the releases module instead.
"""

import fcntl
import json
import os
import tarfile
import shutil
import tempfile
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict

from cast.tar_safety import omit_unsafe_member, safe_extract

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
class VersionInfo:
    """Information about a single version."""
    id: int
    timestamp: str
    source: str  # "create", "cli", "builder"
    message: str


class VersioningError(Exception):
    """Exception raised for versioning errors."""
    pass


def _get_versions_dir(name: str) -> Path:
    """Get the versions directory path for an agent."""
    return AGENTS_DIR / name / ".cast" / "versions"


def _get_versions_json_path(name: str) -> Path:
    """Get the versions.json path for an agent."""
    return _get_versions_dir(name) / "versions.json"


def _get_changes_dir(name: str) -> Path:
    """Get the changes directory path for an agent (canonical location)."""
    return AGENTS_DIR / name / ".cast" / "changes"


def _get_changes_json_path(name: str) -> Path:
    """Get the changes.json path for an agent (canonical location)."""
    return _get_changes_dir(name) / "changes.json"


def _ensure_versions_dir(name: str) -> Path:
    """Ensure the versions directory exists."""
    versions_dir = _get_versions_dir(name)
    versions_dir.mkdir(parents=True, exist_ok=True)
    return versions_dir


def _ensure_changes_dir(name: str) -> Path:
    """Ensure the changes directory exists (canonical location)."""
    changes_dir = _get_changes_dir(name)
    changes_dir.mkdir(parents=True, exist_ok=True)
    return changes_dir


def _get_version_filename(version_id: int) -> str:
    """Get the filename for a version archive."""
    # Use both sequential number and timestamp for naming
    return f"{version_id:03d}.tar.gz"


def _version_id_value(entry: Any) -> int:
    """Positive integer id, or 0 when the entry has none."""
    if not isinstance(entry, dict):
        return 0
    value = entry.get("id")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return 0
    return value


def _allocate_version_id(entries: List[Any], changes_dir: Path) -> int:
    """Next unused id, from the log and from tarballs already on disk.

    Two builder tools can snapshot the same agent in parallel. The id has
    to be chosen from the document that will be written, not from an
    earlier read, or both snapshots store `"id": 2`.
    """
    used = {_version_id_value(entry) for entry in entries}
    used.discard(0)
    candidate = max(used) + 1 if used else 1
    while candidate in used or (changes_dir / f"{candidate:03d}.tar.gz").exists():
        candidate += 1
    return candidate


def _get_next_version_id(name: str) -> int:
    """Get the next version ID for a new version.

    Uses the maximum existing version id + 1 (rather than `current + 1`)
    so that snapshots taken after an undo (which sets `current` below
    the latest existing id) don't overwrite an existing tarball.
    """
    # Try canonical location first, fall back to old location
    changes_json = _get_changes_json_path(name)
    changes_dir = _get_changes_dir(name)
    if changes_json.exists():
        with open(changes_json, "r") as f:
            data = json.load(f)
            versions = data.get("versions", [])
            if isinstance(versions, list):
                return _allocate_version_id(versions, changes_dir)
            return 1

    versions_json = _get_versions_json_path(name)
    if versions_json.exists():
        with open(versions_json, "r") as f:
            data = json.load(f)
            versions = data.get("versions", [])
            if isinstance(versions, list):
                return _allocate_version_id(versions, changes_dir)
            return 1
    return 1


def create_version(agent_name: str, source: str = "builder", message: str = "", agents_dir: Optional[Path] = None, preserve_redo_stack: bool = False) -> VersionInfo:
    """
    Create a version snapshot of the current agent state.

    Args:
        agent_name: The name of the agent.
        source: The source of the change ("create", "cli", "builder",
            "undo", "redo"). System sources like "undo" and "redo"
            pass preserve_redo_stack=True so the snapshot doesn't
            invalidate the user's redo path.
        message: Optional description of the changes.
        agents_dir: Optional path to agents directory. Defaults to AGENTS_DIR.
        preserve_redo_stack: When True, the call does NOT clear the
            redo_stack field. Used internally by cast.undo to record
            snapshots without invalidating the user's redo path.

    Returns:
        VersionInfo about the created version.
    """
    if agents_dir is None:
        agents_dir = AGENTS_DIR
    agent_path = agents_dir / agent_name

    if not agent_path.exists():
        raise VersioningError(f"Agent '{agent_name}' does not exist")

    # Default message if not provided. Computed before the lock so the
    # critical section only allocates an id and writes the snapshot.
    if not message:
        if source == "create":
            message = "Initial version"
        elif source == "cli":
            message = "Updated via CLI"
        elif source == "undo":
            message = "Auto-snapshot before undo"
        elif source == "redo":
            message = "Auto-snapshot before redo"
        else:
            message = "Updated via builder agent"

    # Snapshots live next to the agent this call was given. The global
    # helpers stay on AGENTS_DIR for undo and list.
    changes_dir = agents_dir / agent_name / ".cast" / "changes"
    versions_dir = agents_dir / agent_name / ".cast" / "versions"
    changes_dir.mkdir(parents=True, exist_ok=True)
    versions_dir.mkdir(parents=True, exist_ok=True)

    # Files to include in the snapshot
    files_to_snapshot = [
        "agent.yaml",
        "instructions.md",
    ]

    # Add MCP configs if they exist
    mcp_dir = agent_path / "mcp"
    if mcp_dir.exists() and any(mcp_dir.iterdir()):
        files_to_snapshot.append("mcp")

    # Add tools directory if it exists and has content
    tools_dir = agent_path / "tools"
    if tools_dir.exists() and any(tools_dir.iterdir()):
        files_to_snapshot.append("tools")

    lock_path = changes_dir / ".lock"
    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            return _write_version_snapshot(
                agent_path,
                changes_dir,
                versions_dir,
                files_to_snapshot,
                source,
                message,
                preserve_redo_stack,
            )
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _write_version_snapshot(
    agent_path: Path,
    changes_dir: Path,
    versions_dir: Path,
    files_to_snapshot: List[str],
    source: str,
    message: str,
    preserve_redo_stack: bool,
) -> VersionInfo:
    """Allocate an id and write the tarball plus changes.json. Caller holds the lock."""
    changes_json_path = changes_dir / "changes.json"
    versions_json_path = versions_dir / "versions.json"

    if changes_json_path.exists():
        with open(changes_json_path, "r") as handle:
            changes_data = json.load(handle)
        prior = changes_data.get("versions", [])
    else:
        changes_data = {"versions": [], "current": 0, "redo_stack": []}
        prior = []
        if versions_json_path.exists():
            with open(versions_json_path, "r") as handle:
                legacy = json.load(handle)
            if isinstance(legacy, dict) and isinstance(legacy.get("versions"), list):
                prior = legacy["versions"]

    if not isinstance(changes_data, dict):
        changes_data = {"versions": [], "current": 0, "redo_stack": []}
    if not isinstance(changes_data.get("versions"), list):
        changes_data["versions"] = []
    if not isinstance(prior, list):
        prior = list(changes_data["versions"])

    version_id = _allocate_version_id(prior, changes_dir)
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    version_filename = _get_version_filename(version_id)
    version_path = changes_dir / version_filename

    with tarfile.open(version_path, "w:gz") as tar:
        for file_or_dir in files_to_snapshot:
            file_path = agent_path / file_or_dir
            if file_path.exists():
                tar.add(
                    file_path,
                    arcname=file_or_dir,
                    filter=omit_unsafe_member,
                )

    # Any fresh edit invalidates the undo redo stack: a user who
    # edits after an undo has explicitly diverged from the redo path.
    # Mirrors the behavior of standard text editors. The preserve
    # flag lets cast.undo snapshot the working tree mid-undo/redo
    # without losing the user's redo path.
    if not preserve_redo_stack and changes_data.get("redo_stack"):
        changes_data["redo_stack"] = []

    version_info = VersionInfo(
        id=version_id,
        timestamp=timestamp,
        source=source,
        message=message
    )
    changes_data["versions"].append(asdict(version_info))
    changes_data["current"] = version_id

    with open(changes_json_path, "w") as handle:
        json.dump(changes_data, handle, indent=2)

    # Also update versions.json for backward compatibility (migration)
    # Copy the changes data to versions.json to keep them in sync
    if versions_json_path.exists():
        with open(versions_json_path, "w") as handle:
            json.dump(changes_data, handle, indent=2)

    return version_info


def get_current_version(agent_name: str) -> int:
    """
    Get the current (latest) version number for an agent.

    Args:
        agent_name: The name of the agent.

    Returns:
        The current version number, or 0 if no versions exist.
    """
    # Try canonical location first
    changes_json_path = _get_changes_json_path(agent_name)
    if changes_json_path.exists():
        with open(changes_json_path, "r") as f:
            changes_data = json.load(f)
        return changes_data.get("current", 0)

    # Fall back to old versions location
    versions_json_path = _get_versions_json_path(agent_name)
    if versions_json_path.exists():
        with open(versions_json_path, "r") as f:
            versions_data = json.load(f)
        return versions_data.get("current", 0)

    return 0


def get_version_info(agent_name: str, version: int) -> Optional[VersionInfo]:
    """
    Get information about a specific version.

    Args:
        agent_name: The name of the agent.
        version: The version number to look up.

    Returns:
        VersionInfo for the specified version, or None if not found.
    """
    # Try canonical location first
    changes_json_path = _get_changes_json_path(agent_name)
    if changes_json_path.exists():
        with open(changes_json_path, "r") as f:
            changes_data = json.load(f)
        for v in changes_data.get("versions", []):
            if v.get("id") == version:
                return VersionInfo(**v)

    # Fall back to old versions location
    versions_json_path = _get_versions_json_path(agent_name)
    if versions_json_path.exists():
        with open(versions_json_path, "r") as f:
            versions_data = json.load(f)
        for v in versions_data.get("versions", []):
            if v.get("id") == version:
                return VersionInfo(**v)

    return None


def list_versions(agent_name: str) -> List[VersionInfo]:
    """
    List all versions for an agent.

    Args:
        agent_name: The name of the agent.

    Returns:
        List of VersionInfo objects, sorted by version ID (newest first).
    """
    # Try canonical location first
    changes_json_path = _get_changes_json_path(agent_name)
    if changes_json_path.exists():
        with open(changes_json_path, "r") as f:
            changes_data = json.load(f)
        versions = []
        for v in changes_data.get("versions", []):
            versions.append(VersionInfo(**v))
        return sorted(versions, key=lambda v: v.id, reverse=True)

    # Fall back to old versions location
    versions_json_path = _get_versions_json_path(agent_name)
    if versions_json_path.exists():
        with open(versions_json_path, "r") as f:
            versions_data = json.load(f)
        versions = []
        for v in versions_data.get("versions", []):
            versions.append(VersionInfo(**v))
        return sorted(versions, key=lambda v: v.id, reverse=True)

    return []


def revert_to_version(agent_name: str, version_id: Optional[int] = None, message: str = "") -> VersionInfo:
    """
    Revert an agent to a specific version.

    Creates a snapshot of the current state before reverting,
    then extracts the selected version.

    Args:
        agent_name: The name of the agent.
        version_id: The version to revert to (default: latest).
        message: Optional message for the revert version.

    Returns:
        VersionInfo about the newly created revert version.
    """
    agent_path = AGENTS_DIR / agent_name
    changes_dir = _get_changes_dir(agent_name)

    if not agent_path.exists():
        raise VersioningError(f"Agent '{agent_name}' does not exist")

    if not changes_dir.exists():
        raise VersioningError(f"No versions found for agent '{agent_name}'")

    # Get the target version
    versions = list_versions(agent_name)
    if not versions:
        raise VersioningError(f"No versions found for agent '{agent_name}'")

    if version_id is None:
        # Default to latest
        target_version = versions[-1]
    else:
        target_version = next((v for v in versions if v.id == version_id), None)
        if target_version is None:
            raise VersioningError(f"Version {version_id} not found for agent '{agent_name}'")

    # Create a snapshot of current state before reverting
    revert_message = message or f"Reverted to version {target_version.id}"
    create_version(agent_name, source="cli", message=revert_message, agents_dir=AGENTS_DIR)

    # Extract the target version
    version_filename = _get_version_filename(target_version.id)
    version_path = changes_dir / version_filename

    with tarfile.open(version_path, "r:gz") as tar:
        # Extract to a temporary location
        temp_extract = changes_dir / "_temp_extract"
        temp_extract.mkdir(exist_ok=True)

        try:
            safe_extract(tar, temp_extract)

            # Restore files to agent directory
            for item in temp_extract.iterdir():
                dest = agent_path / item.name
                if item.is_dir():
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(item, dest)
                else:
                    shutil.copy2(item, dest)
        finally:
            # Clean up temp directory
            if temp_extract.exists():
                shutil.rmtree(temp_extract)

    # Return info about the new revert version (newest is first in the
    # list since list_versions sorts newest-first)
    new_versions = list_versions(agent_name)
    return new_versions[0]


def get_version_details(agent_name: str, version_id: int) -> Optional[Dict[str, Any]]:
    """
    Get details about a specific version.

    Args:
        agent_name: The name of the agent.
        version_id: The version ID.

    Returns:
        Dictionary with version details, or None if not found.
    """
    versions = list_versions(agent_name)
    version = next((v for v in versions if v.id == version_id), None)

    if version is None:
        return None

    return asdict(version)


def get_version_archive_path(agent_name: str, version_id: int) -> Optional[Path]:
    """
    Get the path to a version archive file.

    Args:
        agent_name: The name of the agent.
        version_id: The version ID.

    Returns:
        Path to the archive file, or None if not found.
    """
    versions_dir = _get_versions_dir(agent_name)
    version_filename = _get_version_filename(version_id)
    version_path = versions_dir / version_filename

    if version_path.exists():
        return version_path
    return None


def diff_versions(agent_name: str, version1_id: int, version2_id: int) -> Dict[str, Any]:
    """
    Compare two versions of an agent.

    Args:
        agent_name: The name of the agent.
        version1_id: The first version ID.
        version2_id: The second version ID.

    Returns:
        Dictionary with diff results for each file.
    """
    agent_path = AGENTS_DIR / agent_name

    if not agent_path.exists():
        raise VersioningError(f"Agent '{agent_name}' does not exist")

    result = {}

    # Helper to extract and compare files from two versions
    def compare_files(file_paths: list) -> None:
        for file_path in file_paths:
            v1_path = get_version_archive_path(agent_name, version1_id)
            v2_path = get_version_archive_path(agent_name, version2_id)

            if not v1_path or not v2_path:
                continue

            # Extract to temp directories
            with tempfile.TemporaryDirectory() as tmpdir:
                # Extract version 1
                with tarfile.open(v1_path, "r:gz") as tar:
                    safe_extract(tar, Path(tmpdir))
                v1_full_path = Path(tmpdir) / file_path

                # Extract version 2 (need a different temp dir)
                with tempfile.TemporaryDirectory() as tmpdir2:
                    with tarfile.open(v2_path, "r:gz") as tar:
                        safe_extract(tar, Path(tmpdir2))
                    v2_full_path = Path(tmpdir2) / file_path

                    v1_content = v1_full_path.read_text() if v1_full_path.exists() else None
                    v2_content = v2_full_path.read_text() if v2_full_path.exists() else None

                    if v1_content is None and v2_content is None:
                        continue
                    elif v1_content != v2_content:
                        result[file_path] = {
                            "changed": True,
                            "v1_exists": v1_content is not None,
                            "v2_exists": v2_content is not None,
                            "v1_content": v1_content[:500] if v1_content else None,
                            "v2_content": v2_content[:500] if v2_content else None,
                        }

    # Compare agent.yaml and instructions.md
    compare_files(["agent.yaml", "instructions.md"])

    # Compare MCP configs
    versions_dir = _get_versions_dir(agent_name)
    v1_path = get_version_archive_path(agent_name, version1_id)
    v2_path = get_version_archive_path(agent_name, version2_id)

    if v1_path and v2_path:
        with tempfile.TemporaryDirectory() as tmpdir:
            with tarfile.open(v1_path, "r:gz") as tar:
                safe_extract(tar, Path(tmpdir))
            mcp_dir_v1 = Path(tmpdir) / "mcp"

            with tempfile.TemporaryDirectory() as tmpdir2:
                with tarfile.open(v2_path, "r:gz") as tar:
                    safe_extract(tar, Path(tmpdir2))
                mcp_dir_v2 = Path(tmpdir2) / "mcp"

                mcp_changes = {}
                all_mcp_files = set()

                if mcp_dir_v1.exists():
                    all_mcp_files.update(f.name for f in mcp_dir_v1.iterdir())
                if mcp_dir_v2.exists():
                    all_mcp_files.update(f.name for f in mcp_dir_v2.iterdir())

                for mcp_file in all_mcp_files:
                    v1_mcp = mcp_dir_v1 / mcp_file
                    v2_mcp = mcp_dir_v2 / mcp_file

                    v1_content = v1_mcp.read_text() if v1_mcp.exists() else None
                    v2_content = v2_mcp.read_text() if v2_mcp.exists() else None

                    if v1_content != v2_content:
                        mcp_changes[mcp_file] = {
                            "changed": True,
                            "v1_exists": v1_content is not None,
                            "v2_exists": v2_content is not None,
                        }

                if mcp_changes:
                    result["mcp"] = mcp_changes

    return result


# ============================================================================
# Backward Compatibility Aliases (deprecated - for changes/versions migration)
# ============================================================================

def _get_versions_dir_legacy(name: str) -> Path:
    """Legacy alias for _get_versions_dir (deprecated)."""
    _emit_deprecation_warning("_get_versions_dir_legacy", "_get_versions_dir")
    return _get_versions_dir(name)


def _get_versions_json_path_legacy(name: str) -> Path:
    """Legacy alias for _get_versions_json_path (deprecated)."""
    _emit_deprecation_warning("_get_versions_json_path_legacy", "_get_versions_json_path")
    return _get_versions_json_path(name)


def _get_changes(name: str) -> Dict[str, Any]:
    """Get all changes for an agent.

    This function reads from the canonical changes/ location.

    Returns:
        Dictionary with 'versions' list and 'current' id.
    """
    changes_json_path = _get_changes_json_path(name)
    if changes_json_path.exists():
        with open(changes_json_path, "r") as f:
            return json.load(f)

    # Fall back to old versions location for migration
    versions_json_path = _get_versions_json_path(name)
    if versions_json_path.exists():
        with open(versions_json_path, "r") as f:
            return json.load(f)

    return {"versions": [], "current": 0}