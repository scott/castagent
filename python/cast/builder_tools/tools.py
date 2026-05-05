"""Builder Agent tools for creating and managing Cast agents."""

import os
import re
import yaml
from pathlib import Path
from typing import Dict, List, Any, Optional
from langchain_core.tools import tool

AGENTS_DIR = Path.home() / "cast-agents"


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
    Create a new agent scaffold in ~/cast-agents/<name>/.
    Creates agent.yaml, instructions.md, tools/, mcp/, and tests/ directories.
    
    Args:
        name: The name of the agent to create. Use lowercase with hyphens.
        description: Optional description of what the agent does.
    """
    agent_path = _get_agent_path(name)
    
    if agent_path.exists():
        return f"Agent '{name}' already exists at {agent_path}"
    
    # Create directories
    (agent_path / "tools").mkdir(parents=True)
    (agent_path / "mcp").mkdir(parents=True)
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
            "model": "openrouter/anthropic/claude-3-7-sonnet",
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
    
    return f"Agent '{name}' created successfully at {agent_path}"


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
    
    return f"Installed MCP server '{server}' for agent '{name}'"


@tool
def list_agents() -> List[str]:
    """
    List all existing agents in ~/cast-agents/.
    
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
