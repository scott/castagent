import os
from typing import Optional

from langchain_openai import ChatOpenAI

class OpenRouterProvider:
    """OpenRouter LLM provider implementation."""
    
    name = "openrouter"
    default_base_url = "https://openrouter.ai/api/v1"
    
    supported_models = [
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4",
        "anthropic/claude-3.7-sonnet",
        "anthropic/claude-3.7-sonnet:thinking",
        "anthropic/claude-3.5-haiku",
        "anthropic/claude-3-haiku",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "google/gemini-2.5-pro-preview-03-25",
        "meta-llama/llama-4-maverick",
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

        # Normalize model names: claude-3-7-sonnet -> claude-3.7-sonnet
        # OpenRouter uses dots in version numbers for 3.5+ models
        model_name = model_name.replace("claude-3-5-", "claude-3.5-")
        model_name = model_name.replace("claude-3-7-", "claude-3.7-")
        model_name = model_name.replace("gpt-4o-", "gpt-4o-")  # Already correct
        
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
