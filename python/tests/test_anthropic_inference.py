"""Direct Anthropic is a manifest row plus a native ChatAnthropic module."""

import sys
from unittest.mock import patch

import pytest

from cast.providers.anthropic import sdk_base_url
from cast.providers.openai_compatible import OpenAICompatibleProvider
from cast.providers.registry import catalog_entries, get_provider


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "OPENROUTER_API_KEY",
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
        "GEMINI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_URL",
        "OPENROUTER_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


class TestAnthropicRow:
    def test_registers_from_the_manifest(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        provider = get_provider("anthropic-api/claude-sonnet-5-5")
        assert provider.key == "anthropic-api"
        assert provider.source == "built-in anthropic-api"
        assert isinstance(provider.impl, OpenAICompatibleProvider)
        assert provider.impl.rewrite_model is None
        assert provider.impl.chat_factory is not None
        assert provider.impl.chat_base_url is sdk_base_url
        assert provider.prefixes == ("anthropic-api/",)
        assert provider.env_var == "ANTHROPIC_API_KEY"
        assert provider.config_key == "providers.anthropic.api_key"
        assert provider.base_url == "https://api.anthropic.com/v1"
        assert provider.base_url_env == "ANTHROPIC_BASE_URL"
        assert provider.accepts_any_model is True
        assert provider.models_path == "/models?limit=1000"
        assert provider.models_filter == "^claude-"
        assert provider.models_headers["x-api-key"] == "${token}"
        assert provider.models_headers["anthropic-version"] == "2023-06-01"
        assert provider.fallback_models == (
            "claude-sonnet-5-5",
            "claude-opus-5-5",
            "claude-haiku-5-5",
        )
        assert provider.default_model == "anthropic-api/claude-sonnet-5-5"
        assert provider.impl.resolve_model_id("anthropic-api/claude-sonnet-5-5") == "claude-sonnet-5-5"
        assert provider.impl.resolve_model_id("anthropic-api/claude-sonnet-4") == "claude-sonnet-4"
        assert "temperature" not in provider.llm_params("anthropic-api/claude-sonnet-5-5")
        assert "temperature" not in provider.llm_params("anthropic-api/claude-opus-4-7")
        assert "temperature" not in provider.llm_params("anthropic-api/claude-fable-5-1")
        assert provider.llm_params("anthropic-api/claude-sonnet-4-6")["temperature"] == 0.7
        assert provider.llm_params("anthropic-api/claude-haiku-4-5-20251001")["temperature"] == 0.7

    def test_sdk_base_url_strips_only_a_trailing_v1(self):
        assert sdk_base_url("https://api.anthropic.com/v1") == "https://api.anthropic.com"
        assert sdk_base_url("https://api.anthropic.com/v1/") == "https://api.anthropic.com"
        assert sdk_base_url("http://127.0.0.1:9/v1") == "http://127.0.0.1:9"
        assert sdk_base_url("https://gateway.example") == "https://gateway.example"
        assert sdk_base_url("https://gateway.example/myv1") == "https://gateway.example/myv1"

    def test_openrouter_vendor_ids_stay_on_openrouter(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        openrouter = get_provider("anthropic/claude-sonnet-4.6")
        assert openrouter.key == "openrouter"
        assert openrouter.impl.resolve_model_id("anthropic/claude-sonnet-4.6") == "anthropic/claude-sonnet-4.6"
        assert openrouter.llm_params("anthropic/claude-sonnet-4.6")["temperature"] == 0.7
        bare = get_provider("claude-sonnet-4")
        assert bare.key == "openrouter"
        assert bare.impl.resolve_model_id("claude-sonnet-4") == "anthropic/claude-sonnet-4.6"
        prefixed = get_provider("openrouter/anthropic/claude-sonnet-4.6")
        assert prefixed.key == "openrouter"

    def test_catalog_exposes_list_headers_and_not_the_key(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        payload = {item["key"]: item for item in catalog_entries()}
        row = payload["anthropic-api"]
        assert row["envVar"] == "ANTHROPIC_API_KEY"
        assert row["baseUrl"] == "https://api.anthropic.com/v1"
        assert row["baseUrlEnv"] == "ANTHROPIC_BASE_URL"
        assert row["modelsPath"] == "/models?limit=1000"
        assert row["modelsFilter"] == "^claude-"
        assert row["modelsHeaders"] == {
            "x-api-key": "${token}",
            "anthropic-version": "2023-06-01",
        }
        assert "Authorization" not in row["modelsHeaders"]
        assert row["fallbackModels"] == [
            "claude-sonnet-5-5",
            "claude-opus-5-5",
            "claude-haiku-5-5",
        ]
        assert row["defaultModel"] == "anthropic-api/claude-sonnet-5-5"
        assert "knownModels" not in row
        assert "api_key" not in row

    @patch("cast.providers.anthropic.load_chat_cls")
    def test_create_llm_uses_chat_anthropic_and_omits_temperature_for_5_5(self, mock_loader, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        mock_chat = mock_loader.return_value
        config = {"defaults": {"builder_model": "anthropic-api/claude-sonnet-5-5"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-5-5"
        assert kwargs["api_key"] == "sk-ant-test"
        assert kwargs["base_url"] == "https://api.anthropic.com"
        assert "temperature" not in kwargs
        assert "max_tokens" not in kwargs

        config["defaults"]["builder_model"] = "anthropic-api/claude-sonnet-4-6"
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "claude-sonnet-4-6"
        assert mock_chat.call_args.kwargs["temperature"] == 0.7
        assert mock_chat.call_args.kwargs["base_url"] == "https://api.anthropic.com"

    @patch("cast.providers.anthropic.load_chat_cls")
    def test_base_url_override_strips_v1_and_stays_on_the_builder(self, mock_loader, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://anthropic.example/v1")
        get_provider("anthropic-api/claude-sonnet-5-5").create_llm("anthropic-api/claude-sonnet-5-5")
        assert mock_loader.return_value.call_args.kwargs["base_url"] == "https://anthropic.example"
        assert mock_loader.return_value.call_args.kwargs["api_key"] == "sk-ant-test"

    def test_missing_key_names_anthropic_and_not_another_provider(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        provider = get_provider("anthropic-api/claude-sonnet-5-5")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY") as exc:
            provider.create_llm("anthropic-api/claude-sonnet-5-5")
        message = str(exc.value)
        assert "Anthropic" in message
        assert "OPENROUTER_API_KEY" not in message
        assert "or-key" not in message

    def test_missing_package_names_the_install_and_does_not_break_routing(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        provider = get_provider("anthropic-api/claude-sonnet-5-5")
        assert provider.key == "anthropic-api"
        hidden = sys.modules.get("langchain_anthropic")
        sys.modules["langchain_anthropic"] = None
        try:
            with pytest.raises(ImportError, match="langchain-anthropic") as exc:
                provider.create_llm("anthropic-api/claude-sonnet-5-5")
        finally:
            if hidden is None:
                sys.modules.pop("langchain_anthropic", None)
            else:
                sys.modules["langchain_anthropic"] = hidden
        assert "sk-ant-test" not in str(exc.value)
        assert "pip install" in str(exc.value)
