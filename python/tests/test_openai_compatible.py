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
        "FAKEAI_API_KEY",
        "FAKEAI_BASE_URL",
        "OPENROUTER_BASE_URL",
        "DIGITALOCEAN_INFERENCE_BASE_URL",
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
            "openai-api/gpt-4o": "openai-api/",
            "anthropic-api/claude-sonnet-4.6": "anthropic-api/",
            "gemini/gemini-2.5-flash": "gemini/",
            "bedrock/us.anthropic.claude": "bedrock/",
            "ollama/qwen3": "ollama/",
            "xai/grok-4": "xai/",
        }
        for model, prefix in cases.items():
            with pytest.raises(InferenceProviderError) as exc:
                get_provider(model)
            message = str(exc.value)
            assert prefix in message
            assert "not registered yet" in message

    def test_openai_api_hint_names_the_openrouter_id(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        with pytest.raises(InferenceProviderError) as exc:
            get_provider("openai-api/gpt-4o")
        assert "openai/gpt-4o still routes to OpenRouter" in str(exc.value)

    def test_xai_hint_names_the_openrouter_vendor(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        with pytest.raises(InferenceProviderError) as exc:
            get_provider("xai/grok-4")
        assert "x-ai/grok-4 still routes to OpenRouter" in str(exc.value)

    def test_unknown_prefix_names_registered_and_reserved(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        with pytest.raises(InferenceProviderError) as exc:
            get_provider("nope/model")
        message = str(exc.value)
        assert "Unknown provider prefix 'nope/'" in message
        assert "openrouter/" in message
        assert "digitalocean/" in message
        assert "gemini/" in message

    def test_missing_prefix_names_direct_prefixes(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        with pytest.raises(InferenceProviderError) as exc:
            get_provider("gpt-5")
        message = str(exc.value)
        assert "no provider prefix" in message
        assert "openai-api/" in message
        assert "claude-sonnet-4" in message

    def test_external_cannot_take_a_reserved_prefix(self, monkeypatch, tmp_path):
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
        assert "reserved" in str(exc.value)
        assert "openai-api/" in str(exc.value)


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

    def test_rejected_param_is_named(self, monkeypatch, tmp_path, capsys):
        from cast.builder import EchoChatModel, create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        config = {"defaults": {"builder_model": "openrouter/minimax/minimax-m2.5"}}

        def explode(*_args, **_kwargs):
            raise ValueError("unsupported temperature for this model")

        with patch("cast.builder.load_global_config", return_value=config):
            with patch("cast.providers.openrouter.ChatOpenAI", side_effect=explode):
                llm = create_llm()
        assert isinstance(llm, EchoChatModel)
        err = capsys.readouterr().err
        assert "Rejected param: temperature" in err
        assert "openrouter/minimax/minimax-m2.5" in err


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
