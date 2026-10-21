"""Load inference providers and resolve a model string to one of them.

Load order:

1. Built-ins (OpenRouter default, then DigitalOcean, then Gemini).
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
# Shared with the TypeScript resolver (vendor-prefixes.json).
RESERVED_VENDOR_PREFIXES = frozenset(
    json.loads(Path(__file__).with_name("vendor-prefixes.json").read_text())
)

KEY_RE = re.compile(r"^[a-z0-9-]+$")
PREFIX_RE = re.compile(r"^[a-z0-9-]+/$")

# One binding per built-in module. OpenRouter is the default.
BUILTIN_MODULES = (
    "cast.providers.openrouter",
    "cast.providers.digitalocean",
    "cast.providers.gemini",
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
        base_url_env: str = "",
        default_params: Optional[dict] = None,
        omit_temperature_models: tuple[str, ...] = (),
        settings: tuple[dict, ...] = (),
        keyless: bool = False,
        models_filter: str = "",
        models_headers: Optional[dict] = None,
        curated_models: bool = False,
        strip_model_id_prefix: str = "",
        base_url_template: str = "",
        region_default: str = "",
        region_pattern: str = "",
        enable_note: str = "",
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
        self.base_url_env = base_url_env or ""
        self.display_name = ""
        self.models_path = ""
        self.fallback_models: tuple[str, ...] = ()
        self.default_model = ""
        self.default_params = dict(default_params or {})
        self.omit_temperature_models = tuple(omit_temperature_models or ())
        self.settings = tuple(settings or ())
        self.keyless = bool(keyless)
        self.models_filter = models_filter or ""
        self.models_headers = dict(models_headers or {})
        self.curated_models = bool(curated_models)
        self.strip_model_id_prefix = strip_model_id_prefix or ""
        self.base_url_template = base_url_template or ""
        self.region_default = region_default or ""
        self.region_pattern = region_pattern or ""
        self.enable_note = enable_note or ""

    def is_available(self) -> bool:
        return bool(self.impl.is_available())

    def create_llm(self, model: Optional[str] = None, **kwargs):
        return self.impl.create_llm(model=model, **kwargs)

    def llm_params(self, model: Optional[str] = None) -> dict:
        """Sampling params for the builder. Temperature is omitted when the model rejects it."""
        from .openai_compatible import omits_temperature

        params = dict(self.default_params)
        model_id = ""
        resolve = getattr(self.impl, "resolve_model_id", None)
        if model and callable(resolve):
            try:
                model_id = resolve(model)
            except Exception:
                model_id = ""
        if omits_temperature(self.omit_temperature_models, model) or omits_temperature(
            self.omit_temperature_models, model_id
        ):
            params.pop("temperature", None)
        return params


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
            reserved_owner = _reserved_direct_by_prefix().get(prefix)
            if reserved_owner and not record.source.startswith("built-in "):
                raise InferenceProviderError(
                    f"Cannot register prefix {prefix!r} from {record.source}: "
                    f"it is reserved for the direct provider {reserved_owner['key']}"
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


def _reserved_direct_by_prefix() -> dict[str, dict]:
    from ._manifest import reserved_rows

    found = {}
    for row in reserved_rows():
        display = row.get("displayName") or row.get("name") or row.get("key")
        for prefix in _as_tuple(row.get("prefixes")):
            found[prefix] = {
                "prefix": prefix,
                "key": row.get("key") or prefix[:-1],
                "displayName": display,
                "openrouterVendor": row.get("openrouterVendor") or "",
            }
    return found


def _apply_row_meta(record: ProviderRecord, meta: dict) -> None:
    """Copy optional catalog fields. A new provider sets these in its row."""
    from .openai_compatible import settings_from_row

    display = meta.get("displayName") or meta.get("display_name") or record.name
    record.display_name = display or record.name
    record.models_path = meta.get("modelsPath") or meta.get("models_path") or ""
    fallback = meta.get("fallbackModels", meta.get("fallback_models", ()))
    record.fallback_models = _as_tuple(fallback)
    record.default_model = meta.get("defaultModel") or meta.get("default_model") or ""
    if "defaultParams" in meta or "default_params" in meta:
        record.default_params = dict(meta.get("defaultParams") or meta.get("default_params") or {})
    elif getattr(record.impl, "default_params", None):
        record.default_params = dict(record.impl.default_params)
    omit = meta.get("omitTemperatureModels", meta.get("omit_temperature_models"))
    if omit is not None:
        record.omit_temperature_models = _as_tuple(omit)
    elif getattr(record.impl, "omit_temperature_models", None):
        record.omit_temperature_models = _as_tuple(record.impl.omit_temperature_models)
    if "settings" in meta or "forwardEnv" in meta:
        record.settings = settings_from_row(meta)
    elif getattr(record.impl, "settings", None):
        record.settings = tuple(record.impl.settings)
    record.keyless = bool(meta.get("keyless", getattr(record.impl, "keyless", False)))
    record.models_filter = meta.get("modelsFilter") or meta.get("models_filter") or getattr(record.impl, "models_filter", "") or ""
    headers = meta.get("modelsHeaders", meta.get("models_headers"))
    if isinstance(headers, dict):
        record.models_headers = dict(headers)
    elif getattr(record.impl, "models_headers", None):
        record.models_headers = dict(record.impl.models_headers)
    record.curated_models = bool(meta.get("curatedModels", getattr(record.impl, "curated_models", False)))
    record.strip_model_id_prefix = (
        meta.get("stripModelIdPrefix")
        or meta.get("strip_model_id_prefix")
        or getattr(record.impl, "strip_model_id_prefix", "")
        or ""
    )
    if "baseUrlTemplate" in meta or "base_url_template" in meta:
        record.base_url_template = meta.get("baseUrlTemplate") or meta.get("base_url_template") or ""
    elif getattr(record.impl, "base_url_template", ""):
        record.base_url_template = record.impl.base_url_template
    if "regionDefault" in meta or "region_default" in meta:
        record.region_default = meta.get("regionDefault") or meta.get("region_default") or ""
    elif getattr(record.impl, "region_default", ""):
        record.region_default = record.impl.region_default
    if "regionPattern" in meta or "region_pattern" in meta:
        record.region_pattern = meta.get("regionPattern") or meta.get("region_pattern") or ""
    elif getattr(record.impl, "region_pattern", ""):
        record.region_pattern = record.impl.region_pattern
    if "enableNote" in meta or "enable_note" in meta:
        record.enable_note = meta.get("enableNote") or meta.get("enable_note") or ""
    elif getattr(record.impl, "enable_note", ""):
        record.enable_note = record.impl.enable_note


def record_from_impl(impl: Any, source: str) -> ProviderRecord:
    try:
        key = impl.key
        env_var = impl.env_var
    except AttributeError as exc:
        raise InferenceProviderError(
            f"Inference provider from {source} is missing {exc}"
        ) from exc
    record = ProviderRecord(
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
        base_url_env=getattr(impl, "base_url_env", "") or "",
        default_params=getattr(impl, "default_params", None) or {},
        omit_temperature_models=_as_tuple(getattr(impl, "omit_temperature_models", ())),
        settings=tuple(getattr(impl, "settings", ()) or ()),
        keyless=bool(getattr(impl, "keyless", False)),
        models_filter=getattr(impl, "models_filter", "") or "",
        models_headers=getattr(impl, "models_headers", None) or {},
        curated_models=bool(getattr(impl, "curated_models", False)),
        strip_model_id_prefix=getattr(impl, "strip_model_id_prefix", "") or "",
        base_url_template=getattr(impl, "base_url_template", "") or "",
        region_default=getattr(impl, "region_default", "") or "",
        region_pattern=getattr(impl, "region_pattern", "") or "",
        enable_note=getattr(impl, "enable_note", "") or "",
    )
    _apply_row_meta(record, {
        "displayName": getattr(impl, "display_name", None) or getattr(impl, "name", None),
        "modelsPath": getattr(impl, "models_path", "") or "",
        "fallbackModels": getattr(impl, "fallback_models", ()) or (),
        "defaultModel": getattr(impl, "default_model", "") or "",
    })
    return record


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
    from ._manifest import provider_rows

    return {row["key"]: row for row in provider_rows()}


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


def _load_compatible_rows(registry: Registry) -> None:
    """Register ``impl: openai-compatible`` rows that have no module of their own."""
    from .openai_compatible import OpenAICompatibleProvider

    for row in _manifest_by_key().values():
        if row.get("impl") != "openai-compatible":
            continue
        if row["key"] in registry.by_key:
            continue
        impl = OpenAICompatibleProvider(row=row)
        record = record_from_impl(impl, source=f"built-in {impl.key}")
        _apply_row_meta(record, row)
        registry.add(record)


def register_compatible_row(registry: Registry, row: dict, source: str = "test fixture") -> ProviderRecord:
    """Attach one OpenAI-compatible row. Tests use this for a fake provider."""
    from .openai_compatible import OpenAICompatibleProvider

    impl = OpenAICompatibleProvider(row=row)
    record = record_from_impl(impl, source=source)
    _apply_row_meta(record, row)
    registry.add(record)
    return record


def _load_builtins(registry: Registry) -> None:
    for module_name in BUILTIN_MODULES:
        module = importlib.import_module(module_name)
        record = record_from_impl(module.provider, source=f"built-in {module.provider.key}")
        _check_manifest(record, module_name)
        _apply_row_meta(record, _manifest_by_key()[record.key])
        registry.add(record)
    _load_compatible_rows(registry)


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


def _inference_root() -> Optional[Path]:
    home = os.environ.get("HOME")
    if not home:
        return None
    return Path(home) / ".cast" / "inference-providers"


def _load_directories(registry: Registry) -> None:
    root = _inference_root()
    if root is None:
        return
    try:
        if not root.is_dir():
            return
    except OSError:
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
    record = ProviderRecord(
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
        base_url_env=meta.get("baseUrlEnv") or getattr(impl, "base_url_env", "") or "",
    )
    _apply_row_meta(record, meta)
    return record


def load_cast_config() -> dict:
    home = os.environ.get("HOME")
    if not home:
        return {}
    path = Path(home) / ".cast" / "config.yaml"
    try:
        if not path.is_file():
            return {}
        text = path.read_text()
    except OSError:
        return {}
    try:
        import yaml
    except ImportError:
        _print_config_error(path, "PyYAML is not installed")
        return {}
    try:
        data = yaml.safe_load(text) or {}
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


def _registered_prefixes(registry: Registry) -> str:
    prefixes = []
    for provider in registry.providers:
        prefixes.extend(provider.prefixes)
    return ", ".join(prefixes) or "none"


def _direct_prefix_hint(registry: Registry) -> str:
    """Registered non-default prefixes, then reserved prefixes not registered yet."""
    prefixes: list[str] = []
    for provider in registry.providers:
        if provider.default:
            continue
        for prefix in provider.prefixes:
            if prefix not in prefixes:
                prefixes.append(prefix)
    for item in _reserved_direct_by_prefix().values():
        prefix = item["prefix"]
        if prefix not in prefixes:
            prefixes.append(prefix)
    return ", ".join(prefixes)


def _bare_alias(text: str) -> bool:
    from .openrouter import MODEL_ALIASES

    return text.lower() in MODEL_ALIASES


def _openrouter_handles_bare(text: str) -> bool:
    """True when OpenRouter's alias rewrite already accepts this unprefixed id.

    A bare id the rewrite does not recognize, such as ``gpt-5``, is not
    handled here. ``claude-3-7-sonnet`` is handled: the rewrite normalizes it.
    """
    if _bare_alias(text) or text in _openrouter_known():
        return True
    if re.search(r"-\d{8}$", text) or re.search(r":\w+$", text):
        return True
    from .openrouter import rewrite_openrouter_model

    rewritten = rewrite_openrouter_model(text)
    return rewritten != text and rewritten != f"anthropic/{text}"


def _openrouter_known() -> set[str]:
    from ._manifest import row_for

    return set(row_for("openrouter").get("knownModels") or [])


def prefix_route_error(model: Optional[str], registry: Registry) -> Optional[str]:
    """Error for a reserved direct prefix or a bare id. None when the default applies.

    A slash prefix that is not registered and not reserved routes to the
    default provider, the same as main. ``vendor-prefixes.json`` only stops
    an external provider from claiming ``openai/`` and the other listed
    vendor prefixes.
    """
    text = model or ""
    if not text:
        return None
    for item in _reserved_direct_by_prefix().values():
        prefix = item["prefix"]
        if text.startswith(prefix):
            rest = text[len(prefix):]
            vendor = item.get("openrouterVendor") or ""
            vendor_sentence = ""
            if vendor:
                vendor_sentence = f" {vendor}{rest} still routes to OpenRouter."
            return (
                f"Model '{text}' uses the reserved prefix '{prefix}' "
                f"for {item['displayName']}. That direct provider is not registered yet."
                f"{vendor_sentence} "
                f"Registered prefixes: {_registered_prefixes(registry)}."
            )
    if "/" in text:
        return None
    if _openrouter_handles_bare(text):
        return None
    return (
        f"Model '{text}' has no provider prefix. "
        f"OpenRouter models look like openai/gpt-4o or openrouter/openai/gpt-4o. "
        f"Direct providers use {_direct_prefix_hint(registry)}. "
        f"A bare alias such as claude-sonnet-4 still uses OpenRouter."
    )


def select_provider(model: Optional[str], registry: Registry) -> ProviderRecord:
    """Longest matching prefix wins. Otherwise the default, or a prefix error."""
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
    error = prefix_route_error(text, registry)
    if error:
        raise InferenceProviderError(error)
    for provider in registry.providers:
        if provider.default:
            return provider
    raise InferenceProviderError("No default inference provider is registered")


def get_provider(model: Optional[str] = None) -> ProviderRecord:
    """Return the provider for ``model``.

    Non-default prefixes match first. The longest matching prefix wins.
    A slash id that is not registered and not reserved uses the default.
    A reserved direct prefix that is not registered yet is an error.
    A bare OpenRouter alias still uses the default. A bare id OpenRouter
    does not already rewrite is an error.
    """
    return select_provider(model, load_registry())


def model_status(model: str) -> dict:
    """Acceptance used by ``cast update --model``.

    ``knownModels`` is not part of the catalog payload. This helper is the
    path that still sees them.

    Providers with ``acceptsAnyModel`` accept every id. Otherwise the id
    must be in ``knownModels``. A matching provider prefix, including
    ``openrouter/``, is removed before that check, so the shipped default
    ``openrouter/minimax/minimax-m2.5`` stays valid. Unknown ids are
    rejected. ``cast model`` keeps its own prefix rules.
    """
    try:
        provider = get_provider(model)
    except InferenceProviderError as exc:
        return {"valid": False, "warning": None, "error": str(exc), "provider": None}
    if provider.accepts_any_model:
        return {"valid": True, "warning": None, "error": None, "provider": provider.key}
    candidate = model
    for prefix in sorted(provider.prefixes, key=len, reverse=True):
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix):]
            break
    if candidate in provider.known_models:
        return {"valid": True, "warning": None, "error": None, "provider": provider.key}
    known = ", ".join(sorted(provider.known_models))
    error = f"Unknown model '{model}'.\nAvailable models: {known}"
    return {"valid": False, "warning": None, "error": error, "provider": provider.key}


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
            "displayName": provider.display_name or provider.name,
            **({"baseUrlEnv": provider.base_url_env} if provider.base_url_env else {}),
            **({"modelsPath": provider.models_path} if provider.models_path else {}),
            **({"fallbackModels": list(provider.fallback_models)} if provider.fallback_models else {}),
            **({"defaultModel": provider.default_model} if provider.default_model else {}),
            **({"keyless": True} if provider.keyless else {}),
            **({"modelsFilter": provider.models_filter} if provider.models_filter else {}),
            **({"modelsHeaders": provider.models_headers} if provider.models_headers else {}),
            **({"curatedModels": True} if provider.curated_models else {}),
            **({"stripModelIdPrefix": provider.strip_model_id_prefix} if provider.strip_model_id_prefix else {}),
            **({"baseUrlTemplate": provider.base_url_template} if provider.base_url_template else {}),
            **({"regionDefault": provider.region_default} if provider.region_default else {}),
            **({"regionPattern": provider.region_pattern} if provider.region_pattern else {}),
            **({"enableNote": provider.enable_note} if provider.enable_note else {}),
            **({"settings": [dict(item) for item in provider.settings]} if provider.settings else {}),
        })
    return payload
