import subprocess
from langchain_core.tools import tool

from .paths import agent_root

@tool
def bash_tool(command: str) -> str:
    """
    Execute a bash command and return the output.

    The command runs in the agent directory when CAST_AGENT_PATH is set,
    so relative paths such as memory/notes.md refer to that directory.

    Args:
        command: The bash command to execute.
    """
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
