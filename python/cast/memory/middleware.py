import asyncio
from pathlib import Path
from typing import Optional
from .store import MemoryStore, MemoryHighlight
from .config import MemoryConfig
from .retriever import MemoryRetriever
from .reflection import ReflectionAgent


class MemoryMiddleware:
    def __init__(
        self,
        agent_path: Path | str,
        model_name: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        agent_path = Path(agent_path)
        self.config = MemoryConfig.from_file(agent_path / "memory" / "config.yaml")
        if not self.config.enabled:
            self.store = None
            self.retriever = None
            self.reflection = None
            return

        self.store = MemoryStore(agent_path)
        self.retriever = MemoryRetriever(self.store, self.config.relevance_threshold)
        
        model = model_name or self.config.reflection_model or "claude-haiku-latest"
        self.reflection = ReflectionAgent(model, api_key)

    @property
    def enabled(self) -> bool:
        return self.config.enabled and self.store is not None

    async def record(self, user_message: str, agent_response: str, source: str) -> Optional[MemoryHighlight]:
        if not self.enabled:
            return None

        highlight = await self.reflection.reflect(user_message, agent_response, source)
        
        if highlight:
            self.store.append(highlight)
            self._enforce_limits(highlight.category)
        
        return highlight

    def record_sync(self, user_message: str, agent_response: str, source: str) -> Optional[MemoryHighlight]:
        if not self.enabled:
            return None

        highlight = self.reflection.reflect_sync(user_message, agent_response, source)
        
        if highlight:
            self.store.append(highlight)
            self._enforce_limits(highlight.category)
        
        return highlight

    def retrieve(self, context: str, limit: int = 5) -> list[MemoryHighlight]:
        if not self.enabled:
            return []
        return self.retriever.retrieve(context, limit=limit)

    def format_memories(self, context: str, limit: int = 5) -> str:
        if not self.enabled:
            return ""
        highlights = self.retrieve(context, limit=limit)
        return self.retriever.format_context(highlights)

    def _enforce_limits(self, category: str):
        count = self.store.count_by_category(category)
        max_allowed = self.config.max_per_category
        
        if count > max_allowed:
            to_remove = count - max_allowed
            all_in_category = self.store.get_by_category(category)
            oldest = all_in_category[-to_remove:]  # oldest = first items (ascending timestamp)
            
            for h in oldest:
                if h.id:
                    self.store.delete(h.id)

    def get_stats(self) -> dict:
        if not self.enabled:
            return {"enabled": False}
        
        all_highlights = self.store.get_all()
        by_category = {}
        for h in all_highlights:
            by_category[h.category] = by_category.get(h.category, 0) + 1
        
        return {
            "enabled": True,
            "total": len(all_highlights),
            "by_category": by_category,
        }