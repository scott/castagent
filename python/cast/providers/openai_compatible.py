"""One OpenAI-compatible binding, filled in from a manifest row.

A future provider is a row with ``"impl": "openai-compatible"``. The
registry builds it. A module is needed when the provider rewrites model
ids or supplies a ``chat_factory``. That module is the shared class plus
the rewrite or factory.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from langchain_openai import ChatOpenAI

from ._manifest import row_for
from .credentials import (
    explicit_base_url,
    normalize_region,
    resolve_setting,
    resolve_token,
)


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
        self.base_url_template = row.get("baseUrlTemplate") or ""
        self.region_default = row.get("regionDefault") or ""
        self.region_pattern = row.get("regionPattern") or ""
        self.enable_note = row.get("enableNote") or ""
        self.settings = settings_from_row(row)
        self.missing_key_message = row.get("missingKeyMessage") or (
            f"{self.env_var} environment variable is required for {self.display_name}"
        )
        self.rewrite_model = rewrite_model
        self.chat_factory = chat_factory or _default_chat

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

    def llm_params(self, model: Optional[str] = None) -> dict:
        params = dict(self.default_params)
        model_id = self.resolve_model_id(model) if model else ""
        if omits_temperature(self.omit_temperature_models, model) or omits_temperature(
            self.omit_temperature_models, model_id
        ):
            params.pop("temperature", None)
        return params

    def resolved_region(self) -> str:
        """Region setting, then ``regionDefault``. Empty when the row has neither."""
        chosen = ""
        for item in self.settings:
            env_name = item.get("env") or ""
            config_key = item.get("configKey") or ""
            if not env_name.endswith("_REGION") and not config_key.endswith(".region"):
                continue
            found = resolve_setting(env_name, config_key)
            if found:
                chosen = found
                break
        if not chosen:
            chosen = self.region_default
        if not chosen:
            return ""
        return normalize_region(chosen, self.region_pattern, self.region_default) or ""

    def resolved_base_url(self, override: Optional[str] = None) -> str:
        """Explicit builder URL, then ``{region}`` in ``baseUrlTemplate``, then ``baseUrl``.

        ``baseUrlEnv`` and config ``base_url`` stay on the builder. A deployed
        agent receives the region setting and fills the template itself.
        """
        if override:
            return override
        explicit = explicit_base_url(self.base_url_env, self.config_key)
        if explicit:
            return explicit
        template = self.base_url_template
        if template:
            if "{region}" not in template:
                raise ValueError("baseUrlTemplate must contain {region}")
            region = self.resolved_region()
            if region:
                return template.replace("{region}", region)
        return self.base_url

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
        base_url = self.resolved_base_url(base_url_override)
        model_id = self.resolve_model_id(model)
        params = dict(kwargs)
        if omits_temperature(self.omit_temperature_models, model) or omits_temperature(
            self.omit_temperature_models, model_id
        ):
            params.pop("temperature", None)
        chat = self.chat_factory()
        return chat(
            model=model_id,
            api_key=api_key,
            base_url=base_url,
            **params,
        )
