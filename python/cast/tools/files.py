"""Write and edit files inside the agent workspace.

Both tools refuse a path that leaves CAST_AGENT_PATH. They are write
tools: a missing harness.permissions entry defaults to ask.
"""

import os

from langchain_core.tools import tool

from ..memory.filter import scrub_notes_text
from .paths import WorkspacePathError, resolve_workspace_file

# A source file or a patch is far smaller than this. The cap stops a
# single tool call from filling the machine disk.
MAX_WRITE_BYTES = 8 * 1024 * 1024
_NOTES_RELATIVE = "memory/notes.md"


def _logical_notes_path(file_path: str, root: str) -> bool:
    """True when the caller named memory/notes.md, before symlink resolution."""
    logical = file_path.replace("\\", "/").strip()
    if os.path.isabs(file_path):
        logical = os.path.normpath(file_path)
        try:
            logical = os.path.relpath(logical, root)
        except ValueError:
            return False
        logical = logical.replace("\\", "/")
    while logical.startswith("./"):
        logical = logical[2:]
    return logical == _NOTES_RELATIVE


def _is_notes_target(root: str, destination: str, file_path: str) -> bool:
    relative = os.path.relpath(destination, root).replace(os.sep, "/")
    if relative == _NOTES_RELATIVE:
        return True
    return _logical_notes_path(file_path, root)


def _prepare_text(root: str, destination: str, file_path: str, content: str) -> bytes:
    if not isinstance(content, str):
        raise WorkspacePathError("Error: content must be text.")
    if _is_notes_target(root, destination, file_path):
        content = scrub_notes_text(content)
    try:
        data = content.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise WorkspacePathError("Error: content is not valid text.") from exc
    if len(data) > MAX_WRITE_BYTES:
        raise WorkspacePathError(
            f"Error: content is {len(data)} bytes, over the {MAX_WRITE_BYTES} byte limit. "
            "The file was not written."
        )
    return data


def _read_text(destination: str) -> str:
    try:
        fd = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError as exc:
        raise WorkspacePathError("Error: File not found.") from exc
    except OSError as exc:
        raise WorkspacePathError(f"Error: Could not read file: {exc.strerror or exc}.") from exc
    try:
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_WRITE_BYTES:
                raise WorkspacePathError(
                    f"Error: File is over the {MAX_WRITE_BYTES} byte limit and was not edited."
                )
            chunks.append(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkspacePathError("Error: File is not UTF-8 text and was not edited.") from exc


def _write_bytes(destination: str, data: bytes) -> None:
    parent = os.path.dirname(destination)
    name = os.path.basename(destination)
    temporary = os.path.join(parent, f".{name}.{os.urandom(8).hex()}.tmp")
    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o644,
    )
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fsync(fd)
    except Exception:
        os.close(fd)
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    os.close(fd)
    try:
        if os.path.islink(destination):
            raise WorkspacePathError("Error: Refusing to follow a symlink.")
        os.replace(temporary, destination)
    except WorkspacePathError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _workspace_error(exc: WorkspacePathError) -> str:
    return exc.message


@tool
def write_file(file_path: str, content: str) -> str:
    """
    Create or replace a UTF-8 text file inside the agent workspace.

    Relative paths are resolved against the agent directory
    (CAST_AGENT_PATH). An absolute path is written only when it is
    inside that directory. Paths that leave the workspace, including
    with .. or a symlink, are refused. Parent directories inside the
    workspace are created. memory/notes.md is scanned and provider
    keys are redacted before the write. This is a write tool and
    defaults to ask.

    Args:
        file_path: File to write, inside the agent workspace.
        content: Full text to store. Existing contents are replaced.
    """
    try:
        root, destination = resolve_workspace_file(file_path, create_parents=True)
        data = _prepare_text(root, destination, file_path, content)
        _write_bytes(destination, data)
    except WorkspacePathError as exc:
        return _workspace_error(exc)
    except OSError as exc:
        return f"Error: Could not write file: {exc.strerror or exc}."
    return f"Wrote {len(data)} bytes to {file_path}"


@tool
def edit_file(file_path: str, old_string: str, new_string: str) -> str:
    """
    Replace one exact occurrence of old_string with new_string.

    old_string must appear exactly once. Zero matches, or more than
    one, leaves the file unchanged. The path must stay inside the
    agent workspace (CAST_AGENT_PATH). A symlink is not followed.
    memory/notes.md is scanned and provider keys are redacted after
    the edit. This is a write tool and defaults to ask.

    Args:
        file_path: File to edit, inside the agent workspace.
        old_string: Exact text to replace. It must be unique in the file.
        new_string: Text that replaces old_string. An empty string deletes it.
    """
    if not isinstance(old_string, str) or old_string == "":
        return "Error: old_string is required. The file was not changed."
    if not isinstance(new_string, str):
        return "Error: new_string must be text. The file was not changed."
    if old_string == new_string:
        return "Error: old_string and new_string are the same. The file was not changed."
    try:
        root, destination = resolve_workspace_file(file_path)
        original = _read_text(destination)
        count = original.count(old_string)
        if count == 0:
            return "Error: old_string was not found. The file was not changed."
        if count > 1:
            return (
                f"Error: old_string appears {count} times. "
                "Provide a longer unique string. The file was not changed."
            )
        updated = original.replace(old_string, new_string, 1)
        data = _prepare_text(root, destination, file_path, updated)
        _write_bytes(destination, data)
    except WorkspacePathError as exc:
        return _workspace_error(exc)
    except OSError as exc:
        return f"Error: Could not edit file: {exc.strerror or exc}."
    return f"Edited {file_path}"
