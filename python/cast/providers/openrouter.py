import os
import re
from typing import Optional

from langchain_openai import ChatOpenAI

from ._manifest import row_for
from .credentials import resolve_base_url, resolve_token
from .openai_compatible import OpenAICompatibleProvider


def chat_cls():
    """ChatOpenAI looked up at call time so tests can patch this module."""
    return ChatOpenAI


# Claude 4.7 and later keep the id the caller wrote. Earlier 4.x aliases
# still pin to the shipped snapshot (opus 4.5, sonnet 4.6).
_CLAUDE_47_OR_LATER = re.compile(
    r"claude-(?:opus|sonnet|haiku)-(?:4[.-][7-9]|[5-9](?:[.-]\d+)?)",
    re.IGNORECASE,
)


def _claude_version_passes_through(model_name: str) -> bool:
    return bool(_CLAUDE_47_OR_LATER.search(model_name or ""))


def rewrite_openrouter_model(model_name: str) -> str:
    """Alias table and vendor-prefix rules. The shared class strips ``openrouter/`` first."""
    if not model_name:
        model_name = "anthropic/claude-3.7-sonnet"

    # If model already has a date in it (e.g., "claude-opus-4.5"), pass through as-is
    if re.search(r"-\d{8}$", model_name) or re.search(r":\w+$", model_name):
        # Already has version date or suffix, just ensure provider prefix
        if "/" not in model_name:
            model_name = f"anthropic/{model_name}"
        return model_name

    # Check if model matches an alias exactly
    model_lower = model_name.lower()
    if model_lower in MODEL_ALIASES:
        model_name = MODEL_ALIASES[model_lower]
    # Check for partial matches and add appropriate dates
    elif not _claude_version_passes_through(model_name) and (
        model_name.lower().startswith("anthropic/claude-sonnet-4")
        or model_name.lower() == "claude-sonnet-4"
    ):
        model_name = "anthropic/claude-sonnet-4.6"
    elif not _claude_version_passes_through(model_name) and (
        model_name.lower().startswith("anthropic/claude-opus-4")
        or model_name.lower() == "claude-opus-4"
    ):
        model_name = "anthropic/claude-opus-4.5"  # Latest Opus 4.5
    elif (
        not _claude_version_passes_through(model_name)
        and model_name.lower().startswith("anthropic/claude-opus")
        and "4.6" in model_name
    ):
        model_name = "anthropic/claude-opus-4.5"
    # Normalize old-style ids: claude-3-7-sonnet -> claude-3.7-sonnet.
    # re.match is start-anchored, so it misses a provider prefix
    # (anthropic/claude-3-7-sonnet) left after stripping openrouter/.
    elif re.search(r"(?:^|/)claude-\d-\d-", model_name):
        model_name = model_name.replace("claude-3-5-", "claude-3.5-")
        model_name = model_name.replace("claude-3-7-", "claude-3.7-")

    # Ensure model has provider prefix
    if "/" not in model_name:
        model_name = f"anthropic/{model_name}"
    return model_name


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
    "claude-haiku-latest": "anthropic/claude-haiku-latest",
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

    # Kept in lockstep with manifest knownModels, which cast model and
    # cast update --model treat as the allow-list.
    supported_models = list(row_for("openrouter").get("knownModels") or ())

    def __init__(self):
        row = row_for("openrouter")
        self.api_key = resolve_token(row["envVar"], row["configKey"], row["key"])
        self.default_base_url = resolve_base_url(
            row.get("baseUrlEnv") or "",
            row["configKey"],
            row["baseUrl"],
        )
        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY environment variable is required. "
                "Get one at https://openrouter.ai/keys"
            )

    def create_llm(self, model: Optional[str] = None, **kwargs) -> ChatOpenAI:
        """Create a LangChain ChatOpenAI instance configured for OpenRouter."""
        shared = OpenAICompatibleProvider(
            "openrouter",
            rewrite_model=rewrite_openrouter_model,
            chat_factory=chat_cls,
        )
        return shared.create_llm(
            model=model,
            api_key=self.api_key,
            base_url=self.default_base_url,
            **kwargs,
        )

    @classmethod
    def is_available(cls) -> bool:
        """Check if an OpenRouter API key is configured."""
        return OpenAICompatibleProvider("openrouter").is_available()


class OpenRouterInference(OpenAICompatibleProvider):
    """Registry binding. Alias rewrites stay on this row; ChatOpenAI comes from the shared class."""

    def __init__(self):
        super().__init__(
            "openrouter",
            rewrite_model=rewrite_openrouter_model,
            chat_factory=chat_cls,
        )


provider = OpenRouterInference()
