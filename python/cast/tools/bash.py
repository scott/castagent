import subprocess
from pathlib import Path

from langchain_core.tools import tool

from ..memory.filter import scrub_notes_text
from .paths import agent_root

_NOTES_RELATIVE = Path("memory") / "notes.md"


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


def _scrub_notes_if_changed(path: Path | None, before: bytes | None) -> None:
    """Redact secrets when a bash command writes memory/notes.md.

    The remember: path scrubs before it appends. Bash is the other write
    path, including a note such as "remember this permanently".
    """
    if path is None or not path.is_file():
        return
    try:
        current = path.read_bytes()
    except OSError:
        return
    if current == before:
        return
    try:
        text = current.decode("utf-8")
    except UnicodeDecodeError:
        return
    scrubbed = scrub_notes_text(text)
    if scrubbed == text:
        return
    try:
        path.write_text(scrubbed, encoding="utf-8")
    except OSError:
        return


@tool
def bash_tool(command: str) -> str:
    """
    Execute a bash command and return the output.

    The command runs in the agent directory when CAST_AGENT_PATH is set,
    so relative paths such as memory/notes.md refer to that directory.
    A write to memory/notes.md is scanned afterward and provider keys
    are redacted in that file.

    Args:
        command: The bash command to execute.
    """
    notes = _notes_path()
    before = _read_notes(notes)
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
