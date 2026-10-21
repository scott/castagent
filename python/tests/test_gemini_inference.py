"""Google Gemini is a manifest row on the shared OpenAI-compatible class."""

from unittest.mock import patch

import pytest

from cast.providers.openai_compatible import OpenAICompatibleProvider
from cast.providers.registry import catalog_entries, get_provider


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "OPENROUTER_API_KEY",
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "GEMINI_API_KEY",
        "GEMINI_BASE_URL",
        "OPENROUTER_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


class TestGeminiRow:
    def test_registers_from_the_manifest_without_a_module(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        provider = get_provider("gemini/gemini-3.8-flash")
        assert provider.key == "gemini"
        assert provider.source == "built-in gemini"
        assert isinstance(provider.impl, OpenAICompatibleProvider)
        assert provider.impl.rewrite_model is None
        assert provider.prefixes == ("gemini/",)
        assert provider.env_var == "GEMINI_API_KEY"
        assert provider.config_key == "providers.gemini.api_key"
        assert provider.base_url == "https://generativelanguage.googleapis.com/v1beta/openai"
        assert provider.base_url_env == "GEMINI_BASE_URL"
        assert provider.accepts_any_model is True
        assert provider.models_path == "/models"
        assert provider.strip_model_id_prefix == "models/"
        assert provider.fallback_models == ("gemini-3.8-flash", "gemini-3.1-pro-preview")
        assert provider.default_model == "gemini/gemini-3.8-flash"
        assert provider.default_params == {}
        assert provider.impl.resolve_model_id("gemini/gemini-3.8-flash") == "gemini-3.8-flash"
        assert provider.impl.resolve_model_id("gemini/gemini-3.1-pro-preview") == "gemini-3.1-pro-preview"
        assert "temperature" not in provider.llm_params("gemini/gemini-3.8-flash")
        assert "temperature" not in provider.llm_params("gemini/gemini-3.1-pro-preview")

    def test_google_vendor_ids_stay_on_openrouter(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        openrouter = get_provider("google/gemini-2.5-pro")
        assert openrouter.key == "openrouter"
        assert openrouter.impl.resolve_model_id("google/gemini-2.5-pro") == "google/gemini-2.5-pro"
        assert openrouter.llm_params("google/gemini-2.5-pro")["temperature"] == 0.7
        bare = get_provider("gemini-2.5-pro")
        assert bare.key == "openrouter"
        assert bare.impl.resolve_model_id("gemini-2.5-pro") == "google/gemini-2.5-pro"

    def test_catalog_exposes_list_fields_and_not_the_key(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        payload = {item["key"]: item for item in catalog_entries()}
        row = payload["gemini"]
        assert row["envVar"] == "GEMINI_API_KEY"
        assert row["baseUrlEnv"] == "GEMINI_BASE_URL"
        assert row["modelsPath"] == "/models"
        assert row["stripModelIdPrefix"] == "models/"
        assert row["modelsFilter"].startswith("^gemini")
        assert row["fallbackModels"] == ["gemini-3.8-flash", "gemini-3.1-pro-preview"]
        assert row["defaultModel"] == "gemini/gemini-3.8-flash"
        assert "knownModels" not in row
        assert "api_key" not in row

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_create_llm_uses_the_compat_endpoint_and_omits_temperature(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
        config = {"defaults": {"builder_model": "gemini/gemini-3.8-flash"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "gemini-3.8-flash"
        assert kwargs["api_key"] == "gemini-test-key"
        assert kwargs["base_url"] == "https://generativelanguage.googleapis.com/v1beta/openai"
        assert "temperature" not in kwargs

        config["defaults"]["builder_model"] = "gemini/gemini-3.1-pro-preview"
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "gemini-3.1-pro-preview"
        assert "temperature" not in mock_chat.call_args.kwargs

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_base_url_override_stays_on_the_builder(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
        monkeypatch.setenv("GEMINI_BASE_URL", "https://gemini.example/v1beta/openai")
        get_provider("gemini/gemini-3.8-flash").create_llm("gemini/gemini-3.8-flash")
        assert mock_chat.call_args.kwargs["base_url"] == "https://gemini.example/v1beta/openai"
        assert mock_chat.call_args.kwargs["api_key"] == "gemini-test-key"

    def test_missing_key_names_gemini_and_not_another_provider(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        provider = get_provider("gemini/gemini-3.8-flash")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="GEMINI_API_KEY") as exc:
            provider.create_llm("gemini/gemini-3.8-flash")
        message = str(exc.value)
        assert "Google Gemini" in message
        assert "OPENROUTER_API_KEY" not in message
        assert "or-key" not in message
