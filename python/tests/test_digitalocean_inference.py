import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from cast.providers.digitalocean_inference import DigitalOceanInferenceProvider

_ISOLATED_HOME = tempfile.mkdtemp(prefix="cast-pytest-home-")


def _env(extra=None):
    env = {"HOME": _ISOLATED_HOME, "PATH": os.environ.get("PATH", "")}
    if extra:
        env.update(extra)
    return env
from cast.providers.openrouter import MODEL_ALIASES
from cast.providers.registry import get_provider


class TestDigitalOceanInferenceProvider:
    """Tests for DigitalOcean serverless inference."""

    def test_is_available_with_key(self):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            assert DigitalOceanInferenceProvider.is_available() is True

    def test_is_available_with_both_keys(self):
        with patch.dict(os.environ, {
            "DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key",
            "OPENROUTER_API_KEY": "or-key",
        }):
            assert DigitalOceanInferenceProvider.is_available() is True

    def test_is_available_without_key(self):
        with patch.dict(os.environ, _env(), clear=True):
            assert DigitalOceanInferenceProvider.is_available() is False

    def test_is_available_ignores_openrouter_key(self):
        with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
            assert DigitalOceanInferenceProvider.is_available() is False

    def test_init_raises_without_key(self):
        with patch.dict(os.environ, _env(), clear=True):
            with pytest.raises(ValueError, match="DIGITALOCEAN_MODEL_ACCESS_KEY") as exc:
                DigitalOceanInferenceProvider()
        message = str(exc.value)
        assert "deploy" not in message.lower()
        assert "DIGITALOCEAN_API_TOKEN" not in message
        assert "DIGITALOCEAN_ACCESS_TOKEN" not in message
        assert "DIGITALOCEAN_API_KEY" not in message

    def test_init_with_key(self):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            assert provider.api_key == "do-key"
            assert provider.name == "digitalocean"
            assert provider.default_base_url == "https://inference.do-ai.run/v1"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_default_model(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm()

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "llama3.3-70b-instruct"
            assert call_kwargs["api_key"] == "do-key"
            assert call_kwargs["base_url"] == "https://inference.do-ai.run/v1"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_strips_prefix(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm("digitalocean/llama3.3-70b-instruct")

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "llama3.3-70b-instruct"
            assert call_kwargs["base_url"] == "https://inference.do-ai.run/v1"
            assert call_kwargs["api_key"] == "do-key"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_passes_unknown_catalog_id(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm("digitalocean/some-new-catalog-id")

            assert mock_chat_openai.call_args.kwargs["model"] == "some-new-catalog-id"

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_does_not_rewrite_aliases(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm("digitalocean/llama-3.3-70b")

            model = mock_chat_openai.call_args.kwargs["model"]
            assert model == "llama-3.3-70b"
            assert model != MODEL_ALIASES["llama-3.3-70b"]

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_does_not_add_vendor_prefix(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm("digitalocean/gpt-4o")
            provider.create_llm("digitalocean/claude-3-7-sonnet")

            models = [call.kwargs["model"] for call in mock_chat_openai.call_args_list]
            assert models == ["gpt-4o", "claude-3-7-sonnet"]
            assert all(not model.startswith("openai/") for model in models)
            assert all(not model.startswith("anthropic/") for model in models)

    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    def test_create_llm_passes_extra_kwargs(self, mock_chat_openai):
        with patch.dict(os.environ, {"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}):
            provider = DigitalOceanInferenceProvider()
            provider.create_llm(temperature=0.5, max_tokens=100)

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["temperature"] == 0.5
            assert call_kwargs["max_tokens"] == 100


class TestProviderSelection:
    def test_prefix_selects_digitalocean(self):
        selected = get_provider("digitalocean/llama3.3-70b-instruct")
        assert selected.key == "digitalocean"
        assert selected.env_var == "DIGITALOCEAN_MODEL_ACCESS_KEY"

    def test_openrouter_and_bare_alias_stay_on_openrouter(self):
        for model in (
            "openrouter/minimax/minimax-m2.5",
            "anthropic/claude-sonnet-4.6",
            "openai/gpt-4o",
            "claude-3-7-sonnet",
            None,
        ):
            selected = get_provider(model)
            assert selected.key == "openrouter"
            assert selected.env_var == "OPENROUTER_API_KEY"


class TestBuilderProviderSelection:
    def test_display_model_is_not_the_api_model(self):
        from cast.builder import create_llm, get_builder_model

        config = {"defaults": {"builder_model": "openrouter/minimax/minimax-m2.5"}}
        with patch("cast.builder.load_global_config", return_value=config):
            assert get_builder_model() == "minimax/minimax-m2.5"
            with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
                with patch("cast.providers.openrouter.OpenRouterProvider") as mock_or:
                    instance = MagicMock()
                    instance.create_llm.return_value = MagicMock()
                    mock_or.return_value = instance
                    mock_or.is_available.return_value = True
                    create_llm()
                    assert instance.create_llm.call_args.kwargs["model"] == "openrouter/minimax/minimax-m2.5"

    def test_digitalocean_builder_model_uses_digitalocean(self):
        from cast.builder import create_llm

        config = {"defaults": {"builder_model": "digitalocean/llama3.3-70b-instruct"}}
        with patch("cast.builder.load_global_config", return_value=config):
            with patch.dict(os.environ, {
                "DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key",
                "OPENROUTER_API_KEY": "or-key",
            }):
                with patch("cast.providers.openrouter.OpenRouterProvider") as mock_or:
                    with patch("cast.providers.digitalocean_inference.ChatOpenAI") as mock_chat:
                        llm = create_llm()
        mock_or.assert_not_called()
        assert mock_chat.call_args.kwargs["model"] == "llama3.3-70b-instruct"
        assert mock_chat.call_args.kwargs["base_url"] == "https://inference.do-ai.run/v1"
        assert mock_chat.call_args.kwargs["api_key"] == "do-key"
        assert llm is mock_chat.return_value

    def test_missing_digitalocean_key_names_env_and_does_not_fall_back(self, capsys):
        from cast.builder import EchoChatModel, create_llm

        config = {"defaults": {"builder_model": "digitalocean/deepseek-v3.2"}}
        with patch("cast.builder.load_global_config", return_value=config):
            with patch.dict(os.environ, _env({"OPENROUTER_API_KEY": "or-key"}), clear=True):
                llm = create_llm()
        assert isinstance(llm, EchoChatModel)
        err = capsys.readouterr().err
        assert "DIGITALOCEAN_MODEL_ACCESS_KEY" in err
        assert "OPENROUTER_API_KEY" not in err

    def test_openrouter_builder_does_not_require_digitalocean_key(self, capsys):
        from cast.builder import EchoChatModel, create_llm

        with patch("cast.builder.load_global_config", return_value={}):
            with patch.dict(os.environ, _env({"DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key"}), clear=True):
                llm = create_llm()
        assert isinstance(llm, EchoChatModel)
        err = capsys.readouterr().err
        assert "OPENROUTER_API_KEY" in err
        assert "DIGITALOCEAN_MODEL_ACCESS_KEY" not in err


class TestReflectionProviderSelection:
    @patch("cast.providers.digitalocean_inference.ChatOpenAI")
    @patch("cast.providers.openrouter.OpenRouterProvider")
    def test_digitalocean_model_does_not_use_openrouter(self, mock_openrouter, mock_chat):
        from cast.memory.reflection import ReflectionAgent

        with patch.dict(os.environ, {
            "DIGITALOCEAN_MODEL_ACCESS_KEY": "do-key",
            "OPENROUTER_API_KEY": "or-key",
        }):
            agent = ReflectionAgent(model_name="digitalocean/llama3.3-70b-instruct")

        assert mock_openrouter.called is False
        assert mock_openrouter.is_available.called is False
        assert mock_chat.call_args.kwargs["model"] == "llama3.3-70b-instruct"
        assert mock_chat.call_args.kwargs["base_url"] == "https://inference.do-ai.run/v1"
        assert agent.llm is not None
