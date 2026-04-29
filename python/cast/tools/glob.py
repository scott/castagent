import glob as glob_module
from langchain_core.tools import tool

@tool
def glob_tool(pattern: str) -> str:
    """
    Find files matching a glob pattern.
    
    Args:
        pattern: Glob pattern to match files (e.g., "**/*.py").
    """
    try:
        matches = glob_module.glob(pattern, recursive=True)
        if not matches:
            return "No files found matching pattern"
        return "\n".join(matches)
    except Exception as e:
        return f"Error: {str(e)}"
