"""Safe reads and writes of agent snapshot archives.

Snapshot tarballs are data. A symlink or hard link member can point
extractall at a directory outside the destination, and the next member
is then written through that link. Every extract path in this package
goes through ``safe_extract``.
"""

import inspect
import os
import shutil
import tarfile
from pathlib import Path
from typing import Optional


class UnsafeArchiveError(Exception):
    """An archive member is a link or would write outside the destination."""


def data_filter_supported() -> bool:
    """Return True when tarfile.extractall accepts filter='data'."""
    if not hasattr(tarfile, "data_filter"):
        return False
    try:
        parameters = inspect.signature(tarfile.TarFile.extractall).parameters
    except (TypeError, ValueError):
        return False
    return "filter" in parameters


def omit_unsafe_member(info: tarfile.TarInfo) -> Optional[tarfile.TarInfo]:
    """Drop links and special files while packing a snapshot.

    Regular files and directories are kept. A symlink under mcp/ or
    tools/ is not recorded, so a later restore cannot follow it.
    """
    if _is_link(info) or _unsafe_link_target(info.linkname or ""):
        return None
    if not info.isdir() and not info.isreg():
        return None
    return info


def reject_link_member(info: tarfile.TarInfo) -> None:
    """Raise when a member is a symlink, a hard link, or names an unsafe target."""
    if _is_link(info):
        raise UnsafeArchiveError(f"refusing link member {info.name!r}")
    linkname = info.linkname or ""
    if _unsafe_link_target(linkname):
        raise UnsafeArchiveError(
            f"refusing link target {linkname!r} on member {info.name!r}"
        )


def safe_extract(
    tar: tarfile.TarFile,
    target: Path,
    members: Optional[list] = None,
) -> None:
    """Extract archive members inside ``target``.

    Link members and link targets that are absolute or contain ``..``
    are refused before anything is written. On Python 3.12 and newer
    the remaining members are extracted with ``filter="data"``. Older
    Pythons never fall back to an unfiltered ``extractall``; they write
    regular files and directories after the same checks.
    """
    selected = list(tar.getmembers() if members is None else members)
    for info in selected:
        reject_link_member(info)
        _reject_name_and_kind(info)

    root = _prepare_directory(Path(target))
    for info in selected:
        _checked_destination(root, info.name)

    if data_filter_supported():
        _extract_with_data_filter(tar, root, selected)
        return

    for info in selected:
        _extract_one(tar, root, info)


def _is_link(info: tarfile.TarInfo) -> bool:
    return bool(
        info.issym()
        or info.islnk()
        or info.type in (tarfile.SYMTYPE, tarfile.LNKTYPE)
    )


def _unsafe_link_target(linkname: str) -> bool:
    """True when a link target is absolute or contains a parent segment."""
    if not linkname:
        return False
    raw = linkname.replace("\\", "/")
    if raw.startswith("/"):
        return True
    if len(raw) >= 2 and raw[1] == ":":
        return True
    return ".." in raw.split("/")


def _normalized_parts(name: str) -> Optional[list]:
    rel = name.replace("\\", "/").strip()
    if not rel or rel.startswith("/"):
        return None
    if len(rel) >= 2 and rel[1] == ":":
        return None
    while rel.startswith("./"):
        rel = rel[2:]
    rel = rel.strip("/")
    if not rel:
        return None
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return parts


def _reject_name_and_kind(info: tarfile.TarInfo) -> None:
    if _normalized_parts(info.name) is None:
        raise UnsafeArchiveError(f"refusing member name {info.name!r}")
    if not info.isdir() and not info.isreg():
        raise UnsafeArchiveError(f"refusing special member {info.name!r}")


def _prepare_directory(target: Path) -> Path:
    if target.is_symlink():
        raise UnsafeArchiveError("refusing to extract through a symlink")
    target.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or not target.is_dir():
        raise UnsafeArchiveError("refusing to extract through a symlink")
    return target


def _checked_destination(root: Path, name: str) -> Path:
    parts = _normalized_parts(name)
    if parts is None:
        raise UnsafeArchiveError(f"refusing member name {name!r}")
    resolved_root = root.resolve()
    current = root
    for part in parts:
        if current.is_symlink():
            raise UnsafeArchiveError(f"refusing to follow symlink {current}")
        current = current / part
    if current.is_symlink():
        raise UnsafeArchiveError(f"refusing to follow symlink {current}")
    resolved = current.resolve()
    if os.path.commonpath([str(resolved), str(resolved_root)]) != str(resolved_root):
        raise UnsafeArchiveError(
            f"member {name!r} would be extracted outside {resolved_root}"
        )
    return current


def _extract_with_data_filter(
    tar: tarfile.TarFile,
    root: Path,
    members: list,
) -> None:
    """Pass filter='data'. Do not catch TypeError and extract again."""
    extractall = tar.extractall
    extractall(root, members, filter="data")  # type: ignore[call-arg]


def _data_file_mode(info: tarfile.TarInfo) -> int:
    mode = 0 if info.mode is None else info.mode
    mode &= 0o755
    if not mode & 0o100:
        mode &= ~0o111
    mode |= 0o600
    return mode


def _extract_one(tar: tarfile.TarFile, root: Path, info: tarfile.TarInfo) -> None:
    dest = _checked_destination(root, info.name)
    if info.isdir():
        if dest.exists() and not dest.is_dir():
            raise UnsafeArchiveError(f"refusing to replace non-directory {info.name!r}")
        dest.mkdir(parents=True, exist_ok=True)
        return
    if not info.isreg():
        raise UnsafeArchiveError(f"refusing special member {info.name!r}")
    if dest.is_dir():
        raise UnsafeArchiveError(f"refusing to replace directory {info.name!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = _checked_destination(root, info.name)
    source = tar.extractfile(info)
    if source is None:
        raise UnsafeArchiveError(f"refusing unreadable member {info.name!r}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(dest, flags, 0o600)
    except OSError as exc:
        raise UnsafeArchiveError(f"refusing to write member {info.name!r}") from exc
    with source, os.fdopen(fd, "wb") as handle:
        shutil.copyfileobj(source, handle)
        os.fchmod(handle.fileno(), _data_file_mode(info))
