import asyncio
import inspect
import json
import os
import re
import sqlite3
import sys
import traceback
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence
from typing import Annotated

AGENTS_DIR = Path.home() / ".cast" / "agents"
CAST_DB_PATH = Path.home() / ".cast" / "cast.db"


def is_agent_deployed(agent_name: str) -> bool:
    """Check if an agent has a deployment record in the database.
    
    Args:
        agent_name: The name of the agent to check.
        
    Returns:
        True if the agent is deployed (has a deployment record with a URL).
    """
    if not CAST_DB_PATH.exists():
        return False
    try:
        conn = sqlite3.connect(str(CAST_DB_PATH))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT 1 FROM deployments WHERE agent_name = ? AND deployment_url IS NOT NULL",
            (agent_name,)
        )
        result = cursor.fetchone()
        conn.close()
        return result is not None
    except sqlite3.Error:
        return False


def get_deployed_version(agent_name: str) -> Optional[str]:
    """Get the currently deployed version of an agent.
    
    Args:
        agent_name: The name of the agent.
        
    Returns:
        The deployed version string, or None if not deployed or no version recorded.
    """
    if not CAST_DB_PATH.exists():
        return None
    try:
        conn = sqlite3.connect(str(CAST_DB_PATH))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT deployed_version FROM deployments WHERE agent_name = ? ORDER BY deployed_at DESC LIMIT 1",
            (agent_name,)
        )
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else None
    except sqlite3.Error:
        return None


def get_changes_since_release(agent_name: str) -> int:
    """Get the number of changes since the last release.
    
    Args:
        agent_name: The name of the agent.
        
    Returns:
        The number of changes since the last release, or the total change count if no releases.
    """
    from cast.releases import get_latest_release_change_number
    from cast.versioning import get_current_version
    
    last_release_change = get_latest_release_change_number(agent_name)
    current_change = get_current_version(agent_name)
    
    return max(0, current_change - last_release_change)


def check_and_prompt_for_release(agent_name: str) -> Optional[str]:
    """
    Check if a release should be created and prompt the user.
    
    This function checks if the agent is deployed and has changes since
    the last release. If so, it displays a prompt with version suggestions.
    
    Args:
        agent_name: The name of the agent.
        
    Returns:
        The version string to release, or None if skipped/no release needed.
    """
    # Check if agent is deployed
    if not is_agent_deployed(agent_name):
        return None
    
    # Check for changes since last release
    try:
        changes_since_last = get_changes_since_release(agent_name)
    except Exception:
        return None
    
    if changes_since_last <= 0:
        return None
    
    # Get version suggestions
    from cast.releases import suggest_version, get_current_release
    
    current = get_current_release(agent_name)
    suggestions = suggest_version(agent_name)
    deployed_version = get_deployed_version(agent_name)
    
    # Display the release prompt
    print("", file=sys.stderr)
    print("╔══════════════════════════════════════════════════════════════╗", file=sys.stderr)
    print("║  Agent is deployed - consider creating a release             ║", file=sys.stderr)
    print("╚══════════════════════════════════════════════════════════════╝", file=sys.stderr)
    print("", file=sys.stderr)
    print(f"  Changes since last release: {changes_since_last}", file=sys.stderr)
    print(f"  Last release: {current or 'none'}", file=sys.stderr)
    print(f"  Currently deployed: {deployed_version or 'unknown'}", file=sys.stderr)
    print("", file=sys.stderr)
    print("  Suggested versions:", file=sys.stderr)
    print(f"    [1] {suggestions['patch']} (patch)", file=sys.stderr)
    print(f"    [2] {suggestions['minor']} (minor)", file=sys.stderr)
    print(f"    [3] {suggestions['major']} (major)", file=sys.stderr)
    print(f"    [4] Custom version", file=sys.stderr)
    print(f"    [5] Skip (save changes only)", file=sys.stderr)
    print("", file=sys.stderr)
    
    try:
        choice = input("Select option (1-5): ").strip()
    except EOFError:
        return None
    
    if choice == '1':
        return suggestions['patch']
    elif choice == '2':
        return suggestions['minor']
    elif choice == '3':
        return suggestions['major']
    elif choice == '4':
        try:
            version = input("Enter version (e.g., 1.6): ").strip()
            return version if version else None
        except EOFError:
            return None
    else:
        return None


def load_global_config() -> dict:
    """Load the global Cast config from ~/.cast/config.yaml."""
    config_path = Path.home() / ".cast" / "config.yaml"
    if config_path.exists():
        try:
            return yaml.safe_load(config_path.read_text()) or {}
        except Exception:
            pass
    return {}


def get_raw_builder_model() -> str:
    """Return ``defaults.builder_model`` without stripping a provider prefix.

    ``get_builder_model`` strips ``openrouter/`` for display. Provider
    selection and the API call must use this raw string instead.
    """
    config = load_global_config()
    defaults = config.get("defaults") or {}
    model = defaults.get("builder_model", "openrouter/minimax/minimax-m2.5")
    if not isinstance(model, str) or not model:
        return "openrouter/minimax/minimax-m2.5"
    return model


def get_builder_model() -> str:
    """Get the builder model from config, defaulting to a sensible fallback."""
    model = get_raw_builder_model()
    # Strip openrouter/ prefix for display
    if model.startswith("openrouter/"):
        model = model[len("openrouter/"):]
    return model

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from .builder_tools import (
    create_agent,
    check_name_availability,
    deploy_agent,
    get_agent_config,
    install_mcp,
    list_agents,
    read_file,
    recommend_model,
    suggest_name,
    update_agent_config,
    update_instructions,
)

# Load system prompt
SYSTEM_PROMPT_PATH = Path.home() / ".cast" / "builder" / "instructions.md"
DEFAULT_SYSTEM_PROMPT = """# Cast Builder Agent

You are the Cast Builder Agent, designed to help users create AI agents.

## Your Mission

Through conversation, understand what the user wants their agent to do, then:
1. Create the agent scaffold in ~/.cast/agents/<agent-name>/
2. Configure MCP integrations they need
3. Recommend appropriate models
4. Ensure the agent is ready to run

## Your Personality

- **Curious but focused**: Ask clarifying questions
- **Helpful and proactive**: Suggest useful tools
- **Transparent**: Explain what you're doing
- **Security-conscious**: Recommend appropriate permissions

## Security Guidelines

- Never suggest always-allow for destructive operations
- Recommend approve-once for sending/deleting
- Be explicit about what data the agent will access
"""


_SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_SKILL_FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", re.DOTALL)
_SKILLS_INTRO = (
    "## Skills\n"
    "\n"
    "Follow these skills while you help the developer create or edit a Cast agent.\n"
    "They describe how you do the work. Do not copy a skill into\n"
    "~/.cast/agents/<name>/ unless the developer asks."
)


def _builder_dir() -> Path:
    """Return ~/.cast/builder, resolved when called so tests can isolate HOME."""
    return Path.home() / ".cast" / "builder"


def ensure_builder_skills_dir() -> None:
    """Create ~/.cast/builder/skills/ when it is missing.

    An empty folder is valid. This does not create instructions.md.
    """
    path = _builder_dir() / "skills"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Warning: could not create builder skills directory: {exc}", file=sys.stderr)


def _collapse_skill_description(description: str) -> str:
    """Join a folded or literal YAML description into one line."""
    return " ".join(line.strip() for line in description.splitlines() if line.strip())


def _parse_skill_markdown(text: str) -> Optional[tuple[str, str, str]]:
    """Return (name, description, body) or None when frontmatter is invalid."""
    cleaned = text.lstrip("\ufeff")
    match = _SKILL_FRONTMATTER_RE.match(cleaned)
    if not match:
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    description = data.get("description")
    if not isinstance(name, str) or _SKILL_NAME_RE.fullmatch(name) is None:
        return None
    if not isinstance(description, str):
        return None
    description = _collapse_skill_description(description)
    if not description:
        return None
    return name, description, match.group(2)


def _load_builder_skills() -> List[tuple[str, str, str]]:
    """Load valid builder skills, skipping bad ones. Sorted by frontmatter name."""
    skills_dir = _builder_dir() / "skills"
    if not skills_dir.is_dir():
        return []
    try:
        children = sorted(skills_dir.iterdir(), key=lambda path: path.name)
    except OSError as exc:
        print(f"Warning: could not read builder skills: {exc}", file=sys.stderr)
        return []

    loaded: List[tuple[str, str, str]] = []
    for child in children:
        if not child.is_dir() or child.name.startswith("."):
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            print(
                f"Skipping builder skill '{child.name}': SKILL.md is missing",
                file=sys.stderr,
            )
            continue
        try:
            text = skill_md.read_text()
        except OSError as exc:
            print(f"Skipping builder skill '{child.name}': {exc}", file=sys.stderr)
            continue
        parsed = _parse_skill_markdown(text)
        if parsed is None:
            print(
                f"Skipping builder skill '{child.name}': invalid frontmatter",
                file=sys.stderr,
            )
            continue
        loaded.append(parsed)
    loaded.sort(key=lambda item: item[0])
    return loaded


def _render_skills_section(skills: Sequence[tuple[str, str, str]]) -> str:
    """Format the ## Skills section appended to the builder prompt."""
    chunks = [_SKILLS_INTRO]
    for name, description, body in skills:
        text = body[1:] if body.startswith("\n") else body
        text = text.replace("\r\n", "\n").rstrip("\n")
        block = f"### {name}\n{description}"
        if text:
            block += f"\n\n{text}"
        chunks.append(block)
    return "\n\n".join(chunks) + "\n"


def load_system_prompt() -> str:
    """Load the builder prompt, then append builder skills when any are valid.

    The base text is ~/.cast/builder/instructions.md when that file exists,
    otherwise DEFAULT_SYSTEM_PROMPT. A missing or empty skills folder leaves
    that text unchanged. The running builder reads this once, at startup.
    """
    instructions = _builder_dir() / "instructions.md"
    if instructions.is_file():
        base = instructions.read_text()
    else:
        base = DEFAULT_SYSTEM_PROMPT
    skills = _load_builder_skills()
    if not skills:
        return base
    return base.rstrip("\n") + "\n\n" + _render_skills_section(skills)


class EchoChatModel(BaseChatModel):
    """A simple echo/chat model that works without API keys.

    Parses user intent and returns appropriate responses or tool calls.
    Supports both normal mode and new-mode (wizard) flow.
    """

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self._new_mode = os.getenv("CAST_NEW_MODE") == "1"
        self._agent_name: Optional[str] = None

    def set_new_mode(self, enabled: bool) -> None:
        """Set whether the model should use new-mode behavior."""
        self._new_mode = enabled

    def set_agent_name(self, name: Optional[str]) -> None:
        """Set the current agent name for context-aware tool calls."""
        self._agent_name = name

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        # Initialize tool call tracking at the top
        content = ""
        tool_calls: List[dict] = []
        call_id = 0

        def next_call_id() -> str:
            nonlocal call_id
            call_id += 1
            return f"call_{call_id}"

        # Helper to extract server name from a message
        def extract_server_name_from_msg(msg_text: str) -> Optional[str]:
            msg_lower = msg_text.lower()
            patterns = [
                r'(?:mcp|install)\s+(?:server\s+)?["\']?([\w-]+)["\']?',
                r'(?:server\s+["\']?)([\w-]+)["\']?',
            ]
            for pattern in patterns:
                match = re.search(pattern, msg_lower)
                if match:
                    return match.group(1)
            for server in ["gmail", "slack", "github", "notion", "linear", "discord", "twitter", "postgres", "mysql"]:
                if server in msg_lower:
                    return server
            return None

        # Helper to extract agent name from a message
        def extract_agent_name_from_msg(msg_text: str) -> Optional[str]:
            msg_lower = msg_text.lower()
            patterns = [
                r'(?:agent\s+(?:called|named))\s+["\']?([\w-]+)["\']?',
                r'(?:for\s+agent)\s+["\']?([\w-]+)["\']?',
                r'(?:create\s+(?:an?\s+)?agent\s+(?:called|named)\s+)["\']?([\w-]+)["\']?',
                r'(?:name\s+(?:it\s+)?)["\']?([\w-]+)["\']?',
                r'^([\w-]+)\s*$',
            ]
            for pattern in patterns:
                match = re.search(pattern, msg_lower)
                if match:
                    return match.group(1)
            desc_patterns = [
                r'create\s+(?:an?\s+)([\w-]+)\s+agent',
                r'create\s+(?:an?\s+)?agent\s+(?:that\s+(?:reads?|handles?|manages?|sends?|deletes?|writes?|get))\s+([\w-]+)',
            ]
            for pattern in desc_patterns:
                match = re.search(pattern, msg_lower)
                if match:
                    base = match.group(1)
                    if base not in ['an', 'a', 'the', 'my', 'me']:
                        return f"{base}-agent"
            if any(k in msg_lower for k in ["delete", "remove", "destroy"]):
                return "file-deletion-agent"
            return None

        # Check if we're in new mode using instance state (falls back to env for compatibility)
        new_mode = self._new_mode

        # Get the last user message
        last_user_msg = ""
        for msg in reversed(messages):
            if isinstance(msg, HumanMessage):
                last_user_msg = str(msg.content)
                break

        lower_msg = last_user_msg.lower()

        # Extract agent description for new mode
        def extract_description(msg_text: str = "") -> str:
            """Extract a description from a user message."""
            text = msg_text or last_user_msg
            # Remove common prefixes
            cleaned = text
            prefixes = [
                r'^\s*(?:i\s+want\s+(?:an?\s+)?)?(?:agent\s+(?:that\s+)?)?',
                r'^\s*(?:create\s+(?:an?\s+)?)?(?:agent\s+(?:that\s+)?)?',
                r'^\s*(?:make\s+(?:an?\s+)?)?(?:agent\s+(?:that\s+)?)?',
            ]
            for prefix in prefixes:
                cleaned = re.sub(prefix, '', cleaned, flags=re.IGNORECASE)
            return cleaned.strip()

        # If the last message is a ToolMessage, we're in a follow-up after tool execution.
        if messages and isinstance(messages[-1], ToolMessage):
            tool_result = str(messages[-1].content)

            # Find the original user message that triggered this tool call
            original_user_msg = ""
            for msg in reversed(messages):
                if isinstance(msg, HumanMessage):
                    original_user_msg = str(msg.content)
                    break

            if "suggested name" in tool_result.lower():
                # Name suggestion was made, extract it
                name_match = re.search(r'suggested name: ([\w-]+)', tool_result.lower())
                if name_match:
                    suggested_name = name_match.group(1)
                    content = (
                        f"How about **{suggested_name}**?\n\n"
                        f"Does that sound good? Just say 'yes' to use it, or tell me a different name you'd prefer."
                    )
                else:
                    content = "What would you like to name this agent?"
            elif "already exists" in tool_result.lower():
                content = f"It looks like that agent already exists. {tool_result}\n\nPlease suggest a different name."
            elif "created successfully" in tool_result.lower():
                # Agent was created! Check if we need to install MCP
                server = extract_server_name_from_msg(original_user_msg)
                name_match = re.search(r"agent '([\w-]+)' created", tool_result.lower())
                name = name_match.group(1) if name_match else extract_agent_name_from_msg(original_user_msg)
                if server and name:
                    tool_calls.append({
                        "name": "install_mcp",
                        "args": {"name": name, "server": server},
                        "id": next_call_id(),
                        "type": "tool_call",
                    })
                    content = (
                        f"Great! {tool_result}\n\n"
                        f"I noticed you mentioned {server}, so I'll set up the {server} MCP integration too."
                    )
                else:
                    content = (
                        f"Great! {tool_result}\n\n"
                        f"Your agent is ready! You can now:\n"
                        f"- Start it with: `cast dev {name}`\n"
                        f"- Add MCP integrations by mentioning services like Gmail, Slack, or GitHub\n"
                        f"- Update its instructions anytime\n\n"
                        f"Is there anything else you'd like to configure?"
                    )
            elif "updated" in tool_result.lower():
                content = f"Done! {tool_result}"
            elif "available" in tool_result.lower():
                content = f"{tool_result}"
            else:
                content = f"Result: {tool_result}"
            message = AIMessage(content=content, tool_calls=tool_calls)
            generation = ChatGeneration(message=message)
            return ChatResult(generations=[generation])

        # Handle empty input
        if not last_user_msg.strip():
            if new_mode:
                content = "What would you like your new agent to do? Describe its purpose and I'll suggest a name."
            else:
                content = "I'd be happy to help you create an agent. What would you like your agent to do?"
            message = AIMessage(content=content, tool_calls=tool_calls)
            generation = ChatGeneration(message=message)
            return ChatResult(generations=[generation])

        # NEW MODE FLOW
        if new_mode:
            # Check if user is confirming a suggested name
            if lower_msg in ['yes', 'yeah', 'sure', 'ok', 'okay', 'yep', 'y', 'yes please', 'that sounds good']:
                # Find the last suggested name from previous tool results
                suggested_name = None
                for msg in reversed(messages):
                    if isinstance(msg, ToolMessage):
                        match = re.search(r'suggested name: ([\w-]+)', str(msg.content).lower())
                        if match:
                            suggested_name = match.group(1)
                            break

                if suggested_name:
                    # Get the description from earlier messages (not the current "yes")
                    description = ""
                    for msg in messages:
                        if isinstance(msg, HumanMessage):
                            desc = extract_description(str(msg.content))
                            if desc and len(desc) > 10:
                                description = desc
                                break

                    tool_calls.append({
                        "name": "create_agent",
                        "args": {"name": suggested_name, "description": description},
                        "id": next_call_id(),
                        "type": "tool_call",
                    })
                    content = f"Perfect! I'll create the agent **{suggested_name}** for you."
                    message = AIMessage(content=content, tool_calls=tool_calls)
                    generation = ChatGeneration(message=message)
                    return ChatResult(generations=[generation])

            # Check if user provided a custom name
            custom_name = extract_agent_name_from_msg(last_user_msg)
            if custom_name:
                # Check if this looks like a name confirmation (short input, just a name)
                if len(last_user_msg.strip()) < 30 and re.match(r'^[\w-]+$', last_user_msg.strip()):
                    description = ""
                    for msg in messages:
                        if isinstance(msg, HumanMessage):
                            desc = extract_description(str(msg.content))
                            if desc and len(desc) > 10:
                                description = desc
                                break

                    tool_calls.append({
                        "name": "create_agent",
                        "args": {"name": custom_name, "description": description},
                        "id": next_call_id(),
                        "type": "tool_call",
                    })
                    content = f"Great choice! I'll create the agent **{custom_name}** for you."
                    message = AIMessage(content=content, tool_calls=tool_calls)
                    generation = ChatGeneration(message=message)
                    return ChatResult(generations=[generation])

            # User provided a description - suggest a name
            description = extract_description()
            if len(description) > 5:
                tool_calls.append({
                    "name": "suggest_name",
                    "args": {"description": description},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"That sounds interesting! Let me suggest a good name for an agent that {description}."
                message = AIMessage(content=content, tool_calls=tool_calls)
                generation = ChatGeneration(message=message)
                return ChatResult(generations=[generation])

        # NORMAL MODE FLOWS

        # Helper to extract agent name
        def extract_agent_name() -> Optional[str]:
            patterns = [
                r'(?:agent\s+(?:called|named))\s+["\']?([\w-]+)["\']?',
                r'(?:for\s+agent)\s+["\']?([\w-]+)["\']?',
                r'(?:create\s+(?:an?\s+)?agent\s+(?:called|named)\s+)["\']?([\w-]+)["\']?',
            ]
            for pattern in patterns:
                match = re.search(pattern, lower_msg)
                if match:
                    return match.group(1)

            # Handle "Create an email agent" → "email-agent"
            desc_patterns = [
                r'create\s+(?:an?\s+)([\w-]+)\s+agent',
                r'create\s+(?:an?\s+)?agent\s+(?:that\s+(?:reads?|handles?|manages?|sends?|deletes?|writes?|get))\s+([\w-]+)',
            ]
            for pattern in desc_patterns:
                match = re.search(pattern, lower_msg)
                if match:
                    base = match.group(1)
                    # Don't return generic words
                    if base not in ['an', 'a', 'the', 'my', 'me']:
                        return f"{base}-agent"

            # Handle "Delete files" → "file-deletion-agent"
            if any(k in lower_msg for k in ["delete", "remove", "destroy"]):
                return "file-deletion-agent"

            return None

        # Helper to extract server name
        def extract_server_name() -> Optional[str]:
            patterns = [
                r'(?:mcp|install)\s+(?:server\s+)?["\']?([\w-]+)["\']?',
                r'(?:server\s+["\']?)([\w-]+)["\']?',
            ]
            for pattern in patterns:
                match = re.search(pattern, lower_msg)
                if match:
                    return match.group(1)
            # Common server names
            for server in ["gmail", "slack", "github", "notion", "linear", "discord", "twitter", "postgres", "mysql"]:
                if server in lower_msg:
                    return server
            return None

        # create_agent (also handles destructive operations by creating an agent)
        if ("create" in lower_msg and "agent" in lower_msg) or any(k in lower_msg for k in ["delete", "remove", "destroy"]):
            name = extract_agent_name()
            if name:
                tool_calls.append({
                    "name": "create_agent",
                    "args": {"name": name},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"I'll create the agent '{name}' for you."
            else:
                content = "I'd be happy to create an agent for you. What would you like to name it?"

        # list_agents
        elif ("list" in lower_msg and "agent" in lower_msg) or lower_msg.strip() == "list agents":
            tool_calls.append({
                "name": "list_agents",
                "args": {},
                "id": next_call_id(),
                "type": "tool_call",
            })
            content = "Let me list your existing agents."

        # recommend_model (also handles "simple task" and "complex analysis")
        elif "model" in lower_msg or "recommend" in lower_msg or "task" in lower_msg or "analysis" in lower_msg:
            tool_calls.append({
                "name": "recommend_model",
                "args": {"requirements": last_user_msg},
                "id": next_call_id(),
                "type": "tool_call",
            })
            content = "Let me recommend a model for your needs."

        # get_agent_config
        elif "config" in lower_msg and ("get" in lower_msg or "show" in lower_msg or "read" in lower_msg):
            name = extract_agent_name()
            if name:
                tool_calls.append({
                    "name": "get_agent_config",
                    "args": {"name": name},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"Let me get the config for '{name}'."
            else:
                content = "Which agent's config would you like to see?"

        # read_file (general purpose file reading)
        elif any(k in lower_msg for k in ["read file", "view file", "show file", "cat ", "display file"]):
            # Try to extract a file path from the message
            # Support quoted paths, paths with extensions, and simple filenames like "instructions"
            path_match = re.search(r'(?:read|view|show|cat|display)(?:\s+(?:file|the|me|this|that))?\s+["\']?([^"\']+?)(?:["\']|$)', lower_msg)
            if path_match:
                file_path = path_match.group(1).strip()
                # Strip leading filler words and trailing punctuation/common words
                file_path = re.sub(r'^(?:file|the|me|this|that)\s+', '', file_path)
                file_path = re.sub(r'\s+(?:please|now|here|there)$', '', file_path)
                file_path = re.sub(r'[.!?]+$', '', file_path)
                if file_path and file_path not in ('file', 'the', 'me', 'this', 'that'):
                    args: Dict[str, Any] = {"file_path": file_path}
                    # If we know the agent name, pass it so relative paths resolve correctly
                    if self._agent_name:
                        args["agent_name"] = self._agent_name
                    tool_calls.append({
                        "name": "read_file",
                        "args": args,
                        "id": next_call_id(),
                        "type": "tool_call",
                    })
                    content = f"Let me read the file '{file_path}' for you."
                else:
                    content = "Which file would you like me to read? Please provide the file path."
            else:
                content = "Which file would you like me to read? Please provide the file path."

        # install_mcp
        elif "mcp" in lower_msg or ("install" in lower_msg and "server" in lower_msg):
            server = extract_server_name()
            name = extract_agent_name()
            if server and name:
                tool_calls.append({
                    "name": "install_mcp",
                    "args": {"name": name, "server": server},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"I'll install the {server} MCP server for {name}."
            else:
                content = "Which MCP server would you like to install, and for which agent?"

        # update_instructions
        elif "instructions" in lower_msg and ("update" in lower_msg or "change" in lower_msg or "set" in lower_msg):
            name = extract_agent_name()
            if name:
                tool_calls.append({
                    "name": "update_instructions",
                    "args": {"name": name, "instructions_md": "Updated instructions for the agent."},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"I'll update the instructions for '{name}'."
            else:
                content = "Which agent's instructions would you like to update?"

        # update_agent_config
        elif "config" in lower_msg and ("update" in lower_msg or "change" in lower_msg or "set" in lower_msg):
            name = extract_agent_name()
            if name:
                tool_calls.append({
                    "name": "update_agent_config",
                    "args": {"name": name, "config_yaml": "version: '1.1'"},
                    "id": next_call_id(),
                    "type": "tool_call",
                })
                content = f"I'll update the config for '{name}'."
            else:
                content = "Which agent's config would you like to update?"

        else:
            # Default conversational response
            content = (
                f"Thanks for sharing that. To help you build your agent, I can:\n\n"
                f"1. **create_agent(name)** - Create a new agent scaffold\n"
                f"2. **update_agent_config(name, config)** - Update agent.yaml\n"
                f"3. **update_instructions(name, instructions)** - Update the system prompt\n"
                f"4. **install_mcp(name, server)** - Add MCP integrations\n"
                f"5. **list_agents()** - See existing agents\n"
                f"6. **get_agent_config(name)** - Read current config\n"
                f"7. **read_file(file_path)** - Read any file without modifying it\n"
                f"8. **recommend_model(requirements)** - Get model suggestions\n\n"
                f"What would you like to do first?"
            )

        message = AIMessage(content=content, tool_calls=tool_calls)
        generation = ChatGeneration(message=message)
        return ChatResult(generations=[generation])

    def bind_tools(self, tools: Sequence[Any], tool_choice: Optional[str] = None, **kwargs: Any) -> Any:
        """Bind tools to the echo model."""
        self._bound_tools = list(tools)
        return self

    @property
    def _llm_type(self) -> str:
        return "echo"

    @property
    def _identifying_params(self) -> Dict[str, Any]:
        return {"model": "echo"}


def create_llm() -> BaseChatModel:
    """Create an LLM instance, falling back to echo mode if no API key.

    The model string is the raw ``defaults.builder_model`` (default
    ``openrouter/minimax/minimax-m2.5``). ``digitalocean/`` selects
    DigitalOcean serverless inference. Anything else stays on OpenRouter.
    A missing key for that provider does not fall back to the other one.
    """
    from .providers.select import api_key_env_for_model, select_provider_class

    model = get_raw_builder_model()
    env_name = api_key_env_for_model(model)
    if not os.getenv(env_name):
        print(f"Warning: No {env_name} found. Using echo mode.", file=sys.stderr)
        return EchoChatModel()
    try:
        from .providers.digitalocean_inference import DigitalOceanInferenceProvider
        from .providers.openrouter import OpenRouterProvider

        provider_cls = select_provider_class(
            model,
            digitalocean_cls=DigitalOceanInferenceProvider,
            openrouter_cls=OpenRouterProvider,
        )
        provider = provider_cls()
        return provider.create_llm(model=model, temperature=0.7)
    except Exception as e:
        label = "DigitalOcean" if env_name == "DIGITALOCEAN_MODEL_ACCESS_KEY" else "OpenRouter"
        print(f"Warning: Failed to create {label} LLM: {e}", file=sys.stderr)
        return EchoChatModel()


class BuilderAgent:
    """LangGraph-based builder agent with tool support."""

    def __init__(self):
        ensure_builder_skills_dir()
        self.system_prompt = load_system_prompt()
        self.llm = create_llm()
        self.tools: List[BaseTool] = [
            create_agent,
            check_name_availability,
            deploy_agent,
            update_agent_config,
            update_instructions,
            install_mcp,
            list_agents,
            get_agent_config,
            read_file,
            recommend_model,
            suggest_name,
        ]
        self.tool_map = {tool.name: tool for tool in self.tools}
        self.graph = self._build_graph()
        self.agent_name: Optional[str] = None
        self.agent_description: str = ""
        self.new_mode: bool = False
        self.name_suggested: bool = False
        self.name_confirmed: bool = False
        self.agent_created: bool = False
        self.messages: List[BaseMessage] = []
        self.edit_welcome: Optional[str] = None

    def _build_graph(self) -> StateGraph:
        """Build the LangGraph state machine."""
        from typing_extensions import TypedDict

        class AgentState(TypedDict):
            messages: Annotated[List[BaseMessage], add_messages]

        # Bind tools to LLM
        llm_with_tools = self.llm.bind_tools(self.tools)

        def agent_node(state: AgentState) -> AgentState:
            """The agent node that decides what to do."""
            messages = state["messages"]
            response = llm_with_tools.invoke(messages)
            return {"messages": messages + [response]}

        def should_continue(state: AgentState) -> str:
            """Decide whether to call tools or end."""
            last_message = state["messages"][-1]
            if isinstance(last_message, AIMessage) and last_message.tool_calls:
                return "tools"
            return END

        tool_node = ToolNode(self.tools)

        workflow = StateGraph(AgentState)
        workflow.add_node("agent", agent_node)
        workflow.add_node("tools", tool_node)
        workflow.set_entry_point("agent")
        workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
        workflow.add_edge("tools", "agent")

        return workflow.compile()

    def set_agent_name(self, name: str) -> None:
        """Set the current agent being built."""
        self.agent_name = name
        # Propagate to LLM so EchoChatModel can use agent context
        if hasattr(self.llm, 'set_agent_name'):
            self.llm.set_agent_name(name)

    def set_new_mode(self, enabled: bool) -> None:
        """Set whether we're in 'new agent' creation mode."""
        self.new_mode = enabled
        # Propagate to LLM so EchoChatModel respects the agent state
        if hasattr(self.llm, 'set_new_mode'):
            self.llm.set_new_mode(enabled)

    def load_agent_for_editing(self, name: str) -> None:
        """Load an existing agent's configuration for editing."""
        self.agent_name = name
        # Ensure default system prompt is present before adding edit context
        if not self.messages:
            self.messages.append(SystemMessage(content=self.system_prompt))
        try:
            config_text = get_agent_config.invoke({"name": name})
            agent_dir = Path.home() / ".cast" / "agents" / name
            self.messages.append(SystemMessage(
                content=f"You are now editing the existing agent '{name}'. "
                        f"The agent's files are located at: {agent_dir}\n\n"
                        f"Here is its current configuration:\n\n{config_text}\n\n"
                        f"When reading agent files (like instructions.md), you can either:\n"
                        f"1. Use the full path: {agent_dir}/instructions.md\n"
                        f"2. Use the read_file tool with agent_name='{name}' and file_path='instructions.md'\n\n"
                        f"IMPORTANT: When the user asks to see the contents of a file, always show the complete file contents in your response. Do not summarize or describe the file instead of showing it.\n\n"
                        f"Help the user modify this agent. You can update instructions, config, or install MCP servers."
            ))
            # Parse config to build a rich welcome message summarizing attributes
            config = yaml.safe_load(config_text) or {}
            self.edit_welcome = self._build_edit_welcome(name, config)
        except Exception as e:
            self.messages.append(SystemMessage(
                content=f"You are now editing the existing agent '{name}'. "
                        f"Could not load full config: {e}\n\n"
                        f"Help the user modify this agent."
            ))
            self.edit_welcome = None

    def _build_edit_welcome(self, name: str, config: Dict[str, Any]) -> str:
        """Build a welcome message summarizing an agent's configuration."""
        lines: List[str] = []
        lines.append(f"Hello! I'm the Cast Builder Agent. I'm here to help you edit **{name}**.\n")

        description = config.get("description", "No description set.")
        lines.append(f"**Description:** {description}\n")

        brain = config.get("brain", {})
        model = brain.get("model", "No model set")
        lines.append(f"**Model:** {model}")

        tools = config.get("tools", {})
        builtin = tools.get("builtin", [])
        if builtin:
            lines.append(f"**Built-in tools:** {', '.join(builtin)}")

        mcp = tools.get("mcp", [])
        if mcp:
            mcp_names = [m.get("server", m) if isinstance(m, dict) else m for m in mcp]
            lines.append(f"**MCP integrations:** {', '.join(mcp_names)}")

        harness = config.get("harness", {})
        principles = harness.get("principles", [])
        if principles:
            lines.append(f"**Principles:** {', '.join(principles)}")

        lines.append("\nWhat would you like to change?")
        return "\n".join(lines)

    async def process_message(self, message: str) -> str:
        """Process a user message through the agent graph."""
        # Add system prompt if this is the first message
        if not self.messages:
            self.messages.append(SystemMessage(content=self.system_prompt))

        self.messages.append(HumanMessage(content=message))

        try:
            # Run graph.invoke in a thread pool to avoid blocking the asyncio event loop.
            # This is critical when using real LLMs (e.g., OpenRouter) because API calls
            # are synchronous and would block all async operations (including timeouts).
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, self.graph.invoke, {"messages": list(self.messages)}
            )
            self.messages = result["messages"]

            # Return the last assistant message content
            for msg in reversed(self.messages):
                if isinstance(msg, AIMessage):
                    return msg.content or "I've processed your request."
            return "I've processed your request."
        except Exception as e:
            return f"Error processing message: {e}"

    async def execute_tool(self, tool_name: str, args: dict) -> Any:
        """Execute a tool directly by name.
        
        After executing update tools (update_agent_config, update_instructions, install_mcp),
        checks if the agent is deployed and includes release suggestions in the result.
        """
        if tool_name not in self.tool_map:
            return f"Tool '{tool_name}' not found"

        tool = self.tool_map[tool_name]
        try:
            # Handle both sync and async tools
            if inspect.iscoroutinefunction(tool.ainvoke):
                result = await tool.ainvoke(args)
            else:
                result = tool.invoke(args)
            
            # Check for deployment and release status after update operations
            update_tools = {"update_agent_config", "update_instructions", "install_mcp"}
            if tool_name in update_tools and self.agent_name:
                release_info = self._get_release_check_result(self.agent_name)
                if release_info:
                    # Wrap result in a dict with release info if it's a simple string
                    if isinstance(result, str) and not result.startswith("{"):
                        return {
                            "text": result,
                            "release_prompt": release_info,
                        }
                    elif isinstance(result, dict):
                        result["release_prompt"] = release_info
            
            return result
        except Exception as e:
            return f"Error executing tool: {e}"
    
    def _get_release_check_result(self, agent_name: str) -> Optional[Dict[str, Any]]:
        """Get release check information for a deployed agent.
        
        Returns None if not deployed or no changes since last release.
        """
        if not is_agent_deployed(agent_name):
            return None
        
        try:
            changes_since = get_changes_since_release(agent_name)
            if changes_since <= 0:
                return None
            
            from cast.releases import suggest_version, get_current_release, get_latest_release_change_number
            from cast.versioning import get_current_version
            
            return {
                "should_prompt": True,
                "changes_since_release": changes_since,
                "current_release": get_current_release(agent_name),
                "last_release_change": get_latest_release_change_number(agent_name),
                "current_change": get_current_version(agent_name),
                "deployed_version": get_deployed_version(agent_name),
                "suggestions": suggest_version(agent_name),
            }
        except Exception:
            return None

    def get_welcome_message(self) -> str:
        model = get_builder_model()
        if self.new_mode:
            return (
                f"Hello! I'm the Cast Builder Agent (powered by **{model}**). Let's create a new agent together.\n\n"
                + "**What should your agent do?**\n\n"
                + "Describe what you'd like your agent to accomplish. For example:\n"
                + '- "An agent that reads my Gmail inbox and drafts replies"\n'
                + '- "A code review agent that checks pull requests on GitHub"\n'
                + '- "A monitoring agent that watches log files and alerts me to errors"\n\n'
                + "What would you like your agent to do?"
            )

        if self.edit_welcome:
            return self.edit_welcome

        name = self.agent_name or "your agent"
        return (
            f"Hello! I'm the Cast Builder Agent (powered by **{model}**). I'm here to help you edit **{name}**.\n\n"
            f"I've loaded its current configuration. I can help you:\n"
            f"- Update instructions or system prompts\n"
            f"- Modify agent.yaml settings (model, tools, permissions)\n"
            f"- Add or remove MCP integrations\n"
            f"- Recommend better models\n\n"
            f"What would you like to change?"
        )


# JSON-RPC 2.0 error codes
JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603
JSONRPC_TOOL_ERROR = -32001


class StdioJsonRpcServer:
    """JSON-RPC server over stdin/stdout for Builder Agent."""

    def __init__(self):
        self.agent = BuilderAgent()
        self.methods = {
            "initialize": self.handle_initialize,
            "tool_call": self.handle_tool_call,
            "output": self.handle_output,
            "check_release": self.handle_check_release,
            "create_release": self.handle_create_release,
        }

    def _make_error_response(self, msg_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        response = {"jsonrpc": "2.0", "error": error}
        if msg_id is not None:
            response["id"] = msg_id
        return response

    def _validate_message(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Validate JSON-RPC message structure. Returns error response if invalid."""
        if not isinstance(message, dict):
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Request must be a JSON object")
        if message.get("jsonrpc") != "2.0":
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Invalid jsonrpc version")
        if "method" not in message:
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Missing 'method' field")
        if not isinstance(message["method"], str):
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "'method' must be a string")
        return None

    async def handle_initialize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        agent_name = params.get("agent_name")
        new_mode = params.get("new_mode", False)

        if not agent_name:
            return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": "Missing 'agent_name' parameter"}}

        self.agent.set_agent_name(agent_name)

        if new_mode or agent_name == "__new__":
            self.agent.set_new_mode(True)
            print("Builder Agent initialized in NEW MODE", file=sys.stderr)
        else:
            print(f"Builder Agent initialized for editing: {agent_name}", file=sys.stderr)
            self.agent.load_agent_for_editing(agent_name)

        welcome = self.agent.get_welcome_message()
        return {
            "status": "ready",
            "agent_name": agent_name,
            "new_mode": self.agent.new_mode,
            "message": welcome,
        }

    async def handle_tool_call(self, params: Dict[str, Any]) -> Dict[str, Any]:
        tool_name = params.get("tool")
        args = params.get("args", {})
        call_id = params.get("call_id")

        if not tool_name:
            return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": "Missing 'tool' parameter"}}

        try:
            result = await self.agent.execute_tool(tool_name, args)
            return {"call_id": call_id, "output": result}
        except Exception as e:
            error_msg = f"Tool execution failed: {str(e)}"
            print(f"Error executing tool '{tool_name}': {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return {"error": {"code": JSONRPC_TOOL_ERROR, "message": error_msg}}

    async def handle_output(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle user message/output to the agent."""
        # The parameter might be 'content', 'message', or 'text'
        message = params.get("content") or params.get("message") or params.get("text", "")

        if not message:
            return {"acknowledged": True, "response": "I'm listening. What would you like to do?"}

        try:
            response = await self.agent.process_message(message)
            return {"acknowledged": True, "response": response}
        except Exception as e:
            error_msg = f"Error processing message: {str(e)}"
            print(f"Error in handle_output: {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return {"error": {"code": JSONRPC_INTERNAL_ERROR, "message": error_msg}}

    async def handle_check_release(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check if a release should be created for the current agent.
        
        Returns deployment status, change count, and version suggestions.
        The TUI can use this to decide whether to show the release prompt.
        """
        agent_name = params.get("agent_name") or self.agent.agent_name
        
        if not agent_name:
            return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": "Missing 'agent_name' parameter"}}

        try:
            deployed = is_agent_deployed(agent_name)
            changes_since = get_changes_since_release(agent_name) if deployed else 0
            
            result: Dict[str, Any] = {
                "is_deployed": deployed,
                "changes_since_release": changes_since,
                "should_prompt": deployed and changes_since > 0,
            }
            
            if deployed and changes_since > 0:
                from cast.releases import suggest_version, get_current_release
                from cast.releases import get_latest_release_change_number
                from cast.versioning import get_current_version
                
                result["current_release"] = get_current_release(agent_name)
                result["deployed_version"] = get_deployed_version(agent_name)
                result["last_release_change"] = get_latest_release_change_number(agent_name)
                result["current_change"] = get_current_version(agent_name)
                result["suggestions"] = suggest_version(agent_name)
            
            return result
        except Exception as e:
            error_msg = f"Error checking release status: {str(e)}"
            print(f"Error in handle_check_release: {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return {"error": {"code": JSONRPC_INTERNAL_ERROR, "message": error_msg}}

    async def handle_create_release(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a release for the current agent.
        
        Args:
            version: The semantic version to release (required).
            message: Optional release message.
        """
        agent_name = params.get("agent_name") or self.agent.agent_name
        version = params.get("version")
        message = params.get("message", "")

        if not agent_name:
            return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": "Missing 'agent_name' parameter"}}
        if not version:
            return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": "Missing 'version' parameter"}}

        try:
            from cast.releases import create_release, validate_semver
            
            if not validate_semver(version):
                return {"error": {"code": JSONRPC_INVALID_PARAMS, "message": f"Invalid semantic version: '{version}'"}}
            
            release_info = create_release(agent_name, version, message)
            
            return {
                "success": True,
                "version": release_info.version,
                "change_number": release_info.change_number,
                "message": f"Release {version} created successfully",
            }
        except Exception as e:
            error_msg = f"Error creating release: {str(e)}"
            print(f"Error in handle_create_release: {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return {"error": {"code": JSONRPC_INTERNAL_ERROR, "message": error_msg}}

    async def process_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        # Validate message structure
        validation_error = self._validate_message(message)
        if validation_error:
            return validation_error

        method = message.get("method")
        params = message.get("params", {})
        msg_id = message.get("id")

        if method in self.methods:
            try:
                result = await self.methods[method](params)
                # Check if the handler returned an error
                if isinstance(result, dict) and "error" in result:
                    return self._make_error_response(msg_id, result["error"]["code"], result["error"]["message"])
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": result,
                }
            except Exception as e:
                error_msg = f"Internal error executing '{method}': {str(e)}"
                print(error_msg, file=sys.stderr)
                traceback.print_exc()
                return self._make_error_response(msg_id, JSONRPC_INTERNAL_ERROR, error_msg)
        else:
            return self._make_error_response(
                msg_id, JSONRPC_METHOD_NOT_FOUND, f"Method '{method}' not found"
            )

    async def run(self):
        print("Builder Agent ready (stdio JSON-RPC)", file=sys.stderr)

        while True:
            try:
                line = await asyncio.get_event_loop().run_in_executor(
                    None, sys.stdin.readline
                )
                if not line:
                    break

                try:
                    message = json.loads(line.strip())
                except json.JSONDecodeError as e:
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "error": {"code": JSONRPC_PARSE_ERROR, "message": f"Parse error: {e}"},
                    }), flush=True)
                    continue

                response = await self.process_message(message)
                print(json.dumps(response), flush=True)

            except KeyboardInterrupt:
                print("\nShutting down Builder Agent...", file=sys.stderr)
                break
            except Exception as e:
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "error": {"code": JSONRPC_INTERNAL_ERROR, "message": f"Internal error: {e}"},
                }), flush=True)


async def main():
    server = StdioJsonRpcServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
