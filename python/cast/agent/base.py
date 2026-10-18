import os
import re
import yaml
from typing import List, Optional


class AgentConfigError(Exception):
    """agent.yaml could not be parsed or validated."""


class AgentConfig:
    """Agent configuration loaded from agent.yaml."""
    
    def __init__(self, path: str):
        self.path = path
        self.config = self._load_config()
    
    def _load_config(self) -> dict:
        config_path = os.path.join(self.path, "agent.yaml")
        if not os.path.exists(config_path):
            return {}
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                text = handle.read()
            # Parse the string so the error still has the source line after
            # the file is closed.
            loaded = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise AgentConfigError(_format_yaml_error(config_path, exc)) from exc
        if loaded is None:
            return {}
        if not isinstance(loaded, dict):
            raise AgentConfigError(
                f"agent.yaml could not be validated ({config_path}): expected a mapping"
            )
        return loaded
    
    @property
    def name(self) -> str:
        return self.config.get("name", "unknown")
    
    @property
    def version(self) -> str:
        return self.config.get("version", "1.0")
    
    @property
    def description(self) -> str:
        return self.config.get("description", "")
    
    @property
    def model(self) -> str:
        brain = self.config.get("brain", {})
        if not isinstance(brain, dict):
            brain = {}
        model = brain.get("model", "openrouter/anthropic/claude-3-7-sonnet")
        if not isinstance(model, str) or not model:
            return "openrouter/anthropic/claude-3-7-sonnet"
        return model
    
    @property
    def instructions_file(self) -> str:
        brain = self.config.get("brain", {})
        if not isinstance(brain, dict):
            brain = {}
        instructions_file = brain.get("instructions_file", "instructions.md")
        if not isinstance(instructions_file, str) or not instructions_file:
            return "instructions.md"
        return instructions_file
    
    @property
    def instructions(self) -> str:
        instructions_path = os.path.join(self.path, self.instructions_file)
        if os.path.exists(instructions_path):
            with open(instructions_path, "r") as f:
                return f.read()
        return "You are a helpful assistant."

    @property
    def skills(self) -> List[dict]:
        """`skills:` entries from agent.yaml, in insertion order. Missing key is []."""
        raw = self.config.get("skills") or []
        if not isinstance(raw, list):
            return []
        return raw

    def load_skills(self) -> List[dict]:
        """Read each listed skill. Skip a missing directory or skill file.

        A bad file must not stop the agent from starting. `SKILL.md` and
        `skill.md` are both accepted.
        """
        loaded: List[dict] = []
        for entry in self.skills:
            if not isinstance(entry, dict):
                continue
            try:
                parsed = self._load_skill_entry(entry)
            except Exception:
                continue
            if parsed is not None:
                loaded.append(parsed)
        return loaded

    def rendered_prompt(self) -> str:
        """instructions.md, plus a Skills section when at least one skill loaded."""
        loaded = self.load_skills()
        if not loaded:
            return self.instructions
        parts = [self.instructions.rstrip("\n"), "", "## Skills"]
        for skill in loaded:
            parts.append("")
            parts.append(f"### {skill['name']}")
            parts.append(skill["description"])
            parts.append("")
            if skill["body"]:
                parts.append(skill["body"])
        return "\n".join(parts) + "\n"

    def agent_card_skills(self) -> List[dict]:
        """Installed skills, or the single synthetic skill when none loaded."""
        loaded = self.load_skills()
        if not loaded:
            return [{
                "id": f"{self.name}-skill",
                "name": self.name,
                "description": self.description,
            }]
        return [
            {
                "id": skill["name"],
                "name": skill["name"],
                "description": skill["description"],
            }
            for skill in loaded
        ]

    def _load_skill_entry(self, entry: dict) -> Optional[dict]:
        rel = entry.get("path")
        if not isinstance(rel, str) or not rel.strip() or os.path.isabs(rel):
            return None
        root = os.path.realpath(self.path)
        skill_dir = os.path.realpath(os.path.join(self.path, rel))
        if skill_dir != root and not skill_dir.startswith(root + os.sep):
            return None
        if not os.path.isdir(skill_dir):
            return None
        skill_md = _skill_markdown_path(skill_dir)
        if skill_md is None:
            return None
        with open(skill_md, "r", encoding="utf-8") as handle:
            parsed = _parse_skill_markdown(handle.read())
        if parsed is None:
            return None
        return {
            "name": parsed["name"],
            "description": parsed["description"],
            "body": parsed["body"],
            "path": rel,
        }
    
    @property
    def tools(self) -> dict:
        """Tool mapping the runtime loads. A list or other shape is ignored."""
        raw = self.config.get("tools", {})
        if not isinstance(raw, dict):
            return {}
        return raw
    
    @property
    def permissions(self) -> dict:
        harness = self.config.get("harness", {})
        if not isinstance(harness, dict):
            return {}
        raw = harness.get("permissions", {})
        if not isinstance(raw, dict):
            return {}
        return raw
    
    @property
    def principles(self) -> List[str]:
        harness = self.config.get("harness", {})
        if not isinstance(harness, dict):
            return []
        raw = harness.get("principles", [])
        if not isinstance(raw, list):
            return []
        return raw
    
    @classmethod
    def from_path(cls, path: str) -> "AgentConfig":
        return cls(path)


_SKILL_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.DOTALL)
_SKILL_MARKDOWN_NAMES = ("SKILL.md", "skill.md")


def _format_yaml_error(config_path: str, exc: yaml.YAMLError) -> str:
    """Include the file and the line PyYAML reports."""
    detail = str(exc).strip().replace("<unicode string>", config_path)
    mark = getattr(exc, "problem_mark", None)
    line = getattr(mark, "line", None) if mark is not None else None
    location = f"{config_path}:{line + 1}" if isinstance(line, int) else config_path
    return f"agent.yaml could not be parsed ({location}): {detail}"


def _collapse_skill_description(description: str) -> str:
    """Folded and literal YAML descriptions load as one line."""
    return " ".join(line.strip() for line in description.splitlines() if line.strip())


def _skill_markdown_path(skill_dir: str) -> Optional[str]:
    """Exact `SKILL.md` or `skill.md`. Prefer `SKILL.md` when both exist."""
    try:
        names = set(os.listdir(skill_dir))
    except OSError:
        return None
    for name in _SKILL_MARKDOWN_NAMES:
        if name not in names:
            continue
        candidate = os.path.join(skill_dir, name)
        if os.path.isfile(candidate):
            return candidate
    return None


def _parse_skill_markdown(text: str) -> Optional[dict]:
    match = _SKILL_FRONTMATTER.match(text)
    if not match:
        return None
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(meta, dict):
        return None
    name = meta.get("name")
    description = meta.get("description")
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(description, str):
        return None
    description = _collapse_skill_description(description)
    if not description:
        return None
    body = match.group(2)
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    return {
        "name": name.strip(),
        "description": description,
        "body": body.rstrip("\n"),
    }
