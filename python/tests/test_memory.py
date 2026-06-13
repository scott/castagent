import tempfile
from pathlib import Path
from datetime import datetime, timezone
import pytest

from cast.memory import (
    MemoryStore,
    MemoryHighlight,
    MemoryConfig,
    PrivacyFilter,
    MemoryRetriever,
    MemoryMiddleware,
)


@pytest.fixture
def temp_dir():
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


class TestMemoryStore:
    @pytest.fixture
    def store(self, temp_dir):
        return MemoryStore(temp_dir)

    def test_append_and_get_all(self, store):
        highlight = MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Test content",
            source="test",
            tags=["test"]
        )
        store.append(highlight)
        
        all_highlights = store.get_all()
        assert len(all_highlights) == 1
        assert all_highlights[0].content == "Test content"

    def test_get_by_category(self, store):
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Learned something",
            source="test"
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="decision",
            content="Made a decision",
            source="test"
        ))
        
        learned = store.get_by_category("learned")
        assert len(learned) == 1
        assert learned[0].content == "Learned something"

    def test_search(self, store):
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="How to resolve git conflicts",
            source="test",
            tags=["git"]
        ))
        
        results = store.search("git")
        assert len(results) == 1
        assert "git" in results[0].content.lower()

    def test_count(self, store):
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="First",
            source="test"
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="decision",
            content="Second",
            source="test"
        ))
        
        assert store.count() == 2

    def test_is_new_property(self, temp_dir):
        new_store = MemoryStore(temp_dir / "new_agent", warn_on_new=False)
        assert new_store.is_new is True
        
        second_store = MemoryStore(temp_dir / "new_agent", warn_on_new=False)
        assert second_store.is_new is False

    def test_warn_on_wrong_path(self, temp_dir):
        memory_path = temp_dir / "agent" / "memory"
        memory_path.mkdir(parents=True)
        
        with pytest.warns(UserWarning, match="appears to be a memory directory"):
            MemoryStore(memory_path, warn_on_new=True)

    def test_delete(self, store):
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="To be deleted",
            source="test"
        ))
        highlights = store.get_all()
        assert len(highlights) == 1
        
        deleted = store.delete(highlights[0].id)
        assert deleted is True
        assert store.count() == 0

    def test_clear_category(self, store):
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Keep this",
            source="test"
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="to_clear",
            content="Remove this",
            source="test"
        ))
        
        removed = store.clear_category("to_clear")
        assert removed == 1
        assert store.count() == 1
        assert store.get_all()[0].content == "Keep this"


class TestPrivacyFilter:
    def test_scrub_api_key(self):
        filter = PrivacyFilter()
        text = "API key: sk-1234567890abcdef"
        result = filter.scrub(text)
        assert "sk-1234567890abcdef" not in result
        assert "[REDACTED]" in result

    def test_scrub_github_token(self):
        filter = PrivacyFilter()
        text = "ghp_abcdefghij1234567890abcdefghij1234567890"
        result = filter.scrub(text)
        assert "ghp_" not in result
        assert "[REDACTED]" in result

    def test_scrub_email(self):
        filter = PrivacyFilter()
        text = "Contact me at john@example.com"
        result = filter.scrub(text)
        assert "john@example.com" not in result
        assert "[REDACTED]" in result

    def test_scrub_dict(self):
        filter = PrivacyFilter()
        data = {
            "name": "John",
            "api_key": "secret123",
            "nested": {"token": "another_secret"}
        }
        result = filter.scrub_dict(data)
        assert result["name"] == "John"
        assert result["api_key"] == "[REDACTED]"
        assert result["nested"]["token"] == "[REDACTED]"


class TestMemoryRetriever:
    @pytest.fixture
    def store_with_highlights(self, temp_dir):
        store = MemoryStore(temp_dir)
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Always check both branches when resolving git merge conflicts",
            source="test",
            tags=["git", "merge"]
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="decision",
            content="Decided to use feature flags for gradual rollout",
            source="test",
            tags=["deployment", "feature-flags"]
        ))
        return store

    def test_retrieve_relevant(self, store_with_highlights):
        retriever = MemoryRetriever(store_with_highlights, threshold=0.3)
        results = retriever.retrieve("git merge conflict resolution", limit=5)
        
        assert len(results) >= 1
        assert any("git" in r.content.lower() for r in results)

    def test_retrieve_by_category(self, store_with_highlights):
        retriever = MemoryRetriever(store_with_highlights, threshold=0.3)
        results = retriever.retrieve_by_category("learned", limit=5)
        
        assert len(results) == 1
        assert results[0].category == "learned"

    def test_format_context(self, store_with_highlights):
        retriever = MemoryRetriever(store_with_highlights, threshold=0.1)
        highlights = store_with_highlights.get_all()
        formatted = retriever.format_context(highlights)
        
        assert "Relevant memories" in formatted
        assert "LEARNED" in formatted


class TestMemoryConfig:
    def test_default_config(self):
        config = MemoryConfig()
        
        assert config.enabled is True
        assert "learned" in config.categories
        assert "decision" in config.categories
        assert config.max_per_category == 100

    def test_from_file_not_exists(self, temp_dir):
        config = MemoryConfig.from_file(temp_dir / "nonexistent.yaml")
        
        assert config.enabled is True
        assert len(config.categories) == 14

    def test_from_file_exists(self, temp_dir):
        config_path = temp_dir / "config.yaml"
        config_path.write_text("""
memory:
  enabled: true
  categories:
    - custom_category
  max_per_category: 50
""")
        
        config = MemoryConfig.from_file(config_path)
        
        assert config.enabled is True
        assert "custom_category" in config.categories
        assert config.max_per_category == 50


class TestMemoryMiddleware:
    def test_enabled_when_config_exists(self, temp_dir):
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""
memory:
  enabled: true
  categories:
    - learned
  max_per_category: 100
  relevance_threshold: 0.7
""")
        
        middleware = MemoryMiddleware(temp_dir)
        
        assert middleware.enabled is True

    def test_disabled_when_config_disabled(self, temp_dir):
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""
memory:
  enabled: false
""")
        
        middleware = MemoryMiddleware(temp_dir)
        
        assert middleware.enabled is False

    def test_record_sync_graceful_no_api_key(self, temp_dir):
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""
memory:
  enabled: true
  categories:
    - learned
  max_per_category: 100
  relevance_threshold: 0.7
""")
        
        middleware = MemoryMiddleware(temp_dir)
        result = middleware.record_sync(
            "user message",
            "agent response",
            "test_source"
        )
        
        assert result is None

    def test_get_stats(self, temp_dir):
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""
memory:
  enabled: true
  categories:
    - learned
  max_per_category: 100
  relevance_threshold: 0.7
""")
        
        middleware = MemoryMiddleware(temp_dir)
        stats = middleware.get_stats()
        
        assert stats["enabled"] is True
        assert "total" in stats
        assert "by_category" in stats


class TestMemoryMiddlewareEndToEnd:
    """End-to-end tests for MemoryMiddleware memory retrieval with recency fallback.

    These tests verify AC1 from issue #17: format_memories always includes
    recent highlights even when the relevance threshold is not met, so that
    the dedicated memory feature works for follow-up questions with zero
    keyword overlap.
    """

    def test_recency_fallback_with_zero_keyword_overlap(self, temp_dir):
        """AC1: format_memories returns recent highlights when relevance score is 0."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: true
  categories:
    - preference
  max_per_category: 100
  relevance_threshold: 0.7
  recency_count: 3
  relevance_count: 3
""")

        # Insert a highlight directly (no reflection/LLM needed)
        store = MemoryStore(temp_dir, warn_on_new=False)
        highlight = MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content="User Alex prefers dark mode in all tools and apps.",
            source="test",
            tags=["preference", "dark-mode"]
        )
        store.append(highlight)

        # Construct a real MemoryMiddleware (no API key needed; ReflectionAgent
        # gracefully handles missing keys by setting self.llm = None)
        middleware = MemoryMiddleware(temp_dir)

        # Query with zero keyword overlap with the stored memory
        result = middleware.format_memories(
            "What theme should I use for my dashboard?"
        )

        # Must be non-empty and contain the stored preference
        assert result != "", "format_memories should not be empty with stored memories"
        assert "dark mode" in result.lower(), (
            "Dark mode preference should be included via recency fallback"
        )
        assert "[Recent memories:]" in result, (
            "Output should contain a 'Recent memories' section"
        )

    def test_recency_fallback_multiple_highlights(self, temp_dir):
        """AC1: recent section includes multiple highlights, relevant section is absent."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: true
  categories:
    - preference
    - learned
  max_per_category: 100
  relevance_threshold: 0.7
  recency_count: 2
  relevance_count: 3
""")

        store = MemoryStore(temp_dir, warn_on_new=False)
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content="User prefers dark mode in all tools.",
            source="test",
            tags=["preference"]
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Learned that the API rate limit is 100 req/min.",
            source="test",
            tags=["api"]
        ))

        middleware = MemoryMiddleware(temp_dir)
        result = middleware.format_memories("What theme should I pick?")

        assert result != ""
        assert "[Recent memories:]" in result
        assert "[Relevant memories from past interactions:]" not in result, (
            "No relevant section expected — query has zero keyword overlap"
        )
        assert "dark mode" in result.lower()
        assert "rate limit" in result.lower()

    def test_relevant_and_recent_both_present(self, temp_dir):
        """AC1: when relevance threshold is met, both sections appear."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: true
  categories:
    - preference
    - learned
  max_per_category: 100
  relevance_threshold: 0.3
  recency_count: 2
  relevance_count: 3
""")

        store = MemoryStore(temp_dir, warn_on_new=False)
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="learned",
            content="Learned that the API rate limit is 100 req/min.",
            source="test",
            tags=["api", "rate-limit"]
        ))
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content="User prefers dark mode for UI.",
            source="test",
            tags=["preference"]
        ))

        middleware = MemoryMiddleware(temp_dir)
        # "rate limit" partially overlaps with "rate-limit" tag
        result = middleware.format_memories("What is the rate limit?")

        assert result != ""
        assert "[Recent memories:]" in result
        assert "[Relevant memories from past interactions:]" in result
        assert "rate limit" in result.lower()

    def test_disabled_memory_returns_empty(self, temp_dir):
        """format_memories returns empty when memory is disabled."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: false
""")

        store = MemoryStore(temp_dir, warn_on_new=False)
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content="User prefers dark mode.",
            source="test",
            tags=[]
        ))

        middleware = MemoryMiddleware(temp_dir)
        result = middleware.format_memories("What theme should I use?")

        assert result == ""

    def test_empty_store_returns_empty(self, temp_dir):
        """format_memories returns empty when no memories exist."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: true
  categories:
    - preference
  max_per_category: 100
  relevance_threshold: 0.7
  recency_count: 3
  relevance_count: 3
""")

        middleware = MemoryMiddleware(temp_dir)
        result = middleware.format_memories("What theme should I use?")

        assert result == ""

    def test_deduplication_relevant_and_recent(self, temp_dir):
        """AC1: highlights appearing in both sections are not duplicated."""
        config_path = temp_dir / "memory" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("""\
memory:
  enabled: true
  categories:
    - preference
  max_per_category: 100
  relevance_threshold: 0.3
  recency_count: 5
  relevance_count: 5
""")

        store = MemoryStore(temp_dir, warn_on_new=False)
        store.append(MemoryHighlight(
            timestamp=datetime.now(timezone.utc).isoformat(),
            category="preference",
            content="User prefers dark mode in all tools.",
            source="test",
            tags=["preference", "dark"]
        ))

        middleware = MemoryMiddleware(temp_dir)
        # "dark" keyword overlaps with the "dark" tag — relevance threshold met
        result = middleware.format_memories("What dark theme should I use?")

        # The highlight should appear in BOTH sections if not deduplicated.
        # We expect it only in the relevant section (recency section deduped).
        # Check that "dark mode" appears exactly once (or at least the count is
        # reasonable — with dedup it appears in relevant section only, but the
        # text may mention it in the relevant section header line).
        count = result.lower().count("dark mode")
        assert count >= 1, "Dark mode should appear at least once"
        # It should not appear more than once in the main content (it's deduped
        # from the recent section). The only line with "dark mode" should be in
        # the relevant section.
        lines_with_dark_mode = [l for l in result.split("\n") if "dark mode" in l.lower()]
        assert len(lines_with_dark_mode) == 1, (
            "Dark mode should not be duplicated across sections"
        )