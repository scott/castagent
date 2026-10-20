import os
import pytest
from unittest.mock import patch, MagicMock

from cast.providers.openrouter import OpenRouterProvider


class TestOpenRouterProvider:
    """Tests for OpenRouterProvider."""
    
    def test_is_available_with_key(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            assert OpenRouterProvider.is_available() is True
    
    def test_is_available_without_key(self):
        with patch.dict(os.environ, {}, clear=True):
            assert OpenRouterProvider.is_available() is False
    
    def test_init_raises_without_key(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
                OpenRouterProvider()
    
    def test_init_with_key(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            assert provider.api_key == "test-key"
    
    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_default_model(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm()
            
            mock_chat_openai.assert_called_once()
            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "anthropic/claude-3.7-sonnet"
            assert call_kwargs["api_key"] == "test-key"
            assert call_kwargs["base_url"] == "https://openrouter.ai/api/v1"

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_strips_openrouter_prefix(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm("openrouter/anthropic/claude-3-7-sonnet")

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "anthropic/claude-3.7-sonnet"

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_normalizes_prefixed_dashed_id(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm("anthropic/claude-3-7-sonnet")

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "anthropic/claude-3.7-sonnet"

    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_adds_provider_prefix(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm("claude-3-7-sonnet")

            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "anthropic/claude-3.7-sonnet"
    
    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_preserves_provider_prefix(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm("openai/gpt-4o")
            
            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["model"] == "openai/gpt-4o"
    
    @patch("cast.providers.openrouter.ChatOpenAI")
    def test_create_llm_passes_extra_kwargs(self, mock_chat_openai):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            provider = OpenRouterProvider()
            provider.create_llm(temperature=0.5, max_tokens=100)
            
            call_kwargs = mock_chat_openai.call_args.kwargs
            assert call_kwargs["temperature"] == 0.5
            assert call_kwargs["max_tokens"] == 100
