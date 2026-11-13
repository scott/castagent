"""Resolve tool paths against the agent directory.

`cast dev` and deployed containers set CAST_AGENT_PATH to the agent
root. The process working directory is not that root: locally it is
the shell that launched `cast dev`, and in Docker it is `/app` while
the agent lives at `/app/agent`. Relative paths such as memory/notes.md
have to join CAST_AGENT_PATH or the read tool looks in the wrong place.

Write tools use `resolve_workspace_file`, which refuses a path that
leaves that directory, including through `..` or a symlink.
"""

import os
from typing import Optional


class WorkspacePathError(Exception):
    """A write path is missing, empty, or outside the agent workspace."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def agent_root() -> Optional[str]:
    """Agent directory from CAST_AGENT_PATH, or None when it is unset."""
    root = os.environ.get("CAST_AGENT_PATH")
    if not root:
        return None
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        return None
    return root


def resolve_agent_file(file_path: str) -> str:
    """Absolute paths stay as given. Relative paths join the agent root."""
    if not file_path or os.path.isabs(file_path):
        return file_path
    root = agent_root()
    if root is None:
        return file_path
    return os.path.join(root, file_path)


def _inside(root: str, path: str) -> bool:
    path = os.path.normpath(path)
    return path == root or path.startswith(root + os.sep)


def resolve_workspace_file(file_path: str, *, create_parents: bool = False) -> tuple[str, str]:
    """Return `(workspace_root, file_path)` confined to the agent directory.

    Relative paths join CAST_AGENT_PATH. Absolute paths are kept only
    when they still land inside that directory. `..` is normalized
    before the check. The parent is resolved, and a symlink that points
    outside the workspace is refused. The final path component is not
    followed. Missing parents are created only when `create_parents`
    is true.

    Raises WorkspacePathError with a message that starts with ``Error:``.
    """
    if not isinstance(file_path, str) or not file_path.strip():
        raise WorkspacePathError("Error: file_path is required.")
    if any(char in file_path for char in ("\x00", "\n", "\r")):
        raise WorkspacePathError("Error: file_path contains a control character.")

    root = agent_root()
    if root is None:
        raise WorkspacePathError(
            "Error: No agent workspace. CAST_AGENT_PATH is unset or is not a directory."
        )
    root = os.path.realpath(root)

    candidate = file_path if os.path.isabs(file_path) else os.path.join(root, file_path)
    candidate = os.path.normpath(candidate)
    parent = os.path.dirname(candidate)
    name = os.path.basename(candidate)
    if name in ("", ".", ".."):
        raise WorkspacePathError("Error: Path names a directory, not a file.")
    if not _inside(root, parent):
        raise WorkspacePathError(
            f"Error: Path '{file_path}' is outside the agent workspace."
        )

    parent_real = _ensure_parent(root, parent, create=create_parents)
    destination = os.path.join(parent_real, name)
    if not _inside(root, destination):
        raise WorkspacePathError(
            f"Error: Path '{file_path}' is outside the agent workspace."
        )
    if os.path.islink(destination):
        raise WorkspacePathError("Error: Refusing to follow a symlink.")
    if os.path.isdir(destination):
        raise WorkspacePathError("Error: Path is a directory.")
    return root, destination


def _ensure_parent(root: str, parent: str, *, create: bool) -> str:
    """Resolve parent directories. Create them only when `create` is true."""
    parent = os.path.normpath(parent)
    if parent == root:
        return root
    if not _inside(root, parent):
        raise WorkspacePathError("Error: Path is outside the agent workspace.")

    relative = os.path.relpath(parent, root)
    current = root
    for part in relative.split(os.sep):
        if part in ("", ".", ".."):
            raise WorkspacePathError("Error: Path is outside the agent workspace.")
        nxt = os.path.join(current, part)
        if os.path.islink(nxt):
            resolved = os.path.realpath(nxt)
            if not _inside(root, resolved) or not os.path.isdir(resolved):
                raise WorkspacePathError("Error: Path is outside the agent workspace.")
            current = resolved
            continue
        if os.path.isdir(nxt):
            current = nxt
            continue
        if os.path.exists(nxt):
            raise WorkspacePathError("Error: Path parent is not a directory.")
        if not create:
            raise WorkspacePathError("Error: File not found.")
        try:
            os.mkdir(nxt, 0o755)
        except FileExistsError:
            if not os.path.isdir(nxt) or os.path.islink(nxt):
                raise WorkspacePathError("Error: Path parent is not a directory.")
        current = nxt

    final = os.path.realpath(current)
    if not _inside(root, final) or not os.path.isdir(final):
        raise WorkspacePathError("Error: Path is outside the agent workspace.")
    return final
