"""Load inference providers and resolve a model string to one of them.

Load order:

1. Built-ins (OpenRouter default, then DigitalOcean).
2. ``cast.inference`` entry points, sorted by key.
3. ``~/.cast/inference-providers/<key>/``, sorted by directory name.
4. ``inferenceProviders`` entries in ``~/.cast/config.yaml``, in listed order.

An external key or prefix that collides with a provider loaded earlier
fails at load. An external cannot set ``default``. A provider file that
fails to import is reported and skipped; built-ins still register.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

# Vendor segments of OpenRouter known models. Not provider prefixes.
RESERVED_VENDOR_PREFIXES = frozenset({
    "openai/",
    "anthropic/",
    "google/",
    "meta-llama/",
    "kimi/",
    "minimax/",
    "deepseek/",
    "mistralai/",
    "cohere/",
    "x-ai/",
    "perplexity/",
})

KEY_RE = re.compile(r"^[a-z0-9-]+$")
PREFIX_RE = re.compile(r"^[a-z0-9-]+/$")

# One binding per built-in module. OpenRouter is the default.
BUILTIN_MODULES = (
    "cast.providers.openrouter",
    "cast.providers.digitalocean",
)


class InferenceProviderError(Exception):
    """The registry cannot load because two providers claim the same name."""


class ProviderRecord:
    """Normalized provider used by ``get_provider`` and the catalog."""

    def __init__(
        self,
        impl: Any,
        *,
        key: str,
        name: str,
        prefixes: tuple[str, ...],
        default: bool,
        env_var: str,
        config_key: str,
        base_url: str,
        accepts_any_model: bool,
        known_models: tuple[str, ...],
        source: str,
    ):
        self.impl = impl
        self.key = key
        self.name = name
        self.prefixes = prefixes
        self.default = default
        self.env_var = env_var
        self.config_key = config_key
        self.base_url = base_url
        self.accepts_any_model = accepts_any_model
        self.known_models = known_models
        self.source = source

    def is_available(self) -> bool:
        return bool(self.impl.is_available())

    def create_llm(self, model: Optional[str] = None, **kwargs):
        return self.impl.create_llm(model=model, **kwargs)


class Registry:
    def __init__(self):
        self.providers: list[ProviderRecord] = []
        self.by_key: dict[str, ProviderRecord] = {}
        self.by_prefix: dict[str, ProviderRecord] = {}
        self.errors: list[str] = []

    def add(self, record: ProviderRecord) -> None:
        if not KEY_RE.fullmatch(record.key or ""):
            raise InferenceProviderError(
                f"Inference provider key {record.key!r} from {record.source} "
                f"must match [a-z0-9-]+"
            )
        if record.key in self.by_key:
            other = self.by_key[record.key]
            raise InferenceProviderError(
                f"Inference provider key {record.key!r} from {record.source} "
                f"collides with {other.source}"
            )
        if record.default and not record.source.startswith("built-in "):
            current = next((item for item in self.providers if item.default), None)
            owner = f" ({current.source})" if current else ""
            raise InferenceProviderError(
                f"External inference provider {record.key!r} from {record.source} "
                f"cannot set default{owner}"
            )
        if not record.prefixes and not record.default:
            raise InferenceProviderError(
                f"Inference provider {record.key!r} from {record.source} "
                f"needs a prefix"
            )
        for prefix in record.prefixes:
            if not PREFIX_RE.fullmatch(prefix):
                raise InferenceProviderError(
                    f"Inference provider prefix {prefix!r} from {record.source} "
                    f"must be a provider key plus a slash"
                )
            if prefix in RESERVED_VENDOR_PREFIXES:
                raise InferenceProviderError(
                    f"Cannot register prefix {prefix!r} from {record.source}: "
                    f"it is an OpenRouter known-model vendor prefix "
                    f"owned by built-in openrouter"
                )
            if prefix in self.by_prefix:
                other = self.by_prefix[prefix]
                raise InferenceProviderError(
                    f"Inference provider prefix {prefix!r} from {record.source} "
                    f"collides with {other.source}"
                )
        self.providers.append(record)
        self.by_key[record.key] = record
        for prefix in record.prefixes:
            self.by_prefix[prefix] = record


def _as_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    return tuple(value)


def _coerce_provider(obj: Any) -> Any:
    if isinstance(obj, type):
        return obj()
    if callable(obj) and not hasattr(obj, "is_available"):
        return obj()
    return obj


def record_from_impl(impl: Any, source: str) -> ProviderRecord:
    try:
        key = impl.key
        env_var = impl.env_var
    except AttributeError as exc:
        raise InferenceProviderError(
            f"Inference provider from {source} is missing {exc}"
        ) from exc
    return ProviderRecord(
        impl,
        key=key,
        name=getattr(impl, "name", key),
        prefixes=_as_tuple(getattr(impl, "prefixes", ())),
        default=bool(getattr(impl, "default", False)),
        env_var=env_var,
        config_key=getattr(impl, "config_key", "") or "",
        base_url=getattr(impl, "base_url", "") or "",
        accepts_any_model=bool(getattr(impl, "accepts_any_model", False)),
        known_models=_as_tuple(getattr(impl, "known_models", ())),
        source=source,
    )


def load_provider_file(path: Path) -> Any:
    module_name = f"cast_external_inference_{abs(hash(str(path)))}_{id(path)}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    exported = getattr(module, "provider", None)
    if exported is None:
        raise ImportError(f"{path} does not export provider")
    return _coerce_provider(exported)


def _report_import_error(registry: Registry, path: Any, exc: BaseException) -> None:
    message = f"Failed to import inference provider {path}: {exc}"
    registry.errors.append(message)
    print(message, file=sys.stderr)


def _manifest_by_key() -> dict[str, dict]:
    path = Path(__file__).with_name("manifest.json")
    rows = json.loads(path.read_text())
    return {row["key"]: row for row in rows}


def _check_manifest(record: ProviderRecord, module_name: str) -> None:
    row = _manifest_by_key().get(record.key)
    if row is None:
        raise InferenceProviderError(
            f"Built-in module {module_name} has no manifest row for {record.key!r}"
        )
    expected = {
        "name": row["name"],
        "prefixes": tuple(row["prefixes"]),
        "default": bool(row["default"]),
        "env_var": row["envVar"],
        "config_key": row["configKey"],
        "base_url": row["baseUrl"],
        "accepts_any_model": bool(row["acceptsAnyModel"]),
        "known_models": tuple(row.get("knownModels") or ()),
    }
    actual = {
        "name": record.name,
        "prefixes": record.prefixes,
        "default": record.default,
        "env_var": record.env_var,
        "config_key": record.config_key,
        "base_url": record.base_url,
        "accepts_any_model": record.accepts_any_model,
        "known_models": record.known_models,
    }
    mismatched = [field for field, value in expected.items() if actual[field] != value]
    if mismatched:
        raise InferenceProviderError(
            f"Built-in {record.key} ({module_name}) does not match manifest.json: "
            + ", ".join(mismatched)
        )


def _load_builtins(registry: Registry) -> None:
    for module_name in BUILTIN_MODULES:
        module = importlib.import_module(module_name)
        record = record_from_impl(module.provider, source=f"built-in {module.provider.key}")
        _check_manifest(record, module_name)
        registry.add(record)


def iter_entry_points():
    from importlib.metadata import entry_points

    try:
        found = entry_points(group="cast.inference")
    except TypeError:
        found = entry_points().get("cast.inference", [])
    return list(found)


def _load_entry_points(registry: Registry) -> None:
    loaded = []
    for entry in iter_entry_points():
        source = f"entry point {entry.name!r} ({getattr(entry, 'value', entry.name)})"
        try:
            impl = _coerce_provider(entry.load())
            loaded.append((impl, source))
        except InferenceProviderError:
            raise
        except Exception as exc:
            _report_import_error(registry, getattr(entry, "value", entry.name), exc)
    loaded.sort(key=lambda item: getattr(item[0], "key", ""))
    for impl, source in loaded:
        registry.add(record_from_impl(impl, source=source))


def _inference_root() -> Path:
    return Path.home() / ".cast" / "inference-providers"


def _load_directories(registry: Registry) -> None:
    root = _inference_root()
    if not root.is_dir():
        return
    for directory in sorted((path for path in root.iterdir() if path.is_dir()), key=lambda path: path.name):
        json_path = directory / "provider.json"
        py_path = directory / "provider.py"
        if not json_path.is_file() or not py_path.is_file():
            _report_import_error(
                registry,
                directory,
                FileNotFoundError("provider.json and provider.py are required"),
            )
            continue
        try:
            meta = json.loads(json_path.read_text())
            impl = load_provider_file(py_path)
            record = _record_from_directory(impl, meta, directory, json_path, py_path)
        except InferenceProviderError:
            raise
        except Exception as exc:
            _report_import_error(registry, py_path, exc)
            continue
        registry.add(record)


def _record_from_directory(impl, meta: dict, directory: Path, json_path: Path, py_path: Path) -> ProviderRecord:
    key = meta.get("key")
    module_key = getattr(impl, "key", None)
    if directory.name != key or module_key != key:
        raise InferenceProviderError(
            f"Inference provider key mismatch for {directory}: "
            f"directory {directory.name!r}, {json_path.name} key {key!r}, "
            f"provider.key {module_key!r}"
        )
    json_prefixes = _as_tuple(meta.get("prefixes"))
    if hasattr(impl, "prefixes") and _as_tuple(impl.prefixes) != json_prefixes:
        raise InferenceProviderError(
            f"Prefixes for {key!r} in {json_path} {list(json_prefixes)} "
            f"do not match {py_path} {list(_as_tuple(impl.prefixes))}"
        )
    module_env = getattr(impl, "env_var", None)
    if module_env is not None and module_env != meta.get("envVar"):
        raise InferenceProviderError(
            f"env var for {key!r} in {json_path} ({meta.get('envVar')}) "
            f"does not match {py_path} ({module_env})"
        )
    default = bool(meta.get("default", False) or getattr(impl, "default", False))
    known = meta.get("knownModels", getattr(impl, "known_models", ()))
    return ProviderRecord(
        impl,
        key=key,
        name=meta.get("name") or getattr(impl, "name", key),
        prefixes=json_prefixes,
        default=default,
        env_var=meta.get("envVar") or module_env,
        config_key=meta.get("configKey") or getattr(impl, "config_key", "") or "",
        base_url=meta.get("baseUrl") or getattr(impl, "base_url", "") or "",
        accepts_any_model=bool(meta.get("acceptsAnyModel", getattr(impl, "accepts_any_model", False))),
        known_models=_as_tuple(known),
        source=str(directory),
    )


def load_cast_config() -> dict:
    path = Path.home() / ".cast" / "config.yaml"
    if not path.is_file():
        return {}
    try:
        import yaml
    except ImportError:
        _print_config_error(path, "PyYAML is not installed")
        return {}
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except Exception as exc:
        _print_config_error(path, exc)
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _print_config_error(path: Path, exc: Any) -> None:
    print(f"Failed to import inference provider config {path}: {exc}", file=sys.stderr)


def _entry_path(entry: str) -> Optional[Path]:
    looks_like_path = (
        entry.startswith("~")
        or entry.startswith("/")
        or entry.endswith(".py")
        or os.sep in entry
    )
    if not looks_like_path:
        return None
    return Path(os.path.expanduser(entry))


def _load_config_entries(registry: Registry) -> None:
    entries = load_cast_config().get("inferenceProviders") or []
    if isinstance(entries, str):
        entries = [entries]
    if not isinstance(entries, list):
        return
    for index, entry in enumerate(entries):
        if not isinstance(entry, str) or not entry:
            continue
        source = f"inferenceProviders[{index}] ({entry})"
        path = _entry_path(entry)
        try:
            if path is not None:
                impl = load_provider_file(path)
            else:
                module = importlib.import_module(entry)
                exported = getattr(module, "provider", None)
                if exported is None:
                    raise ImportError(f"{entry} does not export provider")
                impl = _coerce_provider(exported)
            registry.add(record_from_impl(impl, source=source))
        except InferenceProviderError:
            raise
        except Exception as exc:
            _report_import_error(registry, path if path is not None else entry, exc)


def load_registry() -> Registry:
    """Load built-ins and externals. Import errors are kept on ``errors``."""
    registry = Registry()
    _load_builtins(registry)
    _load_entry_points(registry)
    _load_directories(registry)
    _load_config_entries(registry)
    defaults = [item for item in registry.providers if item.default]
    if len(defaults) != 1:
        names = ", ".join(item.key for item in defaults) or "none"
        raise InferenceProviderError(
            f"Exactly one inference provider must be default, found {len(defaults)}: {names}"
        )
    return registry


def get_provider(model: Optional[str] = None) -> ProviderRecord:
    """Return the provider for ``model``.

    Non-default prefixes match first. The longest matching prefix wins.
    Otherwise the default provider (OpenRouter) is used.
    """
    registry = load_registry()
    text = model or ""
    best: Optional[ProviderRecord] = None
    best_len = -1
    for provider in registry.providers:
        for prefix in provider.prefixes:
            if text.startswith(prefix) and len(prefix) > best_len:
                best = provider
                best_len = len(prefix)
    if best is not None:
        return best
    for provider in registry.providers:
        if provider.default:
            return provider
    raise InferenceProviderError("No default inference provider is registered")


def model_status(model: str) -> dict:
    """Acceptance used by ``cast update --model``.

    ``knownModels`` is not part of the catalog payload. This helper is the
    path that still sees them.
    """
    provider = get_provider(model)
    if provider.accepts_any_model:
        return {"valid": True, "warning": None, "provider": provider.key}
    candidate = model
    for prefix in sorted(provider.prefixes, key=len, reverse=True):
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix):]
            break
    if candidate in provider.known_models:
        return {"valid": True, "warning": None, "provider": provider.key}
    known = ", ".join(provider.known_models)
    warning = (
        f"Model '{model}' is not in the known model list. "
        f"If you get a 404 error, the model may not be available on {provider.name}. "
        f"Known models: {known}"
    )
    return {"valid": True, "warning": warning, "provider": provider.key}


def catalog_entries(registry: Optional[Registry] = None) -> list[dict]:
    """JSON catalog. ``knownModels`` stays out of this payload."""
    registry = registry if registry is not None else load_registry()
    payload = []
    for provider in registry.providers:
        payload.append({
            "key": provider.key,
            "name": provider.name,
            "default": provider.default,
            "prefixes": list(provider.prefixes),
            "envVar": provider.env_var,
            "configKey": provider.config_key,
            "baseUrl": provider.base_url,
            "acceptsAnyModel": provider.accepts_any_model,
        })
    return payload
