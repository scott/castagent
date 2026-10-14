import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from .store import MemoryStore, MemoryHighlight
from .config import MemoryConfig
from .retriever import MemoryRetriever
from .reflection import ReflectionAgent
from .explicit import explicit_remember_fact
from .filter import PrivacyFilter


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

    def remember_explicit(self, user_message: str) -> Optional[MemoryHighlight]:
        """Store an explicit remember request before the model replies.

        Reflection can decide a fact is not notable. The user asked for
        this one to persist, so it is written to memory/notes.md and the
        highlights table even when no model is available.
        """
        if not self.enabled or self.store is None:
            return None

        fact = explicit_remember_fact(user_message)
        if not fact:
            return None

        scrubber = self.reflection.filter if self.reflection is not None else PrivacyFilter()
        fact = " ".join(scrubber.scrub(fact).split())
        if not fact:
            return None

        self._append_note(fact)
        for existing in self.store.get_all():
            if existing.category == "preference" and existing.content == fact:
                return existing

        highlight = MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content=fact,
            source="explicit_remember",
            tags=["explicit", "remember"],
        )
        self.store.append(highlight)
        self._enforce_limits("preference")
        return highlight

    def _append_note(self, fact: str) -> None:
        notes = self.store.memory_dir / "notes.md"
        bullet = f"- {fact}"
        existing = notes.read_text(encoding="utf-8") if notes.is_file() else ""
        if bullet in (line.strip() for line in existing.splitlines()):
            return
        notes.parent.mkdir(parents=True, exist_ok=True)
        prefix = "\n" if existing and not existing.endswith("\n") else ""
        with notes.open("a", encoding="utf-8") as handle:
            handle.write(f"{prefix}{bullet}\n")

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

    def format_memories(self, context: str) -> str:
        if not self.enabled:
            return ""

        # Get relevance-filtered memories
        relevant = self.retriever.retrieve(context, limit=self.config.relevance_count)

        # Always include recent memories as a recency fallback
        recent = self.retriever.retrieve_recent(limit=self.config.recency_count)

        # Deduplicate: remove recent items already in relevant (by id)
        relevant_ids = {h.id for h in relevant if h.id is not None}
        unique_recent = [h for h in recent if h.id not in relevant_ids]

        return self.retriever.format_with_recency(relevant, unique_recent)

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