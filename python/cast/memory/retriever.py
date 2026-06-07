import re
from typing import Optional
from .store import MemoryStore, MemoryHighlight


class MemoryRetriever:
    def __init__(self, store: MemoryStore, threshold: float = 0.7):
        self.store = store
        self.threshold = threshold

    def retrieve(self, context: str, categories: Optional[list[str]] = None, limit: int = 10) -> list[MemoryHighlight]:
        context_words = self._extract_keywords(context)
        if not context_words:
            return self.store.get_recent(limit)

        scored = []
        for highlight in self.store.get_all():
            if categories and highlight.category not in categories:
                continue
            score = self._calculate_relevance(highlight, context_words)
            if score >= self.threshold:
                scored.append((score, highlight))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [h for _, h in scored[:limit]]

    def retrieve_by_category(self, category: str, limit: int = 10) -> list[MemoryHighlight]:
        return self.store.get_by_category(category)[:limit]

    def retrieve_recent(self, limit: int = 10) -> list[MemoryHighlight]:
        return self.store.get_recent(limit)

    def _extract_keywords(self, text: str) -> set[str]:
        text = text.lower()
        words = re.findall(r'\b[a-z]{3,}\b', text)
        stopwords = {'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'have', 'has', 'been', 'will', 'would', 'could', 'should', 'what', 'when', 'where', 'which', 'their', 'there', 'into', 'from', 'they', 'been', 'being', 'your', 'them', 'than', 'then', 'also', 'some', 'more', 'only', 'just', 'very'}
        return {w for w in words if w not in stopwords}

    def _calculate_relevance(self, highlight: MemoryHighlight, context_words: set[str]) -> float:
        content_words = self._extract_keywords(highlight.content)
        tag_words = set(t.lower() for t in highlight.tags)

        if not content_words:
            return 0.0

        overlap = len(context_words & content_words) + len(context_words & tag_words)
        max_possible = max(len(context_words), 1)

        recency_boost = 1.0
        return min((overlap / max_possible) * recency_boost, 1.0)

    def format_context(self, highlights: list[MemoryHighlight]) -> str:
        if not highlights:
            return ""

        by_category = {}
        for h in highlights:
            if h.category not in by_category:
                by_category[h.category] = []
            by_category[h.category].append(h)

        parts = ["[Relevant memories from past interactions:]"]
        for category, items in by_category.items():
            parts.append(f"\n{category.upper()}:")
            for h in items:
                parts.append(f"  - {h.content}")

        return "\n".join(parts)