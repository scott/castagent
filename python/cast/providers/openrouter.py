import os
import re
from typing import Optional

from langchain_openai import ChatOpenAI


# Model ID mappings for common models
# Format: "claude-sonnet-4" -> "anthropic/claude-sonnet-4-20250514"
MODEL_ALIASES = {
    # Anthropic models - latest versions
    "claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
    "claude-opus-4": "anthropic/claude-opus-4-20250603",  # Opus 4.6
    "claude-opus-4.6": "anthropic/claude-opus-4-20250603",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "claude-3.7-sonnet:thinking": "anthropic/claude-3.7-sonnet:thinking",
    "claude-3.5-sonnet": "anthropic/claude-3.5-sonnet-20241022",
    "claude-3.5-haiku": "anthropic/claude-3.5-haiku",
    "claude-3-haiku": "anthropic/claude-3-haiku",
    # OpenAI models
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o-2024-05-13": "openai/gpt-4o-2024-05-13",
    "gpt-4-turbo": "openai/gpt-4-turbo",
    # Google models
    "gemini-2.5-pro": "google/gemini-2.5-pro",
    "gemini-2.0-flash": "google/gemini-2.0-flash",
    # Meta models
    "llama-4-maverick": "meta-llama/llama-4-maverick",
    "llama-4-scout": "meta-llama/llama-4-scout",
    "llama-3-3-70b": "meta-llama/llama-3.3-70b-instruct",
    # Kimi models
    "kimi-k2.5": "kimi/k2.5",
    "kimi-k2": "kimi/k2",
    # DeepSeek
    "deepseek-chat": "deepseek/deepseek-chat",
    "deepseek-coder": "deepseek/deepseek-coder",
    # Minimax models
    "minimax-2.5": "minimax/minimax-m2.5",
    "minimax-2.5-chat": "minimax/minimax-m2.5-chat",
}


class OpenRouterProvider:
    """OpenRouter LLM provider implementation."""

    name = "openrouter"
    default_base_url = "https://openrouter.ai/api/v1"

    supported_models = [
        # Anthropic - latest
        "anthropic/claude-sonnet-4-20250514",
        "anthropic/claude-opus-4-20250603",  # Opus 4.6
        "anthropic/claude-3.7-sonnet",
        "anthropic/claude-3.7-sonnet:thinking",
        "anthropic/claude-3.5-sonnet-20241022",
        "anthropic/claude-3.5-haiku",
        "anthropic/claude-3-haiku",
        # OpenAI
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "openai/gpt-4o-2024-05-13",
        # Google
        "google/gemini-2.5-pro",
        "google/gemini-2.0-flash",
        # Meta
        "meta-llama/llama-4-maverick",
        "meta-llama/llama-4-scout",
        "meta-llama/llama-3.3-70b-instruct",
        # Kimi
        "kimi/k2.5",
        "kimi/k2",
        # Other popular
        "deepseek/deepseek-chat",
        "deepseek/deepseek-coder",
        "mistralai/mistral-large",
        "cohere/command-r-plus",
        # Minimax
        "minimax/minimax-m2.5",
        "minimax/minimax-m2.5-chat",
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

        # If model already has a date in it (e.g., "claude-opus-4-20250603"), pass through as-is
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
            model_name = "anthropic/claude-sonnet-4-20250514"
        elif model_name.lower().startswith("anthropic/claude-opus-4") or model_name.lower() == "claude-opus-4":
            model_name = "anthropic/claude-opus-4-20250603"  # Latest Opus 4.6
        elif model_name.lower().startswith("anthropic/claude-opus") and "4.6" in model_name:
            model_name = "anthropic/claude-opus-4-20250603"
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
