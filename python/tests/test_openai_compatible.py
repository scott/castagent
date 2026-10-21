"""Shared OpenAI-compatible provider, prefix routing, and sampling params."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from cast.providers.openai_compatible import OpenAICompatibleProvider
from cast.providers.openrouter import MODEL_ALIASES, rewrite_openrouter_model
from cast.providers.registry import (
    InferenceProviderError,
    get_provider,
    load_registry,
    register_compatible_row,
    select_provider,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "inference" / "fakeai.json"
PYTHON = ROOT / "python"


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "OPENROUTER_API_KEY",
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "FAKEAI_API_KEY",
        "FAKEAI_BASE_URL",
        "OPENROUTER_BASE_URL",
        "DIGITALOCEAN_INFERENCE_BASE_URL",
        "XAI_API_KEY",
        "XAI_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


def _fake_row():
    return json.loads(FIXTURE.read_text())


class TestBothProvidersUseTheSharedClass:
    def test_openrouter_and_digitalocean_are_the_shared_class(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        openrouter = get_provider("openai/gpt-4o")
        digitalocean = get_provider("digitalocean/llama3.3-70b-instruct")
        assert openrouter.key == "openrouter"
        assert digitalocean.key == "digitalocean"
        assert isinstance(openrouter.impl, OpenAICompatibleProvider)
        assert isinstance(digitalocean.impl, OpenAICompatibleProvider)
        openai = get_provider("openai-api/gpt-4o")
        assert openai.key == "openai-api"
        assert isinstance(openai.impl, OpenAICompatibleProvider)
        assert openai.impl.rewrite_model is None
        xai = get_provider("xai/grok-4.7")
        assert xai.key == "xai"
        assert isinstance(xai.impl, OpenAICompatibleProvider)
        assert xai.impl.rewrite_model is None
        assert openrouter.impl.rewrite_model is rewrite_openrouter_model
        assert digitalocean.impl.rewrite_model is None

    def test_openrouter_style_ids_stay_on_openrouter(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        for model in (
            "openai/gpt-4o",
            "anthropic/claude-sonnet-4.6",
            "google/gemini-2.5-pro",
            "x-ai/grok-2",
            "openrouter/minimax/minimax-m2.5",
            "claude-sonnet-4",
            "claude-haiku-latest",
            None,
        ):
            assert get_provider(model).key == "openrouter", model

    def test_catalog_keeps_model_list_fields(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        from cast.providers.registry import catalog_entries

        payload = {item["key"]: item for item in catalog_entries()}
        assert payload["openrouter"]["envVar"] == "OPENROUTER_API_KEY"
        assert payload["openrouter"]["prefixes"] == ["openrouter/"]
        assert "modelsPath" not in payload["openrouter"]
        assert payload["digitalocean"]["envVar"] == "DIGITALOCEAN_MODEL_ACCESS_KEY"
        assert payload["digitalocean"]["modelsPath"] == "/models"
        assert payload["digitalocean"]["fallbackModels"] == ["llama3.3-70b-instruct", "deepseek-v3.2"]
        assert payload["xai"]["envVar"] == "XAI_API_KEY"
        assert payload["xai"]["prefixes"] == ["xai/"]
        assert payload["xai"]["baseUrl"] == "https://api.x.ai/v1"
        assert payload["xai"]["baseUrlEnv"] == "XAI_BASE_URL"
        assert payload["xai"]["modelsPath"] == "/models"
        assert payload["xai"]["defaultModel"] == "xai/grok-4.7"
        assert payload["xai"]["fallbackModels"] == [
            "grok-4.7",
            "grok-4.20-0309-non-reasoning",
            "grok-4.20-0309-reasoning",
        ]
        assert payload["xai"]["modelsFilter"]
        assert payload["openai-api"]["envVar"] == "OPENAI_API_KEY"
        assert payload["openai-api"]["baseUrl"] == "https://api.openai.com/v1"
        assert "baseUrlEnv" not in payload["openai-api"]
        assert payload["openai-api"]["modelsPath"] == "/models"
        assert payload["openai-api"]["fallbackModels"] == ["gpt-4o", "gpt-4o-mini"]
        assert payload["openai-api"]["defaultModel"] == "openai-api/gpt-4o"
        assert payload["openai-api"]["modelsFilter"]
        assert "fakeai" not in payload
        for item in payload.values():
            assert "knownModels" not in item

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_openrouter_create_llm_still_rewrites_aliases(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        get_provider("claude-sonnet-4").create_llm("claude-sonnet-4")
        assert mock_chat.call_args.kwargs["model"] == "anthropic/claude-sonnet-4.6"
        get_provider("claude-haiku-latest").create_llm("claude-haiku-latest")
        assert mock_chat.call_args.kwargs["model"] == "anthropic/claude-haiku-latest"
        assert mock_chat.call_args.kwargs["api_key"] == "or-key"
        assert mock_chat.call_args.kwargs["base_url"] == "https://openrouter.ai/api/v1"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_digitalocean_create_llm_strips_prefix_and_keeps_the_id(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("DIGITALOCEAN_MODEL_ACCESS_KEY", "do-key")
        get_provider("digitalocean/llama-3.3-70b").create_llm("digitalocean/llama-3.3-70b")
        assert mock_chat.call_args.kwargs["model"] == "llama-3.3-70b"
        assert mock_chat.call_args.kwargs["model"] != MODEL_ALIASES["llama-3.3-70b"]
        assert mock_chat.call_args.kwargs["api_key"] == "do-key"
        assert mock_chat.call_args.kwargs["base_url"] == "https://inference.do-ai.run/v1"


class TestPrefixErrors:
    def test_reserved_direct_prefixes_do_not_fall_through(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        cases = {
            "anthropic-api/claude-sonnet-4.6": "anthropic-api/",
            "gemini/gemini-2.5-flash": "gemini/",
            "bedrock/us.anthropic.claude": "bedrock/",
            "ollama/qwen3": "ollama/",
        }
        for model, prefix in cases.items():
            with pytest.raises(InferenceProviderError) as exc:
                get_provider(model)
            message = str(exc.value)
            assert prefix in message
            assert "not registered yet" in message

    def test_openai_api_does_not_steal_openrouter_vendor_ids(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        assert get_provider("openai-api/gpt-4o").key == "openai-api"
        assert get_provider("openai/gpt-4o").key == "openrouter"

    def test_xai_prefix_does_not_steal_the_openrouter_vendor(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        assert get_provider("x-ai/grok-2").key == "openrouter"
        assert get_provider("xai/grok-4.7").key == "xai"

    def test_unlisted_vendor_prefixes_stay_on_openrouter(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        for model in (
            "qwen/qwen3-coder",
            "z-ai/glm-4.6",
            "moonshotai/kimi-k2",
            "nope/model",
            "~anthropic/claude-sonnet-latest",
        ):
            assert get_provider(model).key == "openrouter", model

    def test_missing_prefix_names_direct_prefixes(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        with pytest.raises(InferenceProviderError) as exc:
            get_provider("gpt-5")
        message = str(exc.value)
        assert "no provider prefix" in message
        assert "openai-api/" in message
        assert "xai/" in message
        assert "claude-sonnet-4" in message

    def test_external_cannot_take_a_reserved_prefix(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = home / ".cast" / "inference-providers" / "ollama"
        folder.mkdir(parents=True)
        (folder / "provider.json").write_text(json.dumps({
            "key": "ollama",
            "name": "Ollama",
            "prefixes": ["ollama/"],
            "envVar": "OLLAMA_API_KEY",
            "configKey": "providers.ollama.api_key",
            "baseUrl": "http://localhost:11434/v1",
            "acceptsAnyModel": True,
        }))
        (folder / "provider.py").write_text(
            "class P:\n"
            "    key = 'ollama'\n"
            "    prefixes = ('ollama/',)\n"
            "    env_var = 'OLLAMA_API_KEY'\n"
            "    def is_available(self):\n"
            "        return False\n"
            "    def create_llm(self, model=None, **kwargs):\n"
            "        return model\n"
            "provider = P()\n"
        )
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        assert "reserved" in str(exc.value)
        assert "ollama/" in str(exc.value)

    def test_external_cannot_reclaim_xai(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = home / ".cast" / "inference-providers" / "xai"
        folder.mkdir(parents=True)
        (folder / "provider.json").write_text(json.dumps({
            "key": "xai",
            "name": "xAI",
            "prefixes": ["xai/"],
            "envVar": "XAI_API_KEY",
            "configKey": "providers.xai.api_key",
            "baseUrl": "https://api.x.ai/v1",
            "acceptsAnyModel": True,
        }))
        (folder / "provider.py").write_text(
            "class P:\n"
            "    key = 'xai'\n"
            "    prefixes = ('xai/',)\n"
            "    env_var = 'XAI_API_KEY'\n"
            "    def is_available(self):\n"
            "        return False\n"
            "    def create_llm(self, model=None, **kwargs):\n"
            "        return model\n"
            "provider = P()\n"
        )
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        assert "xai" in str(exc.value)
        assert "built-in xai" in str(exc.value)

    def test_external_cannot_reclaim_openai_api(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = home / ".cast" / "inference-providers" / "openai-api"
        folder.mkdir(parents=True)
        (folder / "provider.json").write_text(json.dumps({
            "key": "openai-api",
            "name": "OpenAI",
            "prefixes": ["openai-api/"],
            "envVar": "OPENAI_API_KEY",
            "configKey": "providers.openai.api_key",
            "baseUrl": "https://api.openai.com/v1",
            "acceptsAnyModel": True,
        }))
        (folder / "provider.py").write_text(
            "class P:\n"
            "    key = 'openai-api'\n"
            "    prefixes = ('openai-api/',)\n"
            "    env_var = 'OPENAI_API_KEY'\n"
            "    def is_available(self):\n"
            "        return False\n"
            "    def create_llm(self, model=None, **kwargs):\n"
            "        return model\n"
            "provider = P()\n"
        )
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        assert "openai-api" in str(exc.value)
        assert "built-in openai-api" in str(exc.value)


class TestSamplingParams:
    def test_builder_has_no_hardcoded_temperature(self):
        text = (PYTHON / "cast" / "builder.py").read_text()
        assert "temperature=0.7" not in text
        assert "temperature = 0.7" not in text

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_openrouter_builder_still_sends_temperature(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        config = {"defaults": {"builder_model": "anthropic/claude-sonnet-4.6"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["temperature"] == 0.7
        assert mock_chat.call_args.kwargs["model"] == "anthropic/claude-sonnet-4.6"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_digitalocean_builder_still_sends_temperature(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("DIGITALOCEAN_MODEL_ACCESS_KEY", "do-key")
        config = {"defaults": {"builder_model": "digitalocean/llama3.3-70b-instruct"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["temperature"] == 0.7
        assert mock_chat.call_args.kwargs["model"] == "llama3.3-70b-instruct"

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_reasoning_model_omits_temperature(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        config = {"defaults": {"builder_model": "openrouter/openai/o3"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert "temperature" not in mock_chat.call_args.kwargs
        assert mock_chat.call_args.kwargs["model"] == "openai/o3"

class TestXaiProvider:
    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_create_llm_strips_the_prefix_and_sends_temperature(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("XAI_API_KEY", "xai-key")
        provider = get_provider("xai/grok-4.7")
        assert isinstance(provider.impl, OpenAICompatibleProvider)
        assert provider.impl.rewrite_model is None
        provider.create_llm("xai/grok-4.7", **provider.llm_params("xai/grok-4.7"))
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "grok-4.7"
        assert kwargs["api_key"] == "xai-key"
        assert kwargs["base_url"] == "https://api.x.ai/v1"
        assert kwargs["temperature"] == 0.7
        for blocked in ("stop", "presence_penalty", "frequency_penalty", "reasoning_effort"):
            assert blocked not in kwargs

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_builder_sends_temperature_for_a_reasoning_model(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("XAI_API_KEY", "xai-key")
        config = {"defaults": {"builder_model": "xai/grok-4.20-0309-reasoning"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "grok-4.20-0309-reasoning"
        assert mock_chat.call_args.kwargs["temperature"] == 0.7
        assert mock_chat.call_args.kwargs["api_key"] == "xai-key"
        assert mock_chat.call_args.kwargs["base_url"] == "https://api.x.ai/v1"

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_base_url_env_overrides_the_manifest(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("XAI_API_KEY", "xai-key")
        monkeypatch.setenv("XAI_BASE_URL", "https://xai.example/v1")
        get_provider("xai/grok-4").create_llm("xai/grok-4")
        assert mock_chat.call_args.kwargs["model"] == "grok-4"
        assert mock_chat.call_args.kwargs["base_url"] == "https://xai.example/v1"

    def test_missing_key_names_xai(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        provider = get_provider("xai/grok-4.7")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="XAI_API_KEY"):
            provider.create_llm("xai/grok-4.7")

    def test_model_filter_keeps_chat_ids(self, monkeypatch, tmp_path):
        import re

        from cast.providers.registry import catalog_entries

        _home(monkeypatch, tmp_path)
        pattern = re.compile(next(item["modelsFilter"] for item in catalog_entries() if item["key"] == "xai"))
        kept = [
            "grok-4.7",
            "grok-4.20-0309-reasoning",
            "grok-4.20-0309-non-reasoning",
            "grok-build-0.1",
            "grok-2-vision-1212",
        ]
        dropped = [
            "latest",
            "grok-4.3-latest",
            "grok-4.20-multi-agent-0309",
            "grok-4.20-multi-agent",
            "grok-imagine-image",
            "grok-imagine-image-2.0",
            "grok-imagine-video",
            "grok-2-image-1212",
            "grok-voice-3.0",
            "embedding-model",
        ]
        assert [model for model in kept if pattern.search(model)] == kept
        assert [model for model in dropped if pattern.search(model)] == []


class TestOpenAIDirect:
    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_create_llm_strips_the_prefix_and_ignores_openai_base_url(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example/v1")
        provider = get_provider("openai-api/gpt-4o")
        provider.create_llm("openai-api/gpt-4o", **provider.llm_params("openai-api/gpt-4o"))
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "gpt-4o"
        assert kwargs["api_key"] == "sk-test-openai"
        assert kwargs["base_url"] == "https://api.openai.com/v1"
        assert kwargs["temperature"] == 0.7
        assert "https://proxy.example" not in str(kwargs)

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_reasoning_models_omit_temperature(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        for model_id, sent in (
            ("openai-api/o3", "o3"),
            ("openai-api/o1-mini", "o1-mini"),
            ("openai-api/gpt-5", "gpt-5"),
            ("openai-api/gpt-5-mini", "gpt-5-mini"),
        ):
            mock_chat.reset_mock()
            provider = get_provider(model_id)
            provider.create_llm(model_id, **provider.llm_params(model_id))
            kwargs = mock_chat.call_args.kwargs
            assert kwargs["model"] == sent
            assert "temperature" not in kwargs
            assert kwargs["base_url"] == "https://api.openai.com/v1"

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_builder_sends_temperature_for_gpt_4o(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        config = {"defaults": {"builder_model": "openai-api/gpt-4o"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "gpt-4o"
        assert mock_chat.call_args.kwargs["temperature"] == 0.7
        assert mock_chat.call_args.kwargs["base_url"] == "https://api.openai.com/v1"

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_builder_omits_temperature_for_a_reasoning_model(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        config = {"defaults": {"builder_model": "openai-api/o3"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "o3"
        assert "temperature" not in mock_chat.call_args.kwargs

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_config_base_url_is_builder_only(self, mock_chat, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example/v1")
        token = home / ".cast" / "tokens" / "inference" / "openai-api.token"
        token.parent.mkdir(parents=True)
        token.write_text("file-secret\n")
        (home / ".cast" / "config.yaml").write_text(
            "providers:\n  openai:\n    base_url: https://from-config.example/v1\n"
        )
        provider = get_provider("openai-api/gpt-4o")
        provider.create_llm("openai-api/gpt-4o")
        assert mock_chat.call_args.kwargs["api_key"] == "file-secret"
        assert mock_chat.call_args.kwargs["base_url"] == "https://from-config.example/v1"

    def test_missing_key_names_openai_api_key(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        provider = get_provider("openai-api/gpt-4o")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="OPENAI_API_KEY") as exc:
            provider.create_llm("openai-api/gpt-4o")
        assert "https://platform.openai.com/api-keys" in str(exc.value)

    def test_models_filter_keeps_chat_ids(self, monkeypatch, tmp_path):
        import re

        _home(monkeypatch, tmp_path)
        pattern = get_provider("openai-api/gpt-4o").models_filter
        compiled = re.compile(pattern)
        kept = [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "gpt-3.5-turbo",
            "gpt-5",
            "o3",
            "o1-mini",
            "o4-mini",
            "chatgpt-4o-latest",
            "gpt-5-chat-latest",
            "ft:gpt-4o:org:name:id",
        ]
        dropped = [
            "text-embedding-3-small",
            "tts-1",
            "gpt-4o-mini-tts",
            "whisper-1",
            "dall-e-3",
            "gpt-image-1",
            "gpt-4o-realtime-preview",
            "gpt-4o-audio-preview",
            "gpt-4o-transcribe",
            "omni-moderation-latest",
            "babbage-002",
            "o1-pro",
            "o3-pro",
            "gpt-5-pro",
            "o3-deep-research",
            "o4-mini-deep-research",
            "gpt-5-codex",
            "gpt-5.1-codex",
            "gpt-3.5-turbo-instruct",
            "gpt-4o-search-preview",
            "gpt-4o-mini-search-preview",
        ]
        for model_id in kept:
            assert compiled.search(model_id), model_id
        for model_id in dropped:
            assert compiled.search(model_id) is None, model_id


class TestFakeProviderRow:
    def test_row_works_end_to_end_without_a_module(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        monkeypatch.setenv("FAKEAI_API_KEY", "fake-key")
        monkeypatch.setenv("FAKEAI_BASE_URL", "https://override.example/v1")
        row = _fake_row()
        registry = load_registry()
        assert "fakeai" not in registry.by_key
        register_compatible_row(registry, row)
        provider = select_provider("fakeai/chat-large", registry)
        assert provider.key == "fakeai"
        assert isinstance(provider.impl, OpenAICompatibleProvider)
        with patch("cast.providers.openai_compatible.ChatOpenAI") as mock_chat:
            provider.create_llm("fakeai/chat-large", **provider.llm_params("fakeai/chat-large"))
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "chat-large"
        assert kwargs["api_key"] == "fake-key"
        assert kwargs["base_url"] == "https://override.example/v1"
        assert kwargs["temperature"] == 0.7

        with patch("cast.providers.openai_compatible.ChatOpenAI") as mock_chat:
            provider.create_llm("fakeai/reason-1", **provider.llm_params("fakeai/reason-1"))
        assert mock_chat.call_args.kwargs["model"] == "reason-1"
        assert "temperature" not in mock_chat.call_args.kwargs

        monkeypatch.delenv("FAKEAI_API_KEY", raising=False)
        monkeypatch.delenv("FAKEAI_BASE_URL", raising=False)
        token = home / ".cast" / "tokens" / "inference" / "fakeai.token"
        token.parent.mkdir(parents=True)
        token.write_text("file-secret\n")
        (home / ".cast" / "config.yaml").write_text(
            "providers:\n  fakeai:\n    base_url: https://from-config.example/v1\n"
        )
        with patch("cast.providers.openai_compatible.ChatOpenAI") as mock_chat:
            provider.create_llm("fakeai/chat-small")
        assert mock_chat.call_args.kwargs["api_key"] == "file-secret"
        assert mock_chat.call_args.kwargs["base_url"] == "https://from-config.example/v1"

        token.unlink()
        with pytest.raises(ValueError, match="FAKEAI_API_KEY") as exc:
            provider.create_llm("fakeai/chat-small")
        assert "Fake AI" in str(exc.value)

    def test_autoload_registers_a_compatible_row(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        row = _fake_row()
        import sys

        registry_module = sys.modules["cast.providers.registry"]
        real = dict(registry_module._manifest_by_key())
        real[row["key"]] = row

        def rows():
            return real

        monkeypatch.setattr(registry_module, "_manifest_by_key", rows)
        loaded = load_registry()
        assert isinstance(loaded.by_key["fakeai"].impl, OpenAICompatibleProvider)
        assert select_provider("fakeai/chat-small", loaded).key == "fakeai"

    def test_keyless_row_needs_no_token(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        row = _fake_row()
        row["key"] = "fakelocal"
        row["prefixes"] = ["fakelocal/"]
        row["keyless"] = True
        row["envVar"] = ""
        registry = load_registry()
        provider = register_compatible_row(registry, row)
        assert provider.is_available() is True
        with patch("cast.providers.openai_compatible.ChatOpenAI") as mock_chat:
            provider.create_llm("fakelocal/chat-small")
        assert mock_chat.call_args.kwargs["api_key"] == "ollama"
        assert mock_chat.call_args.kwargs["model"] == "chat-small"

    def test_bare_alias_file_matches_the_rewrite_table(self):
        aliases = json.loads((ROOT / "python" / "cast" / "providers" / "bare-aliases.json").read_text())
        assert set(aliases) == set(MODEL_ALIASES)
