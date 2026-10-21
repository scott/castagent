"""Resolve an inference token and base URL.

The token is never read from ``providers.digitalocean`` (that is the
deploy token). Order for a token: environment variable, then the private
file ``~/.cast/tokens/inference/<key>.token``, then the provider config
key. A value that is only an unsubstituted ``${VAR}`` is missing.

Order for the base URL: ``baseUrlEnv``, then config ``base_url`` next to
the API key, then a ``{region}`` template, then the manifest default.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
# One DNS label. Stops a region value from adding a dot, slash, or userinfo.
_REGION_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _home() -> Optional[Path]:
    """HOME only. An unset HOME must not fall back to the passwd entry."""
    raw = os.environ.get("HOME")
    if not raw:
        return None
    return Path(raw)


def expand_config_string(value: Optional[str]) -> Optional[str]:
    """Expand ``${VAR}``. An unsubstituted placeholder is not a secret."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None

    def replace(match: re.Match) -> str:
        found = os.environ.get(match.group(1))
        if found is None or found == "":
            return match.group(0)
        return found

    expanded = _PLACEHOLDER.sub(replace, text)
    if _PLACEHOLDER.search(expanded):
        return None
    expanded = expanded.strip()
    return expanded or None


def dotted(config: dict, key: str) -> Optional[str]:
    if not key:
        return None
    current: object = config
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    if not isinstance(current, str):
        return None
    return current


def inference_token_path(provider_key: str) -> Optional[Path]:
    home = _home()
    if home is None:
        return None
    return home / ".cast" / "tokens" / "inference" / f"{provider_key}.token"


def read_token_file(provider_key: str) -> Optional[str]:
    if not provider_key or not re.fullmatch(r"[a-z0-9-]+", provider_key):
        return None
    path = inference_token_path(provider_key)
    if path is None:
        return None
    try:
        if not path.is_file():
            return None
        text = path.read_text().strip()
    except OSError:
        return None
    return text or None


def resolve_token(env_var: str, config_key: str, provider_key: str) -> Optional[str]:
    if env_var:
        from_env = os.environ.get(env_var)
        if isinstance(from_env, str) and from_env.strip():
            return from_env.strip()
    from_file = read_token_file(provider_key)
    if from_file:
        return from_file
    from .registry import load_cast_config
    return expand_config_string(dotted(load_cast_config(), config_key))


def base_url_config_key(config_key: str) -> str:
    if config_key.endswith(".api_key"):
        return config_key[: -len("api_key")] + "base_url"
    return ""


def explicit_base_url(base_url_env: str, config_key: str) -> Optional[str]:
    """Builder override. None when the manifest default or a region template applies."""
    if base_url_env:
        from_env = os.environ.get(base_url_env)
        if isinstance(from_env, str) and from_env.strip():
            return from_env.strip()
    from .registry import load_cast_config
    return expand_config_string(dotted(load_cast_config(), base_url_config_key(config_key)))


def resolve_base_url(base_url_env: str, config_key: str, manifest_base: str) -> str:
    return explicit_base_url(base_url_env, config_key) or manifest_base


def resolve_setting(env_name: str, config_key: str) -> Optional[str]:
    """Non-secret setting. Environment wins, then the config key."""
    if env_name:
        from_env = os.environ.get(env_name)
        if isinstance(from_env, str) and from_env.strip():
            return from_env.strip()
    if not config_key:
        return None
    from .registry import load_cast_config
    return expand_config_string(dotted(load_cast_config(), config_key))


def normalize_region(value: Optional[str], pattern: str = "", example: str = "") -> Optional[str]:
    """A single hostname label, optionally matching a stricter provider pattern.

    Empty is missing. A value with a dot, slash, or other host punctuation
    is rejected so it cannot be interpolated into a URL.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    hint = f" Expected a region id such as {example}." if example else ""
    if _REGION_LABEL.fullmatch(text) is None:
        raise ValueError(f"Region {text!r} is not a single hostname label.{hint}")
    if pattern:
        try:
            matched = re.fullmatch(pattern, text) is not None
        except re.error as exc:
            raise ValueError(
                f"Region pattern {pattern!r} is not a valid regular expression."
            ) from exc
        if not matched:
            raise ValueError(f"Region {text!r} is not valid for this provider.{hint}")
    return text
