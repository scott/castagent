"""Resolve tool paths against the agent directory.

`cast dev` and deployed containers set CAST_AGENT_PATH to the agent
root. The process working directory is not that root: locally it is
the shell that launched `cast dev`, and in Docker it is `/app` while
the agent lives at `/app/agent`. Relative paths such as memory/notes.md
have to join CAST_AGENT_PATH or the read tool looks in the wrong place.
"""

import os
from typing import Optional


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
