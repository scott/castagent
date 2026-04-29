import os
from langchain_core.tools import tool

@tool
def read_tool(file_path: str, offset: int = 0, limit: int = 100) -> str:
    """
    Read a file and return its contents.
    
    Args:
        file_path: Path to the file to read.
        offset: Line offset to start reading from (default: 0).
        limit: Maximum number of lines to read (default: 100).
    """
    try:
        if not os.path.exists(file_path):
            return f"Error: File '{file_path}' not found"
        
        with open(file_path, "r") as f:
            lines = f.readlines()
        
        start = offset
        end = min(offset + limit, len(lines))
        
        content = "".join(lines[start:end])
        
        if end < len(lines):
            content += f"\n... ({len(lines) - end} more lines)"
        
        return content
    except Exception as e:
        return f"Error reading file: {str(e)}"
