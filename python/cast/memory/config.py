import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MemoryConfig:
    enabled: bool = True
    categories: list[str] = field(default_factory=lambda: [
        "learned", "decision", "pattern", "error_learned", "accomplishment",
        "preference", "context", "project", "tools_used", "boundary",
        "relationship", "todo", "question_asked", "directive_given"
    ])
    max_per_category: int = 100
    relevance_threshold: float = 0.7
    reflection_model: Optional[str] = None

    @classmethod
    def from_file(cls, path: Path) -> "MemoryConfig":
        if not path.exists():
            return cls()
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        memory_config = data.get("memory", {})
        return cls(
            enabled=memory_config.get("enabled", True),
            categories=memory_config.get("categories", cls().categories),
            max_per_category=memory_config.get("max_per_category", 100),
            relevance_threshold=memory_config.get("relevance_threshold", 0.7),
            reflection_model=memory_config.get("reflection_model"),
        )

    def to_dict(self) -> dict:
        return {
            "memory": {
                "enabled": self.enabled,
                "categories": self.categories,
                "max_per_category": self.max_per_category,
                "relevance_threshold": self.relevance_threshold,
                "reflection_model": self.reflection_model,
            }
        }

    def write(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.dump(self.to_dict(), f, default_flow_style=False)