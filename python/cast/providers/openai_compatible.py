"""One chat binding, filled in from a manifest row.

A future OpenAI-compatible provider is a row with ``"impl":
"openai-compatible"``. The registry builds it. A module is needed when
the provider rewrites model ids, supplies a ``chat_factory``, or adjusts
the base URL before the client is constructed.

A provider that is not OpenAI-compatible uses ``"impl": "module"`` and a
module in ``BUILTIN_MODULES``. That module subclasses this class, passes
its own ``chat_factory``, and exports ``provider``. The row still owns
the prefix, key, model list, and sampling. The registry does not build a
``ChatOpenAI`` client for that row.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from langchain_openai import ChatOpenAI

from ._manifest import row_for
from .credentials import resolve_base_url, resolve_token


def _default_chat():
    return ChatOpenAI


def omits_temperature(patterns, model: Optional[str]) -> bool:
    if not model:
        return False
    for pattern in patterns or ():
        if pattern and re.search(pattern, model):
            return True
    return False


def _as_tuple(value: Any) -> tuple:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    return tuple(value)


def settings_from_row(row: dict) -> tuple[dict, ...]:
    """Non-secret env settings, such as a region. Base URL names are dropped."""
    raw = row.get("settings")
    if raw is None:
        raw = row.get("forwardEnv") or []
    items = []
    if isinstance(raw, str):
        raw = [raw]
    for item in raw:
        if isinstance(item, str):
            env_name = item
            config_key = ""
        elif isinstance(item, dict) and item.get("env"):
            env_name = str(item["env"])
            config_key = str(item.get("configKey") or "")
        else:
            continue
        if not env_name or "BASE_URL" in env_name:
            continue
        items.append({"env": env_name, "configKey": config_key})
    return tuple(items)


class OpenAICompatibleProvider:
    """ChatOpenAI client described by one manifest row."""

    def __init__(
        self,
        row_key: Optional[str] = None,
        row: Optional[dict] = None,
        *,
        rewrite_model: Optional[Callable[[str], str]] = None,
        chat_factory: Optional[Callable[[], Any]] = None,
        chat_base_url: Optional[Callable[[str], str]] = None,
    ):
        if row is None:
            if not row_key:
                raise ValueError("OpenAICompatibleProvider needs a manifest row")
            row = row_for(row_key)
        self.row = row
        self.key = row["key"]
        self.name = row.get("name") or self.key
        self.display_name = row.get("displayName") or self.name
        self.prefixes = _as_tuple(row.get("prefixes"))
        self.default = bool(row.get("default", False))
        self.env_var = row.get("envVar") or ""
        self.config_key = row.get("configKey") or ""
        self.base_url = row.get("baseUrl") or ""
        self.base_url_env = row.get("baseUrlEnv") or ""
        self.accepts_any_model = bool(row.get("acceptsAnyModel", False))
        self.known_models = _as_tuple(row.get("knownModels"))
        self.models_path = row.get("modelsPath") or ""
        self.fallback_models = _as_tuple(row.get("fallbackModels"))
        self.default_model = row.get("defaultModel") or ""
        self.llm_default_model = row.get("llmDefaultModel") or ""
        self.keyless = bool(row.get("keyless", False))
        self.placeholder_key = row.get("placeholderKey") or "ollama"
        self.default_params = dict(row.get("defaultParams") or {})
        self.omit_temperature_models = _as_tuple(row.get("omitTemperatureModels"))
        self.models_filter = row.get("modelsFilter") or ""
        self.models_headers = dict(row.get("modelsHeaders") or {})
        self.curated_models = bool(row.get("curatedModels", False))
        self.strip_model_id_prefix = row.get("stripModelIdPrefix") or ""
        self.settings = settings_from_row(row)
        self.missing_key_message = row.get("missingKeyMessage") or (
            f"{self.env_var} environment variable is required for {self.display_name}"
        )
        self.rewrite_model = rewrite_model
        self.chat_factory = chat_factory or _default_chat
        self.chat_base_url = chat_base_url

    def is_available(self) -> bool:
        if self.keyless:
            return True
        if not self.env_var and not self.config_key:
            return False
        return bool(resolve_token(self.env_var, self.config_key, self.key))

    def resolve_model_id(self, model: Optional[str]) -> str:
        if isinstance(model, str) and model:
            text = model
        elif self.llm_default_model:
            text = self.llm_default_model
        elif self.default_model:
            text = self.default_model
        else:
            text = ""
        for prefix in sorted(self.prefixes, key=len, reverse=True):
            if prefix and text.startswith(prefix):
                text = text[len(prefix):]
                break
        # Listed ids and a hand-typed ``gemini/models/<id>`` both drop this
        # prefix before the request. The chat endpoint rejects ``models/``.
        strip = self.strip_model_id_prefix
        if strip and text.startswith(strip):
            text = text[len(strip):]
        if self.rewrite_model is not None:
            text = self.rewrite_model(text)
        return text

    def _should_omit_temperature(self, model: Optional[str], model_id: str) -> bool:
        """Regex fallback. A subclass may prefer a model profile before this."""
        return omits_temperature(self.omit_temperature_models, model) or omits_temperature(
            self.omit_temperature_models, model_id
        )

    def llm_params(self, model: Optional[str] = None) -> dict:
        params = dict(self.default_params)
        model_id = self.resolve_model_id(model) if model else ""
        if self._should_omit_temperature(model, model_id):
            params.pop("temperature", None)
        return params

    def create_llm(self, model: Optional[str] = None, **kwargs):
        api_key = kwargs.pop("api_key", None)
        base_url_override = kwargs.pop("base_url", None)
        kwargs.pop("chat_cls", None)
        if api_key is None and self.env_var:
            api_key = resolve_token(self.env_var, self.config_key, self.key)
        if not api_key:
            if self.keyless:
                api_key = self.placeholder_key
            else:
                raise ValueError(self.missing_key_message)
        if base_url_override:
            base_url = base_url_override
        else:
            base_url = resolve_base_url(self.base_url_env, self.config_key, self.base_url)
        if self.chat_base_url is not None:
            base_url = self.chat_base_url(base_url)
        model_id = self.resolve_model_id(model)
        params = dict(kwargs)
        if self._should_omit_temperature(model, model_id):
            params.pop("temperature", None)
        chat = self.chat_factory()
        return chat(
            model=model_id,
            api_key=api_key,
            base_url=base_url,
            **params,
        )
