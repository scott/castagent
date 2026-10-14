"""System-prompt text that tells the agent persistent memory exists."""

PERSISTENT_MEMORY_INSTRUCTIONS = """## Persistent memory

This agent has persistent memory in the memory/ directory. Those files survive restarts. Relative paths for the read, glob, and bash tools are resolved against the agent directory (CAST_AGENT_PATH), so memory/notes.md is the notes file there.

When the user asks you to remember a fact, including a message that starts with "remember:" or "remember that", the runtime saves it to memory/notes.md and memory/memory.db. Later turns include recent memories from that database. Read memory/notes.md with the read tool when you need the notes. You can update that file with bash. You have persistent memory. Do not say that you lack a memory tool.
"""


def append_persistent_memory_instructions(instructions: str) -> str:
    """Add the persistent-memory section once, after the agent instructions."""
    text = (instructions or "").rstrip()
    if "## Persistent memory" in text:
        return text + "\n"
    if not text:
        return PERSISTENT_MEMORY_INSTRUCTIONS
    return f"{text}\n\n{PERSISTENT_MEMORY_INSTRUCTIONS}"
