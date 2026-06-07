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