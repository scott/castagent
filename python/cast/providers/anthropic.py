"""Direct Anthropic API through langchain-anthropic.

The catalog base URL includes ``/v1`` so ``GET /models`` stays
``<base>/models``. ``ChatAnthropic`` talks to the official SDK, which
appends ``/v1/messages`` itself, so the client receives the host root.

The chat class is imported when a model is created. Importing this
module, or loading the registry, does not require the package.
"""

from __future__ import annotations

from .openai_compatible import OpenAICompatibleProvider

_INSTALL = "pip install 'langchain-anthropic>=1.7.6'"


def load_chat_cls():
    """ChatAnthropic, looked up at call time so tests can patch it."""
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError as exc:
        raise ImportError(
            "langchain-anthropic is required for the direct Anthropic provider. "
            f"Install it with: {_INSTALL}"
        ) from exc
    return ChatAnthropic


def chat_cls():
    return load_chat_cls()


def sdk_base_url(url: str) -> str:
    """Drop a trailing ``/v1``. The SDK adds ``/v1/messages`` on its own."""
    text = (url or "").strip().rstrip("/")
    suffix = "/v1"
    if text.endswith(suffix):
        text = text[: -len(suffix)].rstrip("/")
    return text


class AnthropicProvider(OpenAICompatibleProvider):
    """Inference-provider object for the ``anthropic-api/`` prefix."""

    def __init__(self):
        super().__init__(
            "anthropic-api",
            chat_factory=chat_cls,
            chat_base_url=sdk_base_url,
        )


provider = AnthropicProvider()
