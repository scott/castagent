"""Session topic titles and a stand-in model. No network calls."""
import json
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest

from cast import sessions
from cast.providers import session_topic


@pytest.fixture
def temp_cast_home(monkeypatch, tmp_path):
    monkeypatch.setattr(sessions, "CAST_HOME", tmp_path)
    monkeypatch.setattr(sessions, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(sessions, "DB_PATH", tmp_path / "cast.db")
    return tmp_path


@pytest.fixture
def store(temp_cast_home):
    return sessions.SessionStore()


class FakeLLM:
    def __init__(self, content="Topic: Fix the login redirect loop", error=None):
        self.content = content
        self.error = error
        self.calls = []

    def invoke(self, messages, **kwargs):
        self.calls.append({"messages": messages, "kwargs": kwargs})
        if self.error:
            raise self.error
        return SimpleNamespace(content=self.content)


class FakeProvider:
    def __init__(self, *, available=True, content="Topic: Fix the login redirect loop", create_error=None, invoke_error=None):
        self._available = available
        self.create_error = create_error
        self.llm = FakeLLM(content=content, error=invoke_error)
        self.models = []

    def is_available(self):
        return self._available

    def create_llm(self, model=None, **kwargs):
        self.models.append(model)
        if self.create_error:
            raise self.create_error
        return self.llm


def _block_network(monkeypatch):
    def blocked(*_args, **_kwargs):
        raise AssertionError("network call")

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(session_topic, "get_provider", blocked)


def _write_agent(agents_dir: Path, name: str, model: str) -> None:
    agent_dir = agents_dir / name
    agent_dir.mkdir(parents=True)
    (agent_dir / "agent.yaml").write_text(
        f"name: {name}\nbrain:\n  model: {model}\n",
        encoding="utf-8",
    )


class TestTitleAndFreshness:
    def test_title_order(self):
        assert session_topic.session_display_title(
            name="Kept name",
            topic="Login redirect",
            first_user_message="please fix login",
        ) == "Kept name"
        assert session_topic.session_display_title(
            name=None,
            topic="Login redirect",
            first_user_message="please fix login",
        ) == "Login redirect"
        assert session_topic.session_display_title(
            name="  ",
            topic="",
            first_user_message="please fix login",
        ) == "please fix login"
        assert session_topic.session_display_title(
            name=None,
            topic=None,
            first_user_message=None,
        ) == "(untitled)"

    def test_first_message_collapses_and_cuts(self):
        assert session_topic.session_display_title(
            first_user_message="  please\nfix   login  ",
        ) == "please fix login"
        long = "word " * 30
        title = session_topic.session_display_title(first_user_message=long)
        assert len(title) == session_topic.TOPIC_CHAR_LIMIT
        assert title.endswith("…")
        # A stored topic still wins over the first message when it is stale.
        assert session_topic.session_display_title(
            topic="Old topic",
            first_user_message="please fix login",
        ) == "Old topic"

    def test_freshness_compares_message_counts(self):
        assert session_topic.topic_is_fresh("Old topic", 2, 2) is True
        assert session_topic.topic_is_fresh("Old topic", 1, 2) is False
        assert session_topic.topic_is_fresh("", 2, 2) is False
        assert session_topic.topic_is_fresh("Old topic", None, 2) is False
        assert session_topic.topic_is_fresh(None, 2, 2) is False

    def test_sanitize_model_output(self):
        assert session_topic.sanitize_topic("Topic: Fix the login redirect loop") == "Fix the login redirect loop"
        assert session_topic.sanitize_topic("  topic:   hello\nworld  ") == "hello world"
        assert session_topic.sanitize_topic("Topic: Topic: nested") == "nested"
        assert session_topic.sanitize_topic('"Fix the login redirect"') == "Fix the login redirect"
        assert session_topic.sanitize_topic("Topic:") == ""
        long = "a" * 80
        out = session_topic.sanitize_topic(long)
        assert len(out) == 60
        assert out.endswith("…")
        assert out[:-1] == "a" * 59


class TestTranscriptSlice:
    def test_keeps_early_and_late_turns_under_budget(self):
        messages = [{"role": "user", "text": f"EARLY {index}"} for index in range(4)]
        messages += [{"role": "user", "text": f"MIDDLE {index} unique-middle-token"} for index in range(6)]
        messages += [{"role": "agent", "text": f"LATE {index}"} for index in range(4)]
        text = session_topic.bounded_transcript(messages)
        assert "EARLY 0" in text
        assert "LATE 3" in text
        assert "unique-middle-token" not in text
        assert len(text) <= session_topic.TRANSCRIPT_CHAR_BUDGET
        assert "earlier turns omitted" in text

    def test_long_turn_stays_inside_budget(self):
        text = session_topic.bounded_transcript(
            [{"role": "user", "text": "X" * 10000}],
            budget=500,
        )
        assert len(text) <= 500
        assert text.startswith("User:")


class TestCompleteSessionTopic:
    def test_success_sanitizes_one_completion_without_tools(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(content="Topic: Fix the login redirect loop\nmore")
        topic = session_topic.complete_session_topic(
            "openrouter/anthropic/claude-3.5-haiku",
            "User: the login redirect loops",
            provider=provider,
        )
        assert topic == "Fix the login redirect loop more"
        assert provider.models == ["openrouter/anthropic/claude-3.5-haiku"]
        assert len(provider.llm.calls) == 1
        call = provider.llm.calls[0]
        assert call["kwargs"] == {}
        assert len(call["messages"]) == 2
        assert call["messages"][0].content == session_topic.TOPIC_SYSTEM_PROMPT
        assert "one line" in session_topic.TOPIC_SYSTEM_PROMPT.lower()
        assert "Topic:" in session_topic.TOPIC_SYSTEM_PROMPT
        assert call["messages"][1].content == "User: the login redirect loops"

    def test_content_blocks(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(content=[{"type": "text", "text": "Topic: Login redirect"}])
        # FakeLLM returns SimpleNamespace(content=list). _message_text reads that.
        topic = session_topic.complete_session_topic("model-a", "User: hi", provider=provider)
        assert topic == "Login redirect"

    def test_provider_unavailable_does_not_build_a_model(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(available=False)
        assert session_topic.complete_session_topic("model-a", "User: hi", provider=provider) is None
        assert provider.models == []

    def test_create_llm_failure_returns_none(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(create_error=RuntimeError("cannot build"))
        assert session_topic.complete_session_topic("model-a", "User: hi", provider=provider) is None
        assert provider.llm.calls == []

    def test_invoke_failure_returns_none(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(invoke_error=RuntimeError("upstream"))
        assert session_topic.complete_session_topic("model-a", "User: hi", provider=provider) is None

    def test_empty_sanitized_output_returns_none(self, monkeypatch):
        _block_network(monkeypatch)
        provider = FakeProvider(content="Topic:")
        assert session_topic.complete_session_topic("model-a", "User: hi", provider=provider) is None

    def test_get_provider_receives_the_model_when_not_injected(self, monkeypatch):
        seen = []

        def fake_get(model=None):
            seen.append(model)
            return FakeProvider(available=False)

        monkeypatch.setattr(session_topic, "get_provider", fake_get)
        assert session_topic.complete_session_topic("digitalocean/llama3", "User: hi") is None
        assert seen == ["digitalocean/llama3"]

    def test_resolve_model_from_agent_yaml(self, tmp_path):
        _write_agent(tmp_path, "alpha", "openrouter/anthropic/claude-3.5-haiku")
        _write_agent(tmp_path, "beta", "digitalocean/llama3.3-70b-instruct")
        assert session_topic.resolve_agent_model(
            "alpha", tmp_path,
        ) == "openrouter/anthropic/claude-3.5-haiku"
        assert session_topic.resolve_agent_model(
            "beta", tmp_path,
        ) == "digitalocean/llama3.3-70b-instruct"
        assert session_topic.resolve_agent_model("missing", tmp_path) is None
        (tmp_path / "empty").mkdir()
        assert session_topic.resolve_agent_model("empty", tmp_path) is None
        assert session_topic.resolve_agent_model("../outside", tmp_path) is None


class TestRefreshTopic:
    def _session(self, store, agents, agent="alpha", model="openrouter/anthropic/claude-3.5-haiku", text="please fix the login redirect loop"):
        _write_agent(agents, agent, model)
        session = store.create(agent)
        if text is not None:
            store.append_message(session.id, "user", text)
        return session

    def test_success_persists_topic_for_that_agents_model(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        session = self._session(store, agents)
        before = store._get_meta_row(session.id).updated_at
        provider = FakeProvider(content="Topic: Fix the login redirect loop")
        topic = store.refresh_topic(session.id, provider=provider, agents_dir=agents)
        assert topic == "Fix the login redirect loop"
        assert provider.models == ["openrouter/anthropic/claude-3.5-haiku"]
        assert len(provider.llm.calls) == 1
        meta = store._get_meta_row(session.id)
        assert meta.topic == topic
        assert meta.topic_message_count == meta.message_count == 1
        assert meta.name is None
        assert meta.updated_at == before
        data = json.loads((temp_cast_home / "sessions" / f"{session.id}.json").read_text())
        assert data["topic"] == topic
        assert session_topic.session_display_title(
            name=meta.name,
            topic=meta.topic,
            first_user_message=meta.first_user_message,
        ) == topic
        assert "please fix the login redirect loop" in provider.llm.calls[0]["messages"][1].content

    def test_second_open_does_not_call_the_model_until_a_new_user_message(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        session = self._session(store, agents)
        provider = FakeProvider(content="Topic: Login redirect")
        assert store.refresh_topic(session.id, provider=provider, agents_dir=agents) == "Login redirect"
        assert store.refresh_topic(session.id, provider=provider, agents_dir=agents) == "Login redirect"
        assert len(provider.llm.calls) == 1

        store.append_message(session.id, "user", "the signup page is broken too")
        provider.llm.content = "Topic: Login and signup bugs"
        refreshed = store.refresh_topic(session.id, provider=provider, agents_dir=agents)
        assert refreshed == "Login and signup bugs"
        assert len(provider.llm.calls) == 2
        meta = store._get_meta_row(session.id)
        assert meta.topic == refreshed
        assert meta.topic_message_count == meta.message_count

    def test_two_agents_use_their_own_models(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        first = self._session(store, agents, agent="alpha", model="openrouter/model-alpha")
        second = self._session(store, agents, agent="beta", model="digitalocean/model-beta")
        provider = FakeProvider(content="Topic: Shared label")
        store.refresh_topic(first.id, provider=provider, agents_dir=agents)
        store.refresh_topic(second.id, provider=provider, agents_dir=agents)
        assert provider.models == ["openrouter/model-alpha", "digitalocean/model-beta"]

    def test_zero_user_messages_skip_the_model(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        session = self._session(store, agents, text=None)
        provider = FakeProvider()
        assert store.refresh_topic(session.id, provider=provider, agents_dir=agents) is None
        assert provider.models == []
        assert store._get_meta_row(session.id).topic is None

    def test_named_session_is_not_summarized_or_renamed(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        _write_agent(agents, "alpha", "openrouter/model-alpha")
        session = store.create("alpha", name="Kept name")
        store.append_message(session.id, "user", "please fix login")
        provider = FakeProvider(content="Topic: Should not replace the name")
        assert store.refresh_topic(session.id, provider=provider, agents_dir=agents) is None
        assert provider.models == []
        meta = store._get_meta_row(session.id)
        assert meta.name == "Kept name"
        assert meta.topic is None

    def test_missing_agent_yaml_skips(self, store, temp_cast_home, monkeypatch):
        _block_network(monkeypatch)
        session = store.create("ghost")
        store.append_message(session.id, "user", "hello")
        provider = FakeProvider()
        assert store.refresh_topic(
            session.id,
            provider=provider,
            agents_dir=temp_cast_home / "agents",
        ) is None
        assert provider.models == []
        assert store._get_meta_row(session.id).topic is None

    @pytest.mark.parametrize(
        "provider",
        [
            FakeProvider(available=False),
            FakeProvider(create_error=RuntimeError("build failed")),
            FakeProvider(invoke_error=RuntimeError("call failed")),
            FakeProvider(content="Topic:"),
        ],
    )
    def test_failure_does_not_persist_a_topic(self, store, temp_cast_home, monkeypatch, provider):
        _block_network(monkeypatch)
        agents = temp_cast_home / "agents"
        session = self._session(store, agents)
        assert store.refresh_topic(session.id, provider=provider, agents_dir=agents) is None
        meta = store._get_meta_row(session.id)
        assert meta.topic is None
        assert meta.topic_message_count is None
        assert meta.first_user_message == "please fix the login redirect loop"
        data = json.loads((temp_cast_home / "sessions" / f"{session.id}.json").read_text())
        assert data.get("topic") in (None, "")
        assert session_topic.session_display_title(
            name=meta.name,
            topic=meta.topic,
            first_user_message=meta.first_user_message,
        ) == "please fix the login redirect loop"
