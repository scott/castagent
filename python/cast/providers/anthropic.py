"""Direct Anthropic API through langchain-anthropic.

The catalog base URL includes ``/v1`` so ``GET /models`` stays
``<base>/models``. ``ChatAnthropic`` talks to the official SDK, which
appends ``/v1/messages`` itself, so the client receives the host root.
A Claude Code style ``ANTHROPIC_BASE_URL`` may omit ``/v1``. Chat strips
a trailing ``/v1``. The model list adds ``/v1`` when it is missing.

The chat class is imported when a model is created. Importing this
module, or loading the registry, does not require the package.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Optional
from urllib.parse import quote

from .openai_compatible import OpenAICompatibleProvider

_INSTALL = "pip install 'langchain-anthropic>=1.7.6'"

# ChatAnthropic treats an omitted timeout as no timeout. The OpenAI and
# Anthropic SDKs both default to 10 minutes.
REQUEST_TIMEOUT = 600.0

_ANTHROPIC_VERSION = "2023-06-01"
_LIST_TIMEOUT = 2.0

# Opus 4 and Opus 4.1 cap output below the later 64k line.
_OPUS_4_OR_41 = re.compile(r"^claude-opus-4(?:[.-]1)?$")
# 4.7 and later, including dotted ids such as claude-opus-4.7.
_CLAUDE_47_PLUS = re.compile(
    r"^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[.-][7-9]|[5-9](?:[.-]\d+)?)"
)
_CLAUDE_4 = re.compile(r"^claude-(?:opus|sonnet|haiku|fable|mythos)-4")
_CLAUDE_35 = re.compile(r"^claude-3[.-]5")

_listed_output_limits: dict[tuple[str, str], Optional[int]] = {}


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


def models_v1_root(url: str) -> str:
    """Base that includes ``/v1``, whether or not the stored URL already has it."""
    text = (url or "").strip().rstrip("/")
    if not text:
        return text
    if text.endswith("/v1"):
        return text
    return f"{text}/v1"


def model_profile(model_id: str) -> Optional[dict]:
    """Profile from langchain-anthropic.

    ``None`` means the package is not installed. ``{}`` means the package
    has no row for this id.
    """
    try:
        from langchain_anthropic.chat_models import _get_default_model_profile
    except ImportError:
        return None
    found = _get_default_model_profile(model_id) if model_id else {}
    return dict(found or {})


def family_output_floor(model_id: str) -> int:
    """Output cap when the profile and the model list have no limit.

    4096 cuts off a long tool-call file write. These floors stay at or
    under the published cap for that family.
    """
    text = (model_id or "").strip()
    if _OPUS_4_OR_41.fullmatch(text):
        return 32000
    if _CLAUDE_47_PLUS.match(text):
        return 128000
    if _CLAUDE_4.match(text):
        return 64000
    if _CLAUDE_35.match(text):
        return 8192
    if text.startswith("claude-"):
        return 8192
    return 8192


def listed_output_limit(base_url: str, api_key: str, model_id: str) -> Optional[int]:
    """``max_tokens`` from ``GET /v1/models/{id}``, or None when it is unavailable.

    Failures are cached so a missing field does not add a request to every turn.
    """
    root = models_v1_root(base_url)
    if not root or not api_key or not model_id:
        return None
    cache_key = (root, model_id)
    if cache_key in _listed_output_limits:
        return _listed_output_limits[cache_key]
    url = f"{root}/models/{quote(model_id, safe='')}"
    request = urllib.request.Request(
        url,
        headers={
            "x-api-key": api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
            "accept": "application/json",
        },
    )
    found: Optional[int] = None
    try:
        with urllib.request.urlopen(request, timeout=_LIST_TIMEOUT) as response:
            payload = json.loads(response.read().decode() or "{}")
        value = payload.get("max_tokens") if isinstance(payload, dict) else None
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            found = value
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        found = None
    _listed_output_limits[cache_key] = found
    return found


class AnthropicProvider(OpenAICompatibleProvider):
    """Inference-provider object for the ``anthropic-api/`` prefix."""

    def __init__(self):
        super().__init__(
            "anthropic-api",
            chat_factory=chat_cls,
            chat_base_url=sdk_base_url,
        )

    def _should_omit_temperature(self, model: Optional[str], model_id: str) -> bool:
        # An empty model keeps the shared empty-id behavior. A profile
        # wins when it says whether this id accepts temperature. The
        # manifest regex is only the fallback for an unknown id.
        if isinstance(model, str) and model:
            profile = model_profile(model_id or self.resolve_model_id(model))
            if profile is not None and "temperature" in profile:
                return profile.get("temperature") is False
        return super()._should_omit_temperature(model, model_id)

    def llm_params(self, model: Optional[str] = None) -> dict:
        params = super().llm_params(model)
        if not (isinstance(model, str) and model):
            return params
        profile = model_profile(self.resolve_model_id(model))
        if profile is None or "temperature" not in profile:
            return params
        if profile.get("temperature") is False:
            params.pop("temperature", None)
        elif "temperature" in self.default_params:
            params["temperature"] = self.default_params["temperature"]
        return params

    def create_llm(self, model: Optional[str] = None, **kwargs):
        if "timeout" not in kwargs and "default_request_timeout" not in kwargs:
            kwargs["timeout"] = REQUEST_TIMEOUT
        if "max_tokens" not in kwargs and isinstance(model, str) and model:
            resolved = self.resolve_model_id(model)
            profile = model_profile(resolved)
            if profile is not None and not profile.get("max_output_tokens"):
                api_key = kwargs.get("api_key")
                if api_key is None and self.env_var:
                    from .credentials import resolve_token

                    api_key = resolve_token(self.env_var, self.config_key, self.key)
                base_url = kwargs.get("base_url")
                if not base_url:
                    from .credentials import resolve_base_url

                    base_url = resolve_base_url(self.base_url_env, self.config_key, self.base_url)
                listed = listed_output_limit(base_url or "", api_key or "", resolved)
                kwargs["max_tokens"] = listed or family_output_floor(resolved)
        return super().create_llm(model, **kwargs)


provider = AnthropicProvider()
