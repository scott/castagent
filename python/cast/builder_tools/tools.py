"""Builder Agent tools for creating and managing Cast agents."""

import json
import os
import re
import yaml
from pathlib import Path
from typing import Dict, List, Any, Optional
from langchain_core.tools import tool

from cast.versioning import create_version

AGENTS_DIR = Path.home() / ".cast" / "agents"
BUILDER_DIR = Path.home() / ".cast" / "builder"
CREATED_AGENT_MARKER = "created-agent"

# Same lists cast update stores. The runtime loads tools.builtin and
# harness.permissions, and it ignores a top-level model or permissions key.
VALID_BUILTIN_TOOLS = ("bash", "read", "glob")
VALID_PERMISSION_LEVELS = ("always-allow", "ask", "deny")
SUPPORTED_PYTHON_VERSIONS = ("3.11", "3.12")
_AGENT_YAML_TOP_LEVEL = {
    "name",
    "version",
    "description",
    "brain",
    "harness",
    "tools",
    "runtime",
    "repository",
    "skills",
    "deployment",
}


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


def _model_catalog_error(model: Any) -> Optional[str]:
    """Return the cast update error for a model id, or None when it is valid."""
    if not isinstance(model, str) or not model.strip():
        return "Model id must be a non-empty string."
    from cast.providers.registry import model_status

    status = model_status(model)
    if status.get("valid"):
        return None
    return status.get("error") or f"Unknown model '{model}'."


def _unknown_top_level_error(key: str, value: Any) -> List[str]:
    """Explain a key the runtime does not load. The file is not written."""
    if key == "model":
        detail = " Set brain.model to a catalog id."
        if isinstance(value, str) and value:
            catalog_error = _model_catalog_error(value)
            if catalog_error:
                detail += " " + catalog_error
            else:
                detail += f" '{value}' is a catalog id, but the runtime reads brain.model."
        return ["Top-level model was not applied." + detail]
    if key == "permissions":
        extra = " Set harness.permissions to tool: level (always-allow, ask, or deny)."
        if isinstance(value, dict):
            bad = []
            for tool, level in value.items():
                if not isinstance(level, str) or level not in VALID_PERMISSION_LEVELS:
                    shown = level if isinstance(level, str) else type(level).__name__
                    bad.append(f"{tool}={shown}")
            if bad:
                extra += " Invalid levels: " + ", ".join(bad) + "."
        elif isinstance(value, list):
            extra += " A list was not written."
        return ["Top-level permissions were not applied." + extra]
    if key == "memory":
        return [
            "Top-level memory was not applied. Memory settings belong in memory/config.yaml."
        ]
    return [
        f"Top-level {key} was not applied. It is not an agent.yaml setting the runtime loads."
    ]


def _permission_errors(permissions: Any, prefix: str) -> List[str]:
    if not isinstance(permissions, dict):
        return [
            f"{prefix} must be a mapping of tool to level (always-allow, ask, or deny)."
        ]
    errors = []
    for tool, level in permissions.items():
        if not isinstance(tool, str) or not tool:
            errors.append(f"{prefix} has a tool name that is not a string.")
            continue
        if not isinstance(level, str) or level not in VALID_PERMISSION_LEVELS:
            shown = level if isinstance(level, str) else type(level).__name__
            errors.append(
                f"{prefix}.{tool} level '{shown}' is invalid. "
                "Valid levels: always-allow, ask, deny."
            )
    return errors


def _validate_brain(brain: Any) -> List[str]:
    if not isinstance(brain, dict):
        return ["brain must be a mapping with model and instructions_file."]
    errors = []
    for key in brain:
        if key not in {"model", "model_override", "instructions_file"}:
            errors.append(
                f"brain.{key} was not applied. The runtime reads brain.model, "
                "brain.model_override, and brain.instructions_file."
            )
    if "model" in brain:
        catalog_error = _model_catalog_error(brain["model"])
        if catalog_error:
            errors.append(f"brain.model was not applied. {catalog_error}")
    if "instructions_file" in brain and not isinstance(brain["instructions_file"], str):
        errors.append("brain.instructions_file must be a string.")
    if (
        "model_override" in brain
        and brain["model_override"] is not None
        and not isinstance(brain["model_override"], str)
    ):
        errors.append("brain.model_override must be a string or null.")
    return errors


def _validate_mcp_entries(mcp: Any) -> List[str]:
    if not isinstance(mcp, list):
        return ["tools.mcp must be a list of server mappings."]
    errors = []
    for index, entry in enumerate(mcp):
        if not isinstance(entry, dict) or not isinstance(entry.get("server"), str) or not entry.get("server"):
            errors.append(f"tools.mcp[{index}] must be a mapping with a server name.")
            continue
        if "config" in entry and not isinstance(entry["config"], str):
            errors.append(f"tools.mcp[{index}].config must be a string.")
    return errors


def _validate_custom_entries(custom: Any) -> List[str]:
    if not isinstance(custom, list):
        return ["tools.custom must be a list of module names or path mappings."]
    errors = []
    for index, entry in enumerate(custom):
        if isinstance(entry, str) and entry:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("path"), str) and entry.get("path"):
            continue
        errors.append(
            f"tools.custom[{index}] must be a module name or a mapping with path."
        )
    return errors


def _validate_tools(tools: Any) -> List[str]:
    if not isinstance(tools, dict):
        return [
            "tools must be a mapping with builtin, mcp, and custom. "
            "A list was not written. Built-in tools belong under tools.builtin "
            "(bash, read, glob)."
        ]
    errors = []
    for key in tools:
        if key not in {"builtin", "mcp", "custom"}:
            errors.append(
                f"tools.{key} was not applied. Use tools.builtin, tools.mcp, or tools.custom."
            )
    if "builtin" in tools:
        builtin = tools["builtin"]
        if not isinstance(builtin, list) or not all(isinstance(item, str) for item in builtin):
            errors.append("tools.builtin must be a list of tool names.")
        else:
            unknown = [item for item in builtin if item not in VALID_BUILTIN_TOOLS]
            if unknown:
                errors.append(
                    "tools.builtin has unknown tools: "
                    + ", ".join(unknown)
                    + ". Valid tools: bash, read, glob."
                )
    if "mcp" in tools:
        errors.extend(_validate_mcp_entries(tools["mcp"]))
    if "custom" in tools:
        errors.extend(_validate_custom_entries(tools["custom"]))
    return errors


def _validate_harness(harness: Any) -> List[str]:
    if not isinstance(harness, dict):
        return ["harness must be a mapping with permissions and principles."]
    errors = []
    for key in harness:
        if key not in {"permissions", "principles"}:
            errors.append(
                f"harness.{key} was not applied. Use harness.permissions or harness.principles."
            )
    if "permissions" in harness:
        errors.extend(_permission_errors(harness["permissions"], "harness.permissions"))
    if "principles" in harness:
        principles = harness["principles"]
        if not isinstance(principles, list) or not all(isinstance(item, str) for item in principles):
            errors.append("harness.principles must be a list of strings.")
    return errors


def _validate_runtime(runtime: Any) -> List[str]:
    if not isinstance(runtime, dict):
        return ["runtime must be a mapping."]
    errors = []
    for key in runtime:
        if key not in {"python_version", "requirements"}:
            errors.append(
                f"runtime.{key} was not applied. Use runtime.python_version or runtime.requirements."
            )
    if "python_version" in runtime:
        version = runtime["python_version"]
        if not isinstance(version, str) or version not in SUPPORTED_PYTHON_VERSIONS:
            shown = version if isinstance(version, str) else type(version).__name__
            errors.append(
                f"Unsupported Python version '{shown}'. Supported versions: 3.11, 3.12."
            )
    if "requirements" in runtime:
        requirements = runtime["requirements"]
        if not isinstance(requirements, list) or not all(isinstance(item, str) for item in requirements):
            errors.append("runtime.requirements must be a list of package names.")
    return errors


def _validate_agent_config_update(updates: Any) -> List[str]:
    """Return reasons this patch must not be written. Empty means it is safe to merge."""
    if not isinstance(updates, dict):
        return ["config_yaml must be a mapping of agent.yaml fields."]
    if not updates:
        return ["config_yaml had no fields."]
    errors: List[str] = []
    for key, value in updates.items():
        if key not in _AGENT_YAML_TOP_LEVEL:
            errors.extend(_unknown_top_level_error(key, value))
    if "name" in updates and not isinstance(updates["name"], str):
        errors.append("name must be a string.")
    if "version" in updates and not isinstance(updates["version"], str):
        errors.append("version must be a string.")
    if "description" in updates and not isinstance(updates["description"], str):
        errors.append("description must be a string.")
    if "brain" in updates:
        errors.extend(_validate_brain(updates["brain"]))
    if "tools" in updates:
        errors.extend(_validate_tools(updates["tools"]))
    if "harness" in updates:
        errors.extend(_validate_harness(updates["harness"]))
    if "runtime" in updates:
        errors.extend(_validate_runtime(updates["runtime"]))
    if "repository" in updates and not isinstance(updates["repository"], dict):
        errors.append("repository must be a mapping.")
    if "skills" in updates and not isinstance(updates["skills"], list):
        errors.append("skills must be a list.")
    if "deployment" in updates and not isinstance(updates["deployment"], dict):
        errors.append("deployment must be a mapping.")
    return errors


def _applied_lines(updates: dict) -> List[str]:
    """Lines that name only fields this patch stores."""
    lines: List[str] = []
    if isinstance(updates.get("description"), str):
        lines.append(f"description: {updates['description']}")
    if isinstance(updates.get("version"), str):
        lines.append(f"version: {updates['version']}")
    if isinstance(updates.get("name"), str):
        lines.append(f"name: {updates['name']}")
    brain = updates.get("brain")
    if isinstance(brain, dict):
        if "model" in brain:
            lines.append(f"brain.model: {brain['model']}")
        if "instructions_file" in brain:
            lines.append(f"brain.instructions_file: {brain['instructions_file']}")
        if "model_override" in brain:
            lines.append(f"brain.model_override: {brain['model_override']}")
    tools = updates.get("tools")
    if isinstance(tools, dict):
        if isinstance(tools.get("builtin"), list):
            lines.append("tools.builtin: " + ", ".join(tools["builtin"]))
        if isinstance(tools.get("mcp"), list):
            names = [
                entry["server"]
                for entry in tools["mcp"]
                if isinstance(entry, dict) and isinstance(entry.get("server"), str)
            ]
            lines.append("tools.mcp: " + ", ".join(names))
        if isinstance(tools.get("custom"), list):
            labels = []
            for entry in tools["custom"]:
                if isinstance(entry, str):
                    labels.append(entry)
                elif isinstance(entry, dict) and isinstance(entry.get("path"), str):
                    labels.append(entry["path"])
            lines.append("tools.custom: " + ", ".join(labels))
    harness = updates.get("harness")
    if isinstance(harness, dict):
        permissions = harness.get("permissions")
        if isinstance(permissions, dict):
            parts = [f"{tool}={level}" for tool, level in permissions.items()]
            lines.append("harness.permissions: " + ", ".join(parts))
        if isinstance(harness.get("principles"), list):
            lines.append("harness.principles: " + "; ".join(harness["principles"]))
    runtime = updates.get("runtime")
    if isinstance(runtime, dict):
        if "python_version" in runtime:
            lines.append(f"runtime.python_version: {runtime['python_version']}")
        if isinstance(runtime.get("requirements"), list):
            lines.append("runtime.requirements: " + ", ".join(runtime["requirements"]))
    if isinstance(updates.get("repository"), dict):
        lines.append("repository")
    if isinstance(updates.get("skills"), list):
        lines.append("skills")
    if isinstance(updates.get("deployment"), dict):
        lines.append("deployment")
    return lines


def _current_brain_model(existing: Any) -> str:
    if not isinstance(existing, dict):
        return ""
    brain = existing.get("brain")
    if isinstance(brain, dict) and isinstance(brain.get("model"), str):
        return brain["model"]
    return ""


def _rejection_message(name: str, existing: Any, errors: List[str]) -> str:
    lines = [f"Did not update agent.yaml for '{name}'. Nothing was applied."]
    lines.extend(f"- {error}" for error in errors)
    current = _current_brain_model(existing)
    if current:
        lines.append(f"brain.model is still {current}.")
    return "\n".join(lines)


def _deep_merge(base: dict, updates: dict) -> dict:
    for key, value in updates.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


@tool
def update_agent_config(name: str, config_yaml: str) -> str:
    """
    Merge a YAML patch into agent.yaml.

    The runtime loads only this shape. Other keys are not written, and this
    tool then reports that nothing was applied:

    brain:
      model: openrouter/minimax/minimax-m2.5
    tools:
      builtin: [bash, read, glob]
      mcp: []
      custom: []
    harness:
      permissions:
        bash: ask

    brain.model must be a catalog id (recommend_model returns those).
    Permission levels are always-allow, ask, and deny.
    Do not set a top-level model, a tools list, top-level permissions, or memory.

    The result lists every stored field under Applied. Tell the user only
    those settings. If the result says nothing was applied, say that.

    Args:
        name: The name of the agent to update.
        config_yaml: The YAML content to merge into agent.yaml.
    """
    agent_path = _ensure_agent_exists(name)
    agent_yaml_path = agent_path / "agent.yaml"

    try:
        existing = yaml.safe_load(agent_yaml_path.read_text()) or {}
    except yaml.YAMLError as exc:
        return (
            f"Did not update agent.yaml for '{name}'. Nothing was applied.\n"
            f"- agent.yaml could not be read: {exc}"
        )
    if not isinstance(existing, dict):
        existing = {}

    try:
        updates = yaml.safe_load(config_yaml)
    except yaml.YAMLError as exc:
        return _rejection_message(name, existing, [f"Invalid YAML: {exc}"])

    if updates is None:
        return _rejection_message(name, existing, ["config_yaml was empty."])

    errors = _validate_agent_config_update(updates)
    if errors:
        return _rejection_message(name, existing, errors)

    merged = _deep_merge(existing, updates)
    with open(agent_yaml_path, "w") as handle:
        yaml.dump(merged, handle, default_flow_style=False, sort_keys=False)

    applied = _applied_lines(updates)
    message = "Updated: " + ", ".join(applied) if applied else "Updated agent configuration"
    create_version(name, source="builder", message=message, agents_dir=AGENTS_DIR)

    lines = [f"Updated agent.yaml for '{name}'.", "Applied:"]
    lines.extend(f"- {line}" for line in applied)
    lines.append("Nothing else was changed.")
    return "\n".join(lines)


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
    
    # Catalog ids only. A hyphenated alias such as claude-3-5-haiku is not stored.
    note = " Set this id under brain.model. Do not set a top-level model key."
    if is_complex:
        return (
            "openrouter/anthropic/claude-sonnet-4.6 - Best for complex reasoning and long context tasks."
            + note
        )
    elif is_coding:
        return (
            "openrouter/anthropic/claude-3.7-sonnet - Excellent for coding and general development tasks."
            + note
        )
    elif is_simple:
        return (
            "openrouter/anthropic/claude-3-haiku or openrouter/openai/gpt-4o-mini - "
            "Fast and cost-effective for simple automation."
            + note
        )
    else:
        return (
            "openrouter/anthropic/claude-3.7-sonnet - Good all-rounder for most agent tasks."
            + note
        )


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
