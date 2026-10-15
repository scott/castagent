"""Agent undo/redo.

This module is the user-facing surface for the change log. The change
log (an append-only tarball timeline at ~/.cast/agents/<name>/.cast/changes/)
still exists; it just isn't surfaced as a "changes" command any more.
Instead, the user uses `cast undo` and `cast redo` to step backwards and
forwards through the timeline.

Internally, the changes feed gets one new piece of state: a `redo_stack`.
When the user undoes, the most recent change is extracted and pushed
onto the redo stack. When the user redoes, the most recently undone
change is reapplied and popped from the stack. Any new edit clears the
redo stack (standard editor behavior).
"""

import json
import shutil
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import yaml

from cast.tar_safety import safe_extract
from cast.versioning import (
    AGENTS_DIR,
    _get_changes_dir,
    _get_changes_json_path,
    _get_version_filename,
    _ensure_changes_dir,
    create_version,
    list_versions,
    VersioningError,
)


@dataclass
class ChangeRecord:
    """A single entry in the change log."""
    id: int
    timestamp: str
    source: str
    message: str


class UndoError(Exception):
    """Raised when undo/redo cannot proceed."""


# Git and skills commands write these agent.yaml keys without recording
# an undo snapshot. A snapshot that omits them must not drop the live
# sections. Keys the snapshot does contain are restored from the snapshot.
_UNTRACKED_AGENT_YAML_KEYS = ("repository", "skills")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_changes_file(agent_name: str) -> dict:
    """Read the canonical changes.json for an agent."""
    changes_json = _get_changes_json_path(agent_name)
    if not changes_json.exists():
        return {"versions": [], "current": 0, "redo_stack": []}
    with open(changes_json, "r") as f:
        data = json.load(f)
    if "redo_stack" not in data:
        # Older files don't have a redo stack. Initialize it.
        data["redo_stack"] = []
    return data


def _save_changes_file(agent_name: str, data: dict) -> None:
    changes_json = _get_changes_json_path(agent_name)
    changes_json.parent.mkdir(parents=True, exist_ok=True)
    with open(changes_json, "w") as f:
        json.dump(data, f, indent=2)


def _merged_agent_yaml(snapshot_text: str, current_text: str) -> Optional[str]:
    """Keep live agent.yaml sections the snapshot does not contain.

    Returns None when the snapshot file can be copied unchanged. A parse
    failure also returns None so the caller copies the snapshot bytes.
    """
    try:
        snapshot_data = yaml.safe_load(snapshot_text)
        current_data = yaml.safe_load(current_text)
    except yaml.YAMLError:
        return None
    if not isinstance(snapshot_data, dict) or not isinstance(current_data, dict):
        return None

    changed = False
    for key in _UNTRACKED_AGENT_YAML_KEYS:
        if key not in snapshot_data and key in current_data:
            snapshot_data[key] = current_data[key]
            changed = True
    if not changed:
        return None
    try:
        return yaml.safe_dump(snapshot_data, default_flow_style=False, sort_keys=False)
    except yaml.YAMLError:
        return None


def _replace_path(src: Path, dest: Path) -> None:
    """Replace dest with a copy of src. dest's parent is created."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_symlink() or (dest.exists() and not dest.is_dir()):
        dest.unlink()
    elif dest.is_dir():
        shutil.rmtree(dest)
    if src.is_symlink():
        dest.symlink_to(src.readlink())
        return
    shutil.copy2(src, dest)


def _overlay_path(src: Path, dest: Path) -> None:
    """Copy src onto dest. Files dest already has that src does not contain stay."""
    if src.is_dir() and not src.is_symlink():
        if dest.is_symlink() or (dest.exists() and not dest.is_dir()):
            dest.unlink()
        dest.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            _overlay_path(child, dest / child.name)
        return
    _replace_path(src, dest)


def _extract_change(agent_name: str, change_id: int, target_dir: Path) -> None:
    """Copy one change tarball onto `target_dir`.

    The archive records agent.yaml, instructions.md, and mcp/ or tools/
    only when those directories have files. Copy those paths back and
    leave every other project file in place. Do not remove a file just
    because this snapshot omitted it.
    """
    changes_dir = _get_changes_dir(agent_name)
    tarball = changes_dir / _get_version_filename(change_id)
    if not tarball.exists():
        raise UndoError(f"Change {change_id} is missing its archive at {tarball}")

    # Use a temp dir to avoid touching in-place
    temp_extract = changes_dir / "_undo_temp"
    if temp_extract.exists():
        shutil.rmtree(temp_extract)
    temp_extract.mkdir()

    try:
        with tarfile.open(tarball, "r:gz") as tar:
            safe_extract(tar, temp_extract)

        for item in temp_extract.iterdir():
            dest = target_dir / item.name
            if item.name == "agent.yaml" and item.is_file() and dest.is_file():
                merged = _merged_agent_yaml(item.read_text(), dest.read_text())
                if merged is not None:
                    dest.write_text(merged)
                    continue
            _overlay_path(item, dest)
    finally:
        if temp_extract.exists():
            shutil.rmtree(temp_extract)


def can_undo(agent_name: str) -> bool:
    """Return True if there is at least one change to undo."""
    if not _get_changes_json_path(agent_name).exists():
        return False
    data = _load_changes_file(agent_name)
    return data.get("current", 0) > 0


def can_redo(agent_name: str) -> bool:
    """Return True if there is at least one change on the redo stack."""
    if not _get_changes_json_path(agent_name).exists():
        return False
    data = _load_changes_file(agent_name)
    return len(data.get("redo_stack", [])) > 0


def undo(agent_name: str, steps: int = 1, message: str = "") -> List[ChangeRecord]:
    """Undo the last `steps` changes for an agent.

    Each undone change is pushed onto the redo stack so it can be
    brought back with `redo()`. The current change number is set to
    (current - steps).

    Returns the list of undone ChangeRecords, newest first.

    Raises UndoError if there aren't enough changes to undo.
    """
    if steps < 1:
        raise UndoError("steps must be >= 1")

    if not _get_changes_json_path(agent_name).exists():
        raise UndoError(f"No change log for agent '{agent_name}'.")

    data = _load_changes_file(agent_name)
    current = data.get("current", 0)
    if current == 0:
        raise UndoError(f"Nothing to undo for agent '{agent_name}'.")

    if steps > current:
        raise UndoError(
            f"Cannot undo {steps} step(s) — only {current} change(s) on the log."
        )

    # Compute the target change number BEFORE we snapshot. We want
    # the snapshot to land at the next unused id (current + 1), not
    # at `target`, which would overwrite an existing tarball.
    target = current - steps

    # Push the entries we're about to remove onto the redo stack.
    versions = data.get("versions", [])
    by_id = {v["id"]: v for v in versions}
    undone: List[ChangeRecord] = []
    for cid in range(current, target, -1):
        v = by_id.get(cid)
        if v is None:
            continue
        record = ChangeRecord(
            id=v["id"],
            timestamp=v.get("timestamp", ""),
            source=v.get("source", ""),
            message=v.get("message", ""),
        )
        data.setdefault("redo_stack", []).append(
            {
                "id": record.id,
                "timestamp": record.timestamp,
                "source": record.source,
                "message": record.message,
                "undone_at": _now_iso(),
            }
        )
        undone.append(record)

    # Persist the redo stack to disk BEFORE the snapshot, so the
    # snapshot's preserve_redo_stack=True inherits our entries.
    _save_changes_file(agent_name, data)

    # Snapshot the current working tree. The snapshot gets id (current+1)
    # which never collides with an existing entry.
    snapshot_message = message or f"Undo of v{current}"
    create_version(
        agent_name,
        source="undo",
        message=snapshot_message,
        preserve_redo_stack=True,
    )

    # Apply the target state
    _extract_change(agent_name, target, AGENTS_DIR / agent_name)

    # Update the change log: current -> target. The snapshot entry
    # remains in the version list (it captures the pre-undo state
    # for audit / display).
    data = _load_changes_file(agent_name)
    data["current"] = target
    data["redo_stack"] = data.get("redo_stack", [])
    _save_changes_file(agent_name, data)

    return undone


def redo(agent_name: str, steps: int = 1, message: str = "") -> List[ChangeRecord]:
    """Redo the last `steps` previously-undone changes for an agent.

    The top `steps` entries are popped from the redo stack, the
    working tree is restored to the most recent popped state, and the
    current change number is set to that entry's id.

    Returns the list of redone ChangeRecords, oldest first.
    """
    if steps < 1:
        raise UndoError("steps must be >= 1")

    if not _get_changes_json_path(agent_name).exists():
        raise UndoError(f"No change log for agent '{agent_name}'.")

    data = _load_changes_file(agent_name)
    stack: list = data.get("redo_stack", [])
    if not stack:
        raise UndoError(f"Nothing to redo for agent '{agent_name}'.")

    if steps > len(stack):
        raise UndoError(
            f"Cannot redo {steps} step(s) — only {len(stack)} on the redo stack."
        )

    # Pop the entries we're going to redo. `popped` is built in
    # reverse-chronological order (newest first) because
    # stack.pop() returns the most recent entry each time. We
    # persist the popped stack to disk BEFORE the snapshot so
    # the snapshot's preserve_redo_stack=True inherits the
    # already-popped stack (so the snapshot doesn't see the
    # entries we're about to redo).
    popped: List[dict] = []
    for _ in range(steps):
        popped.append(stack.pop())

    data["redo_stack"] = stack
    _save_changes_file(agent_name, data)

    # Snapshot the current working tree. Id is (current + 1) and
    # never collides.
    snapshot_message = message or f"Redo of v{data.get('current', 0)}"
    create_version(
        agent_name,
        source="redo",
        message=snapshot_message,
        preserve_redo_stack=True,
    )

    # Apply the most recently popped state (highest id) and set the
    # current pointer to that id.
    redone: List[ChangeRecord] = []
    for entry in popped:
        redone.append(
            ChangeRecord(
                id=entry["id"],
                timestamp=entry.get("timestamp", ""),
                source=entry.get("source", ""),
                message=entry.get("message", ""),
            )
        )

    if redone:
        # Redo the entries in chronological order: oldest first, so
        # the working tree ends at the newest redone state.
        popped.reverse()
        for entry in popped:
            _extract_change(agent_name, entry["id"], AGENTS_DIR / agent_name)
        top = redone[-1]
        data = _load_changes_file(agent_name)
        data["current"] = top.id
        data["redo_stack"] = stack
        _save_changes_file(agent_name, data)
    else:
        # Should be unreachable given the checks above, but keep for safety
        data["redo_stack"] = stack
        _save_changes_file(agent_name, data)

    return redone


def get_undo_history(agent_name: str) -> List[ChangeRecord]:
    """Return the change log (newest first) for an agent, plus the
    redo stack (oldest first). Useful for the TUI modal."""
    if not _get_changes_json_path(agent_name).exists():
        return []
    versions = list_versions(agent_name)
    return versions


def get_redo_stack(agent_name: str) -> List[ChangeRecord]:
    """Return the redo stack (oldest first) for an agent."""
    if not _get_changes_json_path(agent_name).exists():
        return []
    data = _load_changes_file(agent_name)
    return [
        ChangeRecord(
            id=entry["id"],
            timestamp=entry.get("timestamp", ""),
            source=entry.get("source", ""),
            message=entry.get("message", ""),
        )
        for entry in data.get("redo_stack", [])
    ]


def clear_redo_stack(agent_name: str) -> None:
    """Drop the redo stack. Called when a fresh edit is made after an
    undo (standard editor behavior)."""
    if not _get_changes_json_path(agent_name).exists():
        return
    data = _load_changes_file(agent_name)
    data["redo_stack"] = []
    _save_changes_file(agent_name, data)
