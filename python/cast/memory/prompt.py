"""System-prompt text that tells the agent persistent memory exists."""

from typing import Any

from .permission_memory import format_current_levels

PERSISTENT_MEMORY_INSTRUCTIONS = """## Persistent memory

This agent has persistent memory in the memory/ directory. Those files survive restarts. Relative paths for the read, glob, and bash tools are resolved against the agent directory (CAST_AGENT_PATH), so memory/notes.md is the notes file there.

When the user asks you to remember a fact, including a message that starts with "remember:" or "remember that", the runtime saves it to memory/notes.md and memory/memory.db. Later turns include recent memories from that database. Read memory/notes.md with the read tool when you need the notes. You can update that file with bash. You have persistent memory. Do not say that you lack a memory tool.

Live harness.permissions override memories from past sessions.
A memory that says a tool is denied, disabled, or set to an older level does not change the current level.
"""


def append_persistent_memory_instructions(instructions: str, permissions: Any = None) -> str:
    """Add the persistent-memory section once, after the agent instructions.

    `permissions` is the live harness.permissions mapping. When it is set,
    the section names those levels so they win over older memories.
    """
    text = (instructions or "").rstrip()
    levels = format_current_levels(permissions)
    block = PERSISTENT_MEMORY_INSTRUCTIONS.rstrip()
    if levels:
        block = f"{block}\n\n{levels}"
    if "## Persistent memory" in text:
        if levels and levels not in text:
            return f"{text}\n\n{levels}\n"
        return text + "\n"
    if not text:
        return block + "\n"
    return f"{text}\n\n{block}\n"
