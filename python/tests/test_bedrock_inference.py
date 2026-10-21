"""Amazon Bedrock API-key provider. No live AWS calls."""

import json
from unittest.mock import patch

import pytest

from cast.providers.openai_compatible import OpenAICompatibleProvider
from cast.providers.registry import (
    InferenceProviderError,
    catalog_entries,
    get_provider,
    load_registry,
    register_compatible_row,
)


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "OPENROUTER_API_KEY",
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "BEDROCK_BASE_URL",
        "BEDROCK_REGION",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AZUREISH_API_KEY",
        "AZUREISH_REGION",
        "CAST_BUILDER_ECHO",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


class TestBedrockRow:
    def test_registers_from_the_manifest_without_a_module(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        provider = get_provider("bedrock/global.anthropic.claude-sonnet-4-6")
        assert provider.key == "bedrock"
        assert provider.source == "built-in bedrock"
        assert isinstance(provider.impl, OpenAICompatibleProvider)
        assert provider.impl.rewrite_model is None
        from langchain_openai import ChatOpenAI
        assert provider.impl.chat_factory() is ChatOpenAI
        assert provider.prefixes == ("bedrock/",)
        assert provider.env_var == "AWS_BEARER_TOKEN_BEDROCK"
        assert provider.config_key == "providers.bedrock.api_key"
        assert provider.base_url == "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
        assert provider.base_url_env == "BEDROCK_BASE_URL"
        assert provider.base_url_template == (
            "https://bedrock-runtime.{region}.amazonaws.com/openai/v1"
        )
        assert provider.region_default == "us-east-1"
        assert provider.accepts_any_model is True
        assert provider.curated_models is True
        assert provider.models_path == ""
        assert provider.known_models == (
            "global.anthropic.claude-sonnet-4-6",
            "global.anthropic.claude-haiku-5-5",
            "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        )
        assert provider.default_model == "bedrock/global.anthropic.claude-sonnet-4-6"
        assert provider.settings == (
            {"env": "BEDROCK_REGION", "configKey": "providers.bedrock.region"},
        )
        assert provider.impl.resolve_model_id(
            "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
        ) == "global.anthropic.claude-haiku-4-5-20251001-v1:0"
        assert provider.impl.resolve_model_id(
            "bedrock/us.anthropic.claude-sonnet-4-6"
        ) == "us.anthropic.claude-sonnet-4-6"
        assert provider.llm_params("bedrock/global.anthropic.claude-sonnet-4-6")["temperature"] == 0.7

    def test_catalog_forwards_region_settings_and_hides_known_models(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        payload = {item["key"]: item for item in catalog_entries()}
        row = payload["bedrock"]
        assert row["envVar"] == "AWS_BEARER_TOKEN_BEDROCK"
        assert row["baseUrlEnv"] == "BEDROCK_BASE_URL"
        assert row["baseUrlTemplate"] == "https://bedrock-runtime.{region}.amazonaws.com/openai/v1"
        assert row["regionDefault"] == "us-east-1"
        assert row["regionPattern"] == "^[a-z]{2}(?:-[a-z0-9]+)+$"
        assert row["curatedModels"] is True
        assert "modelsPath" not in row
        assert row["settings"] == [
            {"env": "BEDROCK_REGION", "configKey": "providers.bedrock.region"},
        ]
        assert "Long-term Bedrock API keys are for exploration" in row["enableNote"]
        assert "knownModels" not in row

    def test_amazon_openrouter_ids_stay_on_openrouter(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        assert get_provider("amazon/nova-pro-v1").key == "openrouter"

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_region_fills_the_runtime_url(self, mock_chat, monkeypatch, tmp_path):
        from cast.builder import create_llm

        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
        monkeypatch.setenv("BEDROCK_REGION", "eu-west-1")
        monkeypatch.setenv("AWS_REGION", "us-west-2")
        provider = get_provider("bedrock/global.anthropic.claude-sonnet-4-6")
        provider.create_llm(
            "bedrock/global.anthropic.claude-sonnet-4-6",
            **provider.llm_params("bedrock/global.anthropic.claude-sonnet-4-6"),
        )
        kwargs = mock_chat.call_args.kwargs
        assert kwargs["model"] == "global.anthropic.claude-sonnet-4-6"
        assert kwargs["api_key"] == "bedrock-key"
        assert kwargs["base_url"] == "https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1"
        assert kwargs["temperature"] == 0.7
        assert "https://bedrock-runtime.us-east-1" not in kwargs["base_url"]

        mock_chat.reset_mock()
        config = {"defaults": {"builder_model": "bedrock/us.anthropic.claude-sonnet-4-6"}}
        with patch("cast.builder.load_global_config", return_value=config):
            create_llm()
        assert mock_chat.call_args.kwargs["model"] == "us.anthropic.claude-sonnet-4-6"
        assert mock_chat.call_args.kwargs["base_url"] == (
            "https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1"
        )
        assert mock_chat.call_args.kwargs["temperature"] == 0.7

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_config_region_is_used_when_the_env_is_unset(self, mock_chat, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
        (home / ".cast").mkdir()
        (home / ".cast" / "config.yaml").write_text(
            "providers:\n  bedrock:\n    region: ap-southeast-2\n"
        )
        get_provider("bedrock/global.anthropic.claude-sonnet-4-6").create_llm(
            "bedrock/global.anthropic.claude-sonnet-4-6"
        )
        assert mock_chat.call_args.kwargs["base_url"] == (
            "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1"
        )

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_default_region_is_us_east_1(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
        monkeypatch.setenv("AWS_REGION", "eu-central-1")
        get_provider("bedrock/global.anthropic.claude-sonnet-4-6").create_llm(
            "bedrock/global.anthropic.claude-sonnet-4-6"
        )
        assert mock_chat.call_args.kwargs["base_url"] == (
            "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
        )

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_base_url_override_stays_on_the_builder(self, mock_chat, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        token = home / ".cast" / "tokens" / "inference" / "bedrock.token"
        token.parent.mkdir(parents=True)
        token.write_text("file-secret\n")
        (home / ".cast" / "config.yaml").write_text(
            "providers:\n  bedrock:\n"
            "    region: eu-west-1\n"
            "    base_url: https://vpce-abc.example.invalid/openai/v1\n"
        )
        get_provider("bedrock/global.anthropic.claude-sonnet-4-6").create_llm(
            "bedrock/global.anthropic.claude-sonnet-4-6"
        )
        assert mock_chat.call_args.kwargs["api_key"] == "file-secret"
        assert mock_chat.call_args.kwargs["base_url"] == "https://vpce-abc.example.invalid/openai/v1"

    def test_missing_key_names_the_bedrock_token(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        provider = get_provider("bedrock/global.anthropic.claude-sonnet-4-6")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="AWS_BEARER_TOKEN_BEDROCK"):
            provider.create_llm("bedrock/global.anthropic.claude-sonnet-4-6")

    def test_invalid_region_is_rejected(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
        monkeypatch.setenv("BEDROCK_REGION", "not-a-region")
        provider = get_provider("bedrock/global.anthropic.claude-sonnet-4-6")
        with pytest.raises(ValueError, match="us-east-1"):
            provider.create_llm("bedrock/global.anthropic.claude-sonnet-4-6")
        monkeypatch.setenv("BEDROCK_REGION", "eu-west-1.evil.example")
        with pytest.raises(ValueError, match="hostname label"):
            provider.create_llm("bedrock/global.anthropic.claude-sonnet-4-6")

    def test_external_cannot_reclaim_bedrock(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = home / ".cast" / "inference-providers" / "bedrock"
        folder.mkdir(parents=True)
        (folder / "provider.json").write_text(json.dumps({
            "key": "bedrock",
            "name": "Amazon Bedrock",
            "prefixes": ["bedrock/"],
            "envVar": "AWS_BEARER_TOKEN_BEDROCK",
            "configKey": "providers.bedrock.api_key",
            "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
            "acceptsAnyModel": True,
        }))
        (folder / "provider.py").write_text(
            "class P:\n"
            "    key = 'bedrock'\n"
            "    prefixes = ('bedrock/',)\n"
            "    env_var = 'AWS_BEARER_TOKEN_BEDROCK'\n"
            "    def is_available(self):\n"
            "        return False\n"
            "    def create_llm(self, model=None, **kwargs):\n"
            "        return model\n"
            "provider = P()\n"
        )
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        assert "bedrock" in str(exc.value)
        assert "built-in bedrock" in str(exc.value)

    @patch("cast.providers.openai_compatible.ChatOpenAI")
    def test_another_row_can_fill_its_own_region_template(self, mock_chat, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)
        monkeypatch.setenv("AZUREISH_API_KEY", "azure-key")
        monkeypatch.setenv("AZUREISH_REGION", "westus")
        row = {
            "key": "azureish",
            "impl": "openai-compatible",
            "name": "Azure-shaped",
            "displayName": "Azure-shaped",
            "prefixes": ["azureish/"],
            "default": False,
            "envVar": "AZUREISH_API_KEY",
            "configKey": "providers.azureish.api_key",
            "baseUrl": "https://eastus.example.invalid/openai/v1",
            "baseUrlTemplate": "https://{region}.example.invalid/openai/v1",
            "regionDefault": "eastus",
            "acceptsAnyModel": True,
            "knownModels": [],
            "settings": [{"env": "AZUREISH_REGION", "configKey": "providers.azureish.region"}],
            "missingKeyMessage": "AZUREISH_API_KEY is required",
        }
        registry = load_registry()
        provider = register_compatible_row(registry, row)
        assert provider.source == "test fixture"
        provider.create_llm("azureish/gpt-4o")
        assert mock_chat.call_args.kwargs["base_url"] == "https://westus.example.invalid/openai/v1"
        assert mock_chat.call_args.kwargs["model"] == "gpt-4o"
