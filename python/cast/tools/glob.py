import glob as glob_module
import os
from langchain_core.tools import tool

from .paths import agent_root

@tool
def glob_tool(pattern: str) -> str:
    """
    Find files matching a glob pattern.

    Relative patterns are resolved against the agent directory
    (CAST_AGENT_PATH).

    Args:
        pattern: Glob pattern to match files (e.g., "**/*.py").
    """
    try:
        root = None if os.path.isabs(pattern) else agent_root()
        if root:
            matches = glob_module.glob(pattern, root_dir=root, recursive=True)
        else:
            matches = glob_module.glob(pattern, recursive=True)
        if not matches:
            return "No files found matching pattern"
        return "\n".join(matches)
    except Exception as e:
        return f"Error: {str(e)}"
