import os
import re
from typing import Optional

from langchain_openai import ChatOpenAI


# Model ID mappings for common models
# Format: "claude-sonnet-4" -> "anthropic/claude-sonnet-4.6"
MODEL_ALIASES = {
    # Anthropic models - Claude 4 series
    "claude-sonnet-4": "anthropic/claude-sonnet-4.6",
    "claude-sonnet-4.6": "anthropic/claude-sonnet-4.6",
    "claude-opus-4": "anthropic/claude-opus-4.5",
    "claude-opus-4.5": "anthropic/claude-opus-4.5",
    "claude-opus-4.6": "anthropic/claude-opus-4.5",
    "claude-haiku-4": "anthropic/claude-haiku-4",
    # Anthropic models - Claude 3.7 series
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "claude-3.7-sonnet:thinking": "anthropic/claude-3.7-sonnet:thinking",
    # Anthropic models - Claude 3.5 series
    "claude-3.5-sonnet": "anthropic/claude-3.5-sonnet",
    "claude-3.5-haiku": "anthropic/claude-3.5-haiku",
    # Anthropic models - Claude 3 series
    "claude-3-opus": "anthropic/claude-3-opus",
    "claude-3-sonnet": "anthropic/claude-3-sonnet",
    "claude-3-haiku": "anthropic/claude-3-haiku",
    # OpenAI models
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o-search-preview": "openai/gpt-4o-search-preview",
    "gpt-4.5-turbo": "openai/gpt-4.5-turbo",
    "gpt-4-turbo": "openai/gpt-4-turbo",
    # Google models
    "gemini-2.5-pro": "google/gemini-2.5-pro",
    "gemini-2.5-flash": "google/gemini-2.5-flash",
    "gemini-2.0-flash": "google/gemini-2.0-flash",
    "gemini-1.5-pro": "google/gemini-1.5-pro",
    "gemini-1.5-flash": "google/gemini-1.5-flash",
    # Meta models - Llama 4
    "llama-4-scout": "meta-llama/llama-4-scout",
    "llama-4-maverick": "meta-llama/llama-4-maverick",
    "llama-4-17b": "meta-llama/llama-4-17b-16e-instruct",
    # Meta models - Llama 3 series
    "llama-3.3-70b": "meta-llama/llama-3.3-70b-instruct",
    "llama-3.2-90b-vision": "meta-llama/llama-3.2-90b-vision-instruct",
    "llama-3.2-11b-vision": "meta-llama/llama-3.2-11b-vision-instruct",
    "llama-3.1-405b": "meta-llama/llama-3.1-405b-instruct",
    "llama-3.1-70b": "meta-llama/llama-3.1-70b-instruct",
    "llama-3.1-8b": "meta-llama/llama-3.1-8b-instruct",
    # Kimi models
    "kimi-k2.5": "kimi/k2.5",
    "kimi-k2": "kimi/k2",
    "kimi-2.5": "kimi/kimi-2.5",
    "kimi-2": "kimi/kimi-2",
    # DeepSeek models
    "deepseek-chat-v3": "deepseek/deepseek-chat-v3-0324",
    "deepseek-chat": "deepseek/deepseek-chat",
    "deepseek-coder": "deepseek/deepseek-coder",
    # Minimax models
    "minimax-m4": "minimax/minimax-m4",
    "minimax-2.5": "minimax/minimax-m2.5",
    "minimax-2": "minimax/minimax-m2",
    # Mistral models
    "mistral-large": "mistralai/mistral-large",
    "mistral-medium": "mistralai/mistral-medium",
    "mistral-small": "mistralai/mistral-small",
    "mistral-nemo": "mistralai/mistral-nemo",
    # Cohere models
    "command-r-plus-08": "cohere/command-r-plus-08-2024",
    "command-r-plus": "cohere/command-r-plus",
    "command-r7b": "cohere/command-r7b-12-2024",
    "command-r": "cohere/command-r",
    # xAI models
    "grok-2": "x-ai/grok-2",
    "grok-2-mini": "x-ai/grok-2-mini",
    "grok-beta": "x-ai/grok-beta",
}


class OpenRouterProvider:
    """OpenRouter LLM provider implementation."""

    name = "openrouter"
    default_base_url = "https://openrouter.ai/api/v1"

    supported_models = [
        # Anthropic - Claude 4 series
        "anthropic/claude-opus-4.5",
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-haiku-4",
        # Anthropic - Claude 3.7 series
        "anthropic/claude-3.7-sonnet",
        "anthropic/claude-3.7-sonnet:thinking",
        # Anthropic - Claude 3.5 series
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.5-haiku",
        # Anthropic - Claude 3 series
        "anthropic/claude-3-opus",
        "anthropic/claude-3-sonnet",
        "anthropic/claude-3-haiku",
        # OpenAI - GPT-4o series
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "openai/gpt-4o-search-preview",
        # OpenAI - GPT-4.5
        "openai/gpt-4.5-turbo",
        # OpenAI - GPT-4 series
        "openai/gpt-4-turbo",
        # Google - Gemini 2 series
        "google/gemini-2.5-pro",
        "google/gemini-2.5-flash",
        "google/gemini-2.0-flash",
        # Google - Gemini 1.5 series
        "google/gemini-1.5-pro",
        "google/gemini-1.5-flash",
        # Meta - Llama 4 series
        "meta-llama/llama-4-scout",
        "meta-llama/llama-4-maverick",
        "meta-llama/llama-4-17b-16e-instruct",
        # Meta - Llama 3 series
        "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-3.2-90b-vision-instruct",
        "meta-llama/llama-3.2-11b-vision-instruct",
        "meta-llama/llama-3.1-405b-instruct",
        "meta-llama/llama-3.1-70b-instruct",
        "meta-llama/llama-3.1-8b-instruct",
        # Kimi
        "kimi/k2.5",
        "kimi/k2",
        "kimi/kimi-2.5",
        "kimi/kimi-2",
        # DeepSeek
        "deepseek/deepseek-chat-v3-0324",
        "deepseek/deepseek-chat",
        "deepseek/deepseek-coder",
        # Minimax
        "minimax/minimax-m4",
        "minimax/minimax-m2.5",
        "minimax/minimax-m2",
        # Mistral
        "mistralai/mistral-large",
        "mistralai/mistral-medium",
        "mistralai/mistral-small",
        "mistralai/mistral-nemo",
        # Cohere
        "cohere/command-r-plus-08-2024",
        "cohere/command-r-plus",
        "cohere/command-r7b-12-2024",
        "cohere/command-r",
        # xAI
        "x-ai/grok-2",
        "x-ai/grok-2-mini",
        "x-ai/grok-beta",
        # Perplexity
        "perplexity/llama-3.1-sonar-large-128k-online",
        "perplexity/llama-3.1-sonar-huge-128k-online",
    ]

    def __init__(self):
        self.api_key = os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY environment variable is required. "
                "Get one at https://openrouter.ai/keys"
            )

    def create_llm(self, model: Optional[str] = None, **kwargs) -> ChatOpenAI:
        """Create a LangChain ChatOpenAI instance configured for OpenRouter."""
        model_name = model or "anthropic/claude-3.7-sonnet"

        # Strip openrouter/ prefix if present (e.g., "openrouter/anthropic/claude-3.7-sonnet")
        if model_name.startswith("openrouter/"):
            model_name = model_name[len("openrouter/"):]

        # If model already has a date in it (e.g., "claude-opus-4.5"), pass through as-is
        if re.search(r"-\d{8}$", model_name) or re.search(r":\w+$", model_name):
            # Already has version date or suffix, just ensure provider prefix
            if "/" not in model_name:
                model_name = f"anthropic/{model_name}"
            return ChatOpenAI(
                model=model_name,
                api_key=self.api_key,
                base_url=self.default_base_url,
                **kwargs
            )

        # Check if model matches an alias exactly
        model_lower = model_name.lower()
        if model_lower in MODEL_ALIASES:
            model_name = MODEL_ALIASES[model_lower]
        # Check for partial matches and add appropriate dates
        elif model_name.lower().startswith("anthropic/claude-sonnet-4") or model_name.lower() == "claude-sonnet-4":
            model_name = "anthropic/claude-sonnet-4.6"
        elif model_name.lower().startswith("anthropic/claude-opus-4") or model_name.lower() == "claude-opus-4":
            model_name = "anthropic/claude-opus-4.5"  # Latest Opus 4.5
        elif model_name.lower().startswith("anthropic/claude-opus") and "4.6" in model_name:
            model_name = "anthropic/claude-opus-4.5"
        # Normalize old-style model names: claude-3-7-sonnet -> claude-3.7-sonnet
        elif re.match(r"claude-\d-\d-sonnet", model_name):
            model_name = model_name.replace("claude-3-5-", "claude-3.5-")
            model_name = model_name.replace("claude-3-7-", "claude-3.7-")

        # Ensure model has provider prefix
        if "/" not in model_name:
            model_name = f"anthropic/{model_name}"

        return ChatOpenAI(
            model=model_name,
            api_key=self.api_key,
            base_url=self.default_base_url,
            **kwargs
        )
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if OpenRouter API key is configured."""
        return bool(os.getenv("OPENROUTER_API_KEY"))
