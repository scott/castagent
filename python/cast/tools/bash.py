import ctypes
import os
import select
import subprocess
import threading
import time
from pathlib import Path

from langchain_core.tools import tool

from ..memory.filter import scrub_notes_text
from .paths import agent_root

_NOTES_RELATIVE = Path("memory") / "notes.md"
# Fallback poll when a write is not reported by inotify.
_NOTES_SCRUB_INTERVAL_SECONDS = 0.05
_IN_MODIFY = 0x00000002
_IN_CLOSE_WRITE = 0x00000008
_IN_CREATE = 0x00000100
_IN_MOVED_TO = 0x00000080
_IN_DELETE = 0x00000200
_IN_WATCH_MASK = _IN_MODIFY | _IN_CLOSE_WRITE | _IN_CREATE | _IN_MOVED_TO | _IN_DELETE
_scrub_lock = threading.Lock()
_watcher_lock = threading.Lock()
_inotify_lock = threading.Lock()
_watched_notes: set[Path] = set()
_watcher_thread: threading.Thread | None = None
_inotify_fd = -1
_inotify_libc: ctypes.CDLL | None = None
_inotify_watches: dict[str, int] = {}


def _notes_path() -> Path | None:
    root = agent_root()
    if root is None:
        return None
    return Path(root) / _NOTES_RELATIVE


def _read_notes(path: Path | None) -> bytes | None:
    if path is None or not path.is_file():
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def _scrub_notes_if_changed(path: Path | None, before: bytes | None) -> bytes | None:
    """Redact secrets when a bash command writes memory/notes.md.

    The remember: path scrubs before it appends. Bash is the other write
    path, including a note such as "remember this permanently". Returns
    the bytes now on disk, or None when the file is absent.
    """
    if path is None:
        return None
    with _scrub_lock:
        if not path.is_file():
            return None
        try:
            current = path.read_bytes()
        except OSError:
            return before
        if current == before:
            return current
        try:
            text = current.decode("utf-8")
        except UnicodeDecodeError:
            return current
        scrubbed = scrub_notes_text(text)
        if scrubbed == text:
            return current
        try:
            path.write_text(scrubbed, encoding="utf-8")
        except OSError:
            return current
        try:
            return path.read_bytes()
        except OSError:
            return scrubbed.encode("utf-8")


def _inotify_open() -> None:
    """Open a non-blocking inotify fd, or leave watching to the poll."""
    global _inotify_fd, _inotify_libc
    if _inotify_fd >= 0:
        return
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.inotify_init1.argtypes = [ctypes.c_int]
        libc.inotify_init1.restype = ctypes.c_int
        libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        libc.inotify_add_watch.restype = ctypes.c_int
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
    except (AttributeError, OSError):
        return
    if fd < 0:
        return
    _inotify_fd = fd
    _inotify_libc = libc


def _arm_inotify(notes: Path) -> None:
    """Watch the directory that holds memory/notes.md."""
    if _inotify_fd < 0 or _inotify_libc is None:
        return
    directory = notes.parent if notes.parent.is_dir() else notes.parent.parent
    if not directory.is_dir():
        return
    key = str(directory)
    with _inotify_lock:
        if key in _inotify_watches:
            return
        wd = _inotify_libc.inotify_add_watch(
            _inotify_fd,
            os.fsencode(key),
            _IN_WATCH_MASK,
        )
        if wd >= 0:
            _inotify_watches[key] = wd


def _drain_inotify() -> None:
    if _inotify_fd < 0:
        return
    with _inotify_lock:
        while True:
            try:
                chunk = os.read(_inotify_fd, 8192)
            except BlockingIOError:
                return
            if not chunk:
                return


def _watch_notes_loop() -> None:
    """Scrub notes after the bash tool has already returned.

    The finally block covers a foreground command, which finishes before
    that block runs. A background command can append to memory/notes.md
    later. inotify applies the same scrub when that write closes, and
    the poll covers a write that arrives before the watch is armed.
    """
    last: dict[Path, bytes | None] = {}
    while True:
        if _inotify_fd >= 0:
            with _watcher_lock:
                paths = list(_watched_notes)
            for path in paths:
                _arm_inotify(path)
            try:
                ready, _, _ = select.select(
                    [_inotify_fd],
                    [],
                    [],
                    _NOTES_SCRUB_INTERVAL_SECONDS,
                )
            except (OSError, ValueError):
                ready = []
            if ready:
                _drain_inotify()
        else:
            time.sleep(_NOTES_SCRUB_INTERVAL_SECONDS)
        with _watcher_lock:
            paths = list(_watched_notes)
        for path in paths:
            last[path] = _scrub_notes_if_changed(path, last.get(path))


def _ensure_notes_watcher(path: Path) -> None:
    global _watcher_thread
    with _watcher_lock:
        _watched_notes.add(path)
        _inotify_open()
        _arm_inotify(path)
        if _watcher_thread is not None and _watcher_thread.is_alive():
            return
        _watcher_thread = threading.Thread(
            target=_watch_notes_loop,
            name="cast-notes-scrub",
            daemon=True,
        )
        _watcher_thread.start()


@tool
def bash_tool(command: str) -> str:
    """
    Execute a bash command and return the output.

    The command runs in the agent directory when CAST_AGENT_PATH is set,
    so relative paths such as memory/notes.md refer to that directory.
    A write to memory/notes.md is scanned afterward and provider keys
    are redacted in that file. A background command is scanned the same
    way when it writes the file after this tool returns.

    Args:
        command: The bash command to execute.
    """
    notes = _notes_path()
    before = _read_notes(notes)
    if notes is not None:
        _ensure_notes_watcher(notes)
    try:
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=agent_root(),
            )
            return result.stdout or result.stderr or "Command executed successfully (no output)"
        except subprocess.TimeoutExpired:
            return "Error: Command timed out after 30 seconds"
        except Exception as e:
            return f"Error: {str(e)}"
    finally:
        _scrub_notes_if_changed(notes, before)
