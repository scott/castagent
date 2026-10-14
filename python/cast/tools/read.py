import os
from langchain_core.tools import tool

from .paths import resolve_agent_file

@tool
def read_tool(file_path: str, offset: int = 0, limit: int = 100) -> str:
    """
    Read a file and return its contents.

    Relative paths are resolved against the agent directory
    (CAST_AGENT_PATH). Use memory/notes.md for persistent notes.

    Args:
        file_path: Path to the file to read.
        offset: Line offset to start reading from (default: 0).
        limit: Maximum number of lines to read (default: 100).
    """
    try:
        resolved = resolve_agent_file(file_path)
        if not os.path.exists(resolved):
            if resolved != file_path:
                return f"Error: File '{file_path}' not found at '{resolved}'"
            return f"Error: File '{file_path}' not found"

        with open(resolved, "r") as f:
            lines = f.readlines()
        
        start = offset
        end = min(offset + limit, len(lines))
        
        content = "".join(lines[start:end])
        
        if end < len(lines):
            content += f"\n... ({len(lines) - end} more lines)"
        
        return content
    except Exception as e:
        return f"Error reading file: {str(e)}"
