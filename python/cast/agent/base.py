import os
import yaml
from typing import List, Optional

class AgentConfig:
    """Agent configuration loaded from agent.yaml."""
    
    def __init__(self, path: str):
        self.path = path
        self.config = self._load_config()
    
    def _load_config(self) -> dict:
        config_path = os.path.join(self.path, "agent.yaml")
        if not os.path.exists(config_path):
            return {}
        with open(config_path, "r") as f:
            return yaml.safe_load(f) or {}
    
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
        return brain.get("model", "openrouter/anthropic/claude-3-7-sonnet")
    
    @property
    def instructions_file(self) -> str:
        brain = self.config.get("brain", {})
        return brain.get("instructions_file", "instructions.md")
    
    @property
    def instructions(self) -> str:
        instructions_path = os.path.join(self.path, self.instructions_file)
        if os.path.exists(instructions_path):
            with open(instructions_path, "r") as f:
                return f.read()
        return "You are a helpful assistant."
    
    @property
    def tools(self) -> List[dict]:
        return self.config.get("tools", {})
    
    @property
    def permissions(self) -> dict:
        harness = self.config.get("harness", {})
        return harness.get("permissions", {})
    
    @property
    def principles(self) -> List[str]:
        harness = self.config.get("harness", {})
        return harness.get("principles", [])
    
    @classmethod
    def from_path(cls, path: str) -> "AgentConfig":
        return cls(path)
