"""Builder Agent tools for creating and managing Cast agents."""

import json
import os
import re
import sqlite3
import yaml
from pathlib import Path
from typing import Dict, List, Any, Optional
from langchain_core.tools import tool

from cast.versioning import create_version

AGENTS_DIR = Path.home() / ".cast" / "agents"
BUILDER_DIR = Path.home() / ".cast" / "builder"
CREATED_AGENT_MARKER = "created-agent"


def _cast_db_path() -> Path:
    """cast.db beside the agents directory, matching cast.releases."""
    agents = Path(AGENTS_DIR)
    if agents.name == "agents":
        return agents.parent / "cast.db"
    return agents / "cast.db"


def _register_agent(name: str, agent_yaml_path: Path) -> None:
    """Insert the agents row that deployments.agent_name references.

    better-sqlite3 enables foreign keys, so `cast deploy` fails with
    FOREIGN KEY constraint failed when this row is missing. A database
    error must not undo the scaffold. Deploy inserts the row again if
    this write does not land.
    """
    try:
        db_path = _cast_db_path()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agents (
                    name TEXT PRIMARY KEY,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    agent_yaml_path TEXT,
                    last_run_at DATETIME,
                    run_count INTEGER DEFAULT 0
                )
                """
            )
            conn.execute(
                "INSERT OR IGNORE INTO agents (name, agent_yaml_path) VALUES (?, ?)",
                (name, str(agent_yaml_path)),
            )
            conn.commit()
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        return


def _remember_created_agent(name: str) -> None:
    """Record the agent this builder session just created.

    ``cast new`` opens the TUI as "Cast Builder". Slash commands read
    this file so they act on the new agent. A write failure must not
    undo the scaffold.
    """
    try:
        marker = BUILDER_DIR / CREATED_AGENT_MARKER
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(name.strip() + "\n", encoding="utf-8")
    except OSError:
        return


def _get_agent_path(name: str) -> Path:
    """Get the path to an agent directory."""
    return AGENTS_DIR / name


def _ensure_agent_exists(name: str) -> Path:
    """Ensure agent directory exists, raise if not."""
    agent_path = _get_agent_path(name)
    if not agent_path.exists():
        raise ValueError(f"Agent '{name}' does not exist. Create it first with create_agent.")
    return agent_path


def _sanitize_name(name: str) -> str:
    """Sanitize a suggested name to valid agent name format."""
    # Replace spaces and underscores with hyphens
    name = name.replace(' ', '-').replace('_', '-')
    # Remove invalid characters
    name = re.sub(r'[^a-zA-Z0-9-]', '', name)
    # Convert to lowercase
    name = name.lower()
    # Remove leading/trailing hyphens and collapse multiple hyphens
    name = re.sub(r'-+', '-', name).strip('-')
    return name or "new-agent"


def _generate_name_from_description(description: str) -> str:
    """Generate a suggested agent name from a description."""
    desc_lower = description.lower()
    
    # Common domain keywords and their name mappings
    domain_map = {
        "email": "email-agent",
        "gmail": "gmail-agent",
        "slack": "slack-agent",
        "github": "github-agent",
        "git": "git-agent",
        "code": "code-agent",
        "coding": "code-agent",
        "write": "writer-agent",
        "writer": "writer-agent",
        "blog": "blog-agent",
        "deploy": "deploy-agent",
        "deployment": "deploy-agent",
        "docker": "docker-agent",
        "test": "test-agent",
        "testing": "test-agent",
        "monitor": "monitor-agent",
        "monitoring": "monitor-agent",
        "log": "log-agent",
        "logs": "log-agent",
        "data": "data-agent",
        "analysis": "data-agent",
        "analyze": "data-agent",
        "search": "search-agent",
        "research": "research-agent",
        "summarize": "summarizer-agent",
        "summary": "summarizer-agent",
        "file": "file-agent",
        "filesystem": "file-agent",
        "database": "db-agent",
        "db": "db-agent",
        "sql": "sql-agent",
        "api": "api-agent",
        "webhook": "webhook-agent",
        "schedule": "scheduler-agent",
        "cron": "scheduler-agent",
        "remind": "reminder-agent",
        "reminder": "reminder-agent",
        "ticket": "ticket-agent",
        "support": "support-agent",
        "customer": "support-agent",
        "review": "review-agent",
        "pr": "pr-agent",
        "pull request": "pr-agent",
        "translate": "translator-agent",
        "translation": "translator-agent",
    }
    
    # Check for domain matches
    for keyword, name in domain_map.items():
        if keyword in desc_lower:
            return name
    
    # Extract first meaningful nouns
    words = re.findall(r'\b[a-zA-Z]{3,}\b', desc_lower)
    stop_words = {'the', 'and', 'for', 'with', 'that', 'this', 'can', 'you', 'are', 'agent', 'create', 'make', 'new', 'want', 'need', 'help', 'use', 'using', 'will', 'should', 'could', 'would', 'have', 'has', 'had', 'been', 'being', 'does', 'did', 'doing'}
    
    meaningful = [w for w in words if w not in stop_words]
    
    if meaningful:
        # Take up to 2 meaningful words
        base = '-'.join(meaningful[:2])
        return _sanitize_name(base) + "-agent"
    
    return "new-agent"


def _is_name_available(name: str) -> bool:
    """Check if an agent name is available."""
    agent_path = _get_agent_path(name)
    return not agent_path.exists()


def _find_available_name(base_name: str) -> str:
    """Find an available name by appending a number if needed."""
    if _is_name_available(base_name):
        return base_name
    
    # Try appending numbers
    for i in range(2, 1000):
        candidate = f"{base_name}-{i}"
        if _is_name_available(candidate):
            return candidate
    
    return f"{base_name}-{os.urandom(4).hex()}"


@tool
def suggest_name(description: str) -> str:
    """
    Suggest an available agent name based on a description.
    
    Args:
        description: What the agent should do.
        
    Returns:
        A suggested available name for the agent.
    """
    base_name = _generate_name_from_description(description)
    available_name = _find_available_name(base_name)
    
    if available_name != base_name:
        return f"Suggested name: {available_name} ('{base_name}' was taken)"
    
    return f"Suggested name: {available_name}"


@tool
def create_agent(name: str, description: str = "") -> str:
    """
    Create a new agent scaffold in ~/.cast/agents/<name>/.
    Creates agent.yaml, instructions.md, skills/, tools/, mcp/, and tests/ directories.
    
    Args:
        name: The name of the agent to create. Use lowercase with hyphens.
        description: Optional description of what the agent does.
    """
    agent_path = _get_agent_path(name)
    
    if agent_path.exists():
        return f"Agent '{name}' already exists at {agent_path}"
    
    # Create directories
    (agent_path / "skills").mkdir(parents=True)
    (agent_path / "tools").mkdir(parents=True)
    (agent_path / "mcp").mkdir(parents=True)
    (agent_path / "memory").mkdir(parents=True)
    (agent_path / "tests" / "cli").mkdir(parents=True)
    (agent_path / "tests" / "agent" / "scenarios").mkdir(parents=True)
    
    # Generate meaningful description and instructions if provided
    agent_description = description or f"Agent created by Cast Builder"
    instructions_content = f"# {name}\n\n"
    
    if description:
        instructions_content += f"You are {name}, an AI agent that {description}\n\n"
        instructions_content += "## Your Capabilities\n\n"
        instructions_content += "- Use built-in tools (bash, read, glob) when needed\n"
        instructions_content += "- Be helpful, accurate, and concise\n"
        instructions_content += "- Ask for clarification when requirements are unclear\n"
    else:
        instructions_content += "You are a helpful assistant.\n"

    # Create default agent.yaml
    default_config = {
        "name": name,
        "version": "1.0",
        "description": agent_description,
        "brain": {
            "model": "openrouter/minimax/minimax-m2.5",
            "model_override": None,
            "instructions_file": "instructions.md",
        },
        "harness": {
            "permissions": {},
            "principles": [],
        },
        "tools": {
            "builtin": ["bash", "read", "glob"],
            "mcp": [],
            "custom": [],
        },
        "runtime": {
            "python_version": "3.11",
            "requirements": [],
        },
    }
    
    agent_yaml_path = agent_path / "agent.yaml"
    with open(agent_yaml_path, "w") as f:
        yaml.dump(default_config, f, default_flow_style=False, sort_keys=False)
    
    # Create instructions.md with meaningful content
    instructions_path = agent_path / "instructions.md"
    with open(instructions_path, "w") as f:
        f.write(instructions_content)

    # Create default memory config
    memory_config_path = agent_path / "memory" / "config.yaml"
    memory_config = {
        "memory": {
            "enabled": True,
            "categories": [
                "learned", "decision", "pattern", "error_learned", "accomplishment",
                "preference", "context", "project", "tools_used", "boundary",
                "relationship", "todo", "question_asked", "directive_given"
            ],
            "max_per_category": 100,
            "relevance_threshold": 0.7,
            "reflection_model": None,
        }
    }
    with open(memory_config_path, "w") as f:
        yaml.dump(memory_config, f, default_flow_style=False, sort_keys=False)

    # Create initial version
    create_version(name, source="create", message="Initial version", agents_dir=AGENTS_DIR)

    _register_agent(name, agent_yaml_path)
    _remember_created_agent(name)

    return f"Agent '{name}' created successfully at {agent_path}"


def create_from_description(description: str) -> Dict[str, str]:
    """Create an agent from piped text when ``cast new`` has no TTY.

    Blank input is refused. The name is chosen the same way as
    ``suggest_name``, including a numeric suffix when that name is taken.
    ``CAST_AGENTS_DIR`` overrides the agents directory for this call only.
    """
    text = description.strip()
    if not text:
        raise ValueError(
            "No description on stdin. Pipe a description, for example: "
            'echo "Summarises incoming email and drafts replies." | cast new'
        )

    global AGENTS_DIR
    import cast.versioning as versioning

    previous = AGENTS_DIR
    previous_versioning = versioning.AGENTS_DIR
    override = os.environ.get("CAST_AGENTS_DIR", "").strip()
    if override:
        # create_version stores snapshots under versioning.AGENTS_DIR.
        # Keep that next to the scaffold when CAST_AGENTS_DIR is set.
        AGENTS_DIR = Path(override)
        versioning.AGENTS_DIR = AGENTS_DIR
    try:
        name = _find_available_name(_generate_name_from_description(text))
        if not re.fullmatch(r"[A-Za-z0-9-]+", name):
            raise ValueError("Could not derive an agent name from the description.")
        result = create_agent.invoke({"name": name, "description": text})
        if not isinstance(result, str) or "created successfully" not in result.lower():
            raise ValueError(str(result))
        return {
            "name": name,
            "path": str(_get_agent_path(name)),
            "description": text,
        }
    finally:
        AGENTS_DIR = previous
        versioning.AGENTS_DIR = previous_versioning


@tool
def check_name_availability(name: str) -> str:
    """
    Check if an agent name is available.
    
    Args:
        name: The name to check.
        
    Returns:
        A message indicating whether the name is available.
    """
    if _is_name_available(name):
        return f"'{name}' is available!"
    return f"'{name}' is already taken. Try a different name."


@tool
def update_agent_config(name: str, config_yaml: str) -> str:
    """
    Update agent.yaml for the given agent.
    Merges the provided YAML with the existing config.
    
    Args:
        name: The name of the agent to update.
        config_yaml: The YAML content to merge into agent.yaml.
    """
    agent_path = _ensure_agent_exists(name)
    agent_yaml_path = agent_path / "agent.yaml"
    
    # Load existing config
    with open(agent_yaml_path, "r") as f:
        existing = yaml.safe_load(f) or {}
    
    # Parse new config
    updates = yaml.safe_load(config_yaml) or {}
    
    # Deep merge
    def deep_merge(base: dict, updates: dict) -> dict:
        for key, value in updates.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                deep_merge(base[key], value)
            else:
                base[key] = value
        return base

    merged = deep_merge(existing, updates)

    with open(agent_yaml_path, "w") as f:
        yaml.dump(merged, f, default_flow_style=False, sort_keys=False)

    # Generate descriptive message about what changed
    changes = []
    if 'brain' in updates and 'model' in updates.get('brain', {}):
        changes.append(f"model: {updates['brain']['model']}")
    if 'description' in updates:
        changes.append("description")
    if 'tools' in updates:
        if 'builtin' in updates.get('tools', {}):
            changes.append("tools")
        if 'mcp' in updates.get('tools', []):
            changes.append("MCP servers")
    if 'harness' in updates:
        if 'permissions' in updates.get('harness', {}):
            changes.append("permissions")
        if 'principles' in updates.get('harness', {}):
            changes.append("principles")
    if 'runtime' in updates:
        changes.append("runtime")

    if changes:
        message = "Updated: " + ", ".join(changes)
    else:
        message = "Updated agent configuration"

    create_version(name, source="builder", message=message, agents_dir=AGENTS_DIR)

    return f"Updated agent.yaml for '{name}'"


@tool
def update_instructions(name: str, instructions_md: str) -> str:
    """
    Update instructions.md for the given agent.
    
    Args:
        name: The name of the agent to update.
        instructions_md: The new instructions content in Markdown.
    """
    agent_path = _ensure_agent_exists(name)
    instructions_path = agent_path / "instructions.md"

    with open(instructions_path, "w") as f:
        f.write(instructions_md)

    create_version(name, source="builder", message="Updated instructions", agents_dir=AGENTS_DIR)

    return f"Updated instructions.md for '{name}'"


@tool
def install_mcp(name: str, server: str) -> str:
    """
    Create MCP server config for the agent.
    Creates mcp/<server>.yaml with default OAuth configuration.
    
    Args:
        name: The name of the agent to update.
        server: The MCP server name (e.g., 'gmail', 'slack', 'github').
    """
    agent_path = _ensure_agent_exists(name)
    mcp_dir = agent_path / "mcp"
    mcp_dir.mkdir(exist_ok=True)
    
    mcp_config = {
        "server": server,
        "version": "1.0.0",
        "auth": {
            "type": "oauth",
            "credentials_path": f"~/.cast/vault/{name}/{server}-oauth.json",
        },
        "scopes": [],
    }
    
    mcp_path = mcp_dir / f"{server}.yaml"
    with open(mcp_path, "w") as f:
        yaml.dump(mcp_config, f, default_flow_style=False, sort_keys=False)
    
    # Also update agent.yaml to include this MCP server
    agent_yaml_path = agent_path / "agent.yaml"
    with open(agent_yaml_path, "r") as f:
        config = yaml.safe_load(f) or {}
    
    mcp_list = config.setdefault("tools", {}).setdefault("mcp", [])
    if server not in [m.get("server") if isinstance(m, dict) else m for m in mcp_list]:
        mcp_list.append({"server": server, "config": f"mcp/{server}.yaml"})

    with open(agent_yaml_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)

    create_version(name, source="builder", message=f"Added MCP server: {server}", agents_dir=AGENTS_DIR)

    return f"Installed MCP server '{server}' for agent '{name}'"


@tool
def list_agents() -> List[str]:
    """
    List all existing agents in ~/.cast/agents/.
    
    Returns:
        A list of agent names.
    """
    if not AGENTS_DIR.exists():
        return []
    
    agents = []
    for item in AGENTS_DIR.iterdir():
        if item.is_dir() and (item / "agent.yaml").exists():
            agents.append(item.name)
    
    return sorted(agents)


@tool
def get_agent_config(name: str) -> str:
    """
    Read agent.yaml as a string.
    
    Args:
        name: The name of the agent.
    
    Returns:
        The contents of agent.yaml as a string.
    """
    agent_path = _ensure_agent_exists(name)
    agent_yaml_path = agent_path / "agent.yaml"
    
    with open(agent_yaml_path, "r") as f:
        return f.read()


@tool
def read_file(file_path: str, offset: int = 0, limit: int = 100, agent_name: Optional[str] = None) -> str:
    """
    Read a file and return its contents without modifying it.

    Use this to view files like instructions.md, agent.yaml, or any other
    text file in the agent directory or elsewhere.

    Args:
        file_path: Absolute or relative path to the file to read.
        offset: Line offset to start reading from (default: 0).
        limit: Maximum number of lines to read (default: 100).
        agent_name: Optional agent name. If provided, relative paths are resolved
            against the agent's directory (~/.cast/agents/<agent_name>/).

    Returns:
        The contents of the file as a string.
    """
    try:
        path = Path(file_path).expanduser()

        # If agent_name is provided and the path is relative, resolve against agent dir
        if agent_name and not path.is_absolute():
            agent_dir = _get_agent_path(agent_name)
            if agent_dir.exists():
                path = agent_dir / path

        if not path.exists():
            return f"Error: File '{file_path}' not found."
        if not path.is_file():
            return f"Error: '{file_path}' is not a file."

        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        start = max(0, offset)
        end = min(offset + limit, len(lines))
        content = "".join(lines[start:end])

        if end < len(lines):
            content += f"\n... ({len(lines) - end} more lines)"

        return content
    except Exception as e:
        return f"Error reading file: {str(e)}"


@tool
def recommend_model(requirements: str) -> str:
    """
    Recommend a model based on task complexity requirements.
    
    Args:
        requirements: A description of what the agent needs to do.
    
    Returns:
        A model recommendation string with explanation.
    """
    requirements_lower = requirements.lower()
    
    # Simple tasks
    simple_keywords = ["simple", "classify", "categorize", "basic", "filter", "sort", "tag"]
    # Complex tasks
    complex_keywords = ["complex", "reasoning", "analysis", "research", "long context", "deep", "sophisticated"]
    # Coding tasks
    coding_keywords = ["code", "programming", "develop", "debug", "script", "api"]
    
    is_simple = any(k in requirements_lower for k in simple_keywords)
    is_complex = any(k in requirements_lower for k in complex_keywords)
    is_coding = any(k in requirements_lower for k in coding_keywords)
    
    if is_complex:
        return "openrouter/anthropic/claude-sonnet-4 - Best for complex reasoning and long context tasks"
    elif is_coding:
        return "openrouter/anthropic/claude-3-7-sonnet - Excellent for coding and general development tasks"
    elif is_simple:
        return "openrouter/anthropic/claude-3-haiku or openrouter/openai/gpt-4o-mini - Fast and cost-effective for simple automation"
    else:
        return "openrouter/anthropic/claude-3-7-sonnet - Good all-rounder for most agent tasks"


@tool
def create_release(name: str, version: str, message: str = "") -> str:
    """
    Create a semantic release snapshot for the agent.

    This creates a point-in-time snapshot that can be deployed later.
    Releases are stored in ~/.cast/agents/<name>/.cast/releases/

    Args:
        name: The name of the agent to release.
        version: The semantic version (e.g., '1.0', '1.6', '2.0.0').
        message: Optional release message (default: "Release {version}").

    Returns:
        A confirmation message with release details.
    """
    from cast.releases import create_release as py_create_release, validate_semver

    # Validate agent exists
    _ensure_agent_exists(name)

    # Validate semver
    if not validate_semver(version):
        return f"Invalid semantic version: '{version}'. Expected format: 1.0, 1.6, 2.0.0"

    try:
        release_info = py_create_release(name, version, message)

        # Return detailed success message
        result = f"Release {release_info.version} created successfully!\n"
        result += f"  Change: v{release_info.change_number}\n"
        result += f"  Tarball: {release_info.tarball_path}\n"
        if release_info.changelog:
            result += f"\nChangelog:\n{release_info.changelog}"

        return result
    except Exception as e:
        return f"Failed to create release: {str(e)}"


@tool
def deploy_agent(name: str = "", provider: str = "") -> str:
    """
    Deploy an agent to a hosting provider. Opens a terminal modal to run the deploy command.

    Args:
        name: The name of the agent to deploy. If not provided, the TUI will use
            the current agent being edited.
        provider: The hosting provider to deploy to (e.g., 'railway', 'fly',
            'digitalocean', 'microvm', 'sprites', 'docker', 'local'). If not specified,
            the deploy will be interactive and prompt for provider selection.

    Returns:
        A response indicating the deploy modal will open, or an error if
        the agent doesn't exist.
    """
    valid_providers = ["railway", "fly", "digitalocean", "microvm", "sprites", "docker", "local"]

    # If name is provided, validate agent exists
    if name:
        try:
            agent_path = _ensure_agent_exists(name)
        except ValueError as e:
            return str(e)
    else:
        # No name provided - TUI will use current agent
        name = None

    # Validate provider if specified
    if provider and provider not in valid_providers:
        return f"Invalid provider '{provider}'. Valid providers: {', '.join(valid_providers)}"

    # Return structured response with ui_action
    response = {
        "text": f"Opening deploy modal...",
        "ui_action": {
            "type": "open_deploy_modal",
            "agent_name": name,  # None means use current agent from TUI context
            "provider": provider
        }
    }
    return json.dumps(response)
