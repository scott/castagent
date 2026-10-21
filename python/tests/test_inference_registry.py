"""Inference provider registry: selection, collisions, catalog, and callers."""

import importlib
import json
import os
import site
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from cast.providers.registry import (
    BUILTIN_MODULES,
    RESERVED_VENDOR_PREFIXES,
    InferenceProviderError,
    catalog_entries,
    get_provider,
    load_registry,
    model_status,
)

ROOT = Path(__file__).resolve().parents[2]
PROVIDERS = ROOT / "python" / "cast" / "providers"
PYTHON = ROOT / "python"


def _write_provider(home: Path, key: str, *, prefixes=None, default=False, body=None, env_var=None):
    prefixes = prefixes if prefixes is not None else [f"{key}/"]
    env_var = env_var or f"{key.upper()}_API_KEY"
    folder = home / ".cast" / "inference-providers" / key
    folder.mkdir(parents=True)
    meta = {
        "key": key,
        "name": key,
        "prefixes": prefixes,
        "envVar": env_var,
        "configKey": f"providers.{key}.api_key",
        "baseUrl": "https://example.invalid/v1",
        "acceptsAnyModel": True,
        "knownModels": [],
        "default": default,
    }
    (folder / "provider.json").write_text(json.dumps(meta))
    source = body or f"""
class Example:
    key = {key!r}
    name = {key!r}
    prefixes = {tuple(prefixes)!r}
    env_var = {env_var!r}
    default = {default!r}
    accepts_any_model = True
    known_models = ()

    def is_available(self):
        return bool(__import__("os").getenv(self.env_var))

    def create_llm(self, model=None, **kwargs):
        return {{"provider": self.key, "model": model}}

provider = Example()
"""
    (folder / "provider.py").write_text(source)
    return folder


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DIGITALOCEAN_MODEL_ACCESS_KEY", raising=False)
    monkeypatch.delenv("EXAMPLE_API_KEY", raising=False)
    return home


class TestSelection:
    def test_model_table(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        _write_provider(home, "example")
        cases = {
            "digitalocean/llama3.3-70b-instruct": "digitalocean",
            "openrouter/anthropic/claude-sonnet-4.6": "openrouter",
            "anthropic/claude-sonnet-4.6": "openrouter",
            "openai/gpt-4o": "openrouter",
            "claude-sonnet-4": "openrouter",
            "example/my-model": "example",
        }
        for model, key in cases.items():
            assert get_provider(model).key == key, model

    def test_missing_key_does_not_fall_back(self, monkeypatch):
        monkeypatch.delenv("DIGITALOCEAN_MODEL_ACCESS_KEY", raising=False)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        provider = get_provider("digitalocean/llama3.3-70b-instruct")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="DIGITALOCEAN_MODEL_ACCESS_KEY") as exc:
            provider.create_llm("digitalocean/llama3.3-70b-instruct")
        assert "OPENROUTER_API_KEY" not in str(exc.value)

        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.setenv("DIGITALOCEAN_MODEL_ACCESS_KEY", "do-key")
        provider = get_provider("openai/gpt-4o")
        assert provider.is_available() is False
        with pytest.raises(ValueError, match="OPENROUTER_API_KEY") as exc:
            provider.create_llm("openai/gpt-4o")
        assert "DIGITALOCEAN_MODEL_ACCESS_KEY" not in str(exc.value)

    def test_example_model_is_not_sent_to_openrouter(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        _write_provider(home, "example")
        monkeypatch.setenv("EXAMPLE_API_KEY", "example-key")
        with patch("cast.providers.openrouter.ChatOpenAI") as chat:
            provider = get_provider("example/my-model")
            result = provider.create_llm("example/my-model")
        assert provider.key == "example"
        assert result["model"] == "example/my-model"
        chat.assert_not_called()

    def test_prefix_collision_names_both_sources(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = _write_provider(home, "example", prefixes=["digitalocean/"])
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        message = str(exc.value)
        assert "digitalocean/" in message
        assert str(folder) in message
        assert "built-in digitalocean" in message

    def test_key_collision_names_both_sources(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = _write_provider(home, "openrouter", prefixes=["openrouter/"])
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        message = str(exc.value)
        assert "openrouter" in message
        assert str(folder) in message
        assert "built-in openrouter" in message

    @pytest.mark.parametrize("prefix", sorted(RESERVED_VENDOR_PREFIXES))
    def test_vendor_prefix_is_rejected(self, monkeypatch, tmp_path, prefix):
        home = _home(monkeypatch, tmp_path)
        key = prefix[:-1]
        _write_provider(home, key, prefixes=[prefix])
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        message = str(exc.value)
        assert prefix in message
        assert "OpenRouter known-model vendor" in message
        assert "built-in openrouter" in message

    def test_external_cannot_set_default(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        folder = _write_provider(home, "example", default=True)
        with pytest.raises(InferenceProviderError) as exc:
            load_registry()
        message = str(exc.value)
        assert "cannot set default" in message
        assert "example" in message
        assert str(folder) in message
        assert "built-in openrouter" in message

    def test_import_error_reports_path_and_keeps_builtins(self, monkeypatch, tmp_path, capsys):
        home = _home(monkeypatch, tmp_path)
        folder = home / ".cast" / "inference-providers" / "broken"
        folder.mkdir(parents=True)
        (folder / "provider.json").write_text("{}")
        py_path = folder / "provider.py"
        py_path.write_text("raise RuntimeError('boom')\n")
        registry = load_registry()
        err = capsys.readouterr().err
        assert str(py_path) in err
        assert "boom" in err
        assert registry.by_key["openrouter"].default is True
        assert "digitalocean" in registry.by_key
        assert get_provider("claude-haiku-4").key == "openrouter"

    def test_entry_points_sorted_by_key(self, monkeypatch, tmp_path):
        _home(monkeypatch, tmp_path)

        class Entry:
            def __init__(self, name, provider):
                self.name = name
                self.value = f"fake:{name}"
                self._provider = provider

            def load(self):
                return self._provider

        class Impl:
            def __init__(self, key):
                self.key = key
                self.name = key
                self.prefixes = (f"{key}/",)
                self.default = False
                self.env_var = "EXAMPLE_API_KEY"
                self.config_key = "providers.example.api_key"
                self.base_url = "https://example.invalid/v1"
                self.accepts_any_model = True
                self.known_models = ()

            def is_available(self):
                return False

            def create_llm(self, model=None, **kwargs):
                return model

        entries = [Entry("b", Impl("b")), Entry("a", Impl("a"))]
        with patch("cast.providers.registry.iter_entry_points", return_value=entries):
            keys = [item.key for item in load_registry().providers]
        assert keys == ["openrouter", "digitalocean", "a", "b"]

    def test_config_provider_and_directory_order(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        _write_provider(home, "folder")
        module_path = tmp_path / "configured.py"
        module_path.write_text(
            "class Configured:\n"
            "    key = 'configured'\n"
            "    name = 'configured'\n"
            "    prefixes = ('configured/',)\n"
            "    default = False\n"
            "    env_var = 'CONFIGURED_API_KEY'\n"
            "    config_key = 'providers.configured.api_key'\n"
            "    base_url = 'https://example.invalid/v1'\n"
            "    accepts_any_model = False\n"
            "    known_models = ('configured/one',)\n"
            "    def is_available(self):\n"
            "        return False\n"
            "    def create_llm(self, model=None, **kwargs):\n"
            "        return model\n"
            "provider = Configured()\n"
        )
        cast_dir = home / ".cast"
        cast_dir.mkdir(exist_ok=True)
        (cast_dir / "config.yaml").write_text(f"inferenceProviders:\n  - {module_path}\n")
        keys = [item.key for item in load_registry().providers]
        assert keys == ["openrouter", "digitalocean", "folder", "configured"]
        assert get_provider("configured/one").key == "configured"

    def test_catalog_omits_known_models(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        _write_provider(home, "example")
        payload = catalog_entries()
        assert any(item["key"] == "example" for item in payload)
        for item in payload:
            assert "knownModels" not in item
            assert "known_models" not in item
        openrouter = next(item for item in payload if item["key"] == "openrouter")
        assert openrouter["default"] is True
        assert openrouter["envVar"] == "OPENROUTER_API_KEY"
        assert openrouter["baseUrl"] == "https://openrouter.ai/api/v1"
        assert openrouter["acceptsAnyModel"] is False
        assert openrouter["displayName"] == "OpenRouter"
        assert openrouter["defaultModel"] == "openrouter/minimax/minimax-m2.5"
        digitalocean = next(item for item in payload if item["key"] == "digitalocean")
        assert digitalocean["acceptsAnyModel"] is True
        assert digitalocean["configKey"] == "providers.digitalocean_inference.api_key"
        assert digitalocean["baseUrl"] == "https://inference.do-ai.run/v1"
        assert digitalocean["displayName"] == "DigitalOcean Serverless Inference"
        assert digitalocean["modelsPath"] == "/models"
        assert digitalocean["fallbackModels"] == ["llama3.3-70b-instruct", "deepseek-v3.2"]
        assert digitalocean["defaultModel"] == "digitalocean/llama3.3-70b-instruct"

    def test_catalog_module_prints_json(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        env = os.environ.copy()
        env["HOME"] = str(home)
        prior = env.get("PYTHONPATH")
        # HOME is isolated so ~/.cast does not leak. User-site packages are
        # keyed off HOME, so keep the interpreter's original user site.
        parts = [str(PYTHON)]
        user_site = site.getusersitepackages()
        if isinstance(user_site, str) and os.path.isdir(user_site):
            parts.append(user_site)
        if prior:
            parts.append(prior)
        env["PYTHONPATH"] = os.pathsep.join(parts)
        result = subprocess.run(
            [sys.executable, "-m", "cast.providers.catalog"],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload[0]["key"] == "openrouter"
        assert "knownModels" not in payload[0]

    def test_model_status_matches_update_rules(self, monkeypatch, tmp_path):
        home = _home(monkeypatch, tmp_path)
        _write_provider(home, "example")
        digitalocean = model_status("digitalocean/some-new-id")
        assert digitalocean["valid"] is True
        assert digitalocean["warning"] is None
        assert digitalocean["error"] is None
        example = model_status("example/my-model")
        assert example["valid"] is True
        assert example["warning"] is None
        unknown = model_status("unknown/model")
        assert unknown["valid"] is False
        assert unknown["warning"] is None
        assert unknown["error"].startswith("Unknown provider prefix 'unknown/'")
        assert "openrouter/" in unknown["error"]
        assert "openai-api/" in unknown["error"]
        bogus = model_status("zzz/notreal")
        assert bogus["valid"] is False
        assert "Unknown provider prefix 'zzz/'" in bogus["error"]
        known = model_status("anthropic/claude-sonnet-4.6")
        assert known["valid"] is True
        assert known["warning"] is None
        shipped = model_status("openrouter/minimax/minimax-m2.5")
        assert shipped["valid"] is True
        assert shipped["warning"] is None
        assert shipped["error"] is None
        prefixed = model_status("openrouter/anthropic/claude-sonnet-4.6")
        assert prefixed["valid"] is True
        assert prefixed["error"] is None
        retired = model_status("google/gemini-2.0-flash")
        assert retired["valid"] is False
        assert retired["error"].startswith("Unknown model 'google/gemini-2.0-flash'.")

    def test_manifest_rows_match_provider_modules(self):
        manifest = json.loads((PROVIDERS / "manifest.json").read_text())
        live = [row for row in manifest if row.get("impl") != "reserved"]
        manifest_keys = {row["key"] for row in live}
        module_keys = set()
        for path in PROVIDERS.glob("*.py"):
            if path.name.startswith("_"):
                continue
            module = importlib.import_module(f"cast.providers.{path.stem}")
            if hasattr(module, "provider"):
                module_keys.add(path.stem)
                assert module.provider.key == path.stem
        bound = set()
        for module_name in BUILTIN_MODULES:
            module = importlib.import_module(module_name)
            bound.add(module.provider.key)
        # A module that exports provider is a built-in binding. An
        # openai-compatible row with no module registers itself.
        assert module_keys == bound
        assert module_keys <= manifest_keys
        auto = {
            row["key"]
            for row in live
            if row.get("impl") == "openai-compatible" and row["key"] not in module_keys
        }
        assert manifest_keys - module_keys == auto
        registry = load_registry()
        for key in auto:
            assert registry.by_key[key].source == f"built-in {key}"
        reserved = [prefix for row in manifest if row.get("impl") == "reserved" for prefix in row["prefixes"]]
        assert reserved == [
            "openai-api/",
            "anthropic-api/",
            "gemini/",
            "bedrock/",
            "ollama/",
            "xai/",
        ]
        for name in ("openai", "anthropic", "ollama"):
            module = importlib.import_module(f"cast.providers.{name}")
            assert not hasattr(module, "provider")

    def test_callers_use_get_provider(self):
        files = [
            PYTHON / "cast" / "agent" / "runtime.py",
            PYTHON / "cast" / "builder.py",
            PYTHON / "cast" / "memory" / "reflection.py",
        ]
        for path in files:
            text = path.read_text()
            assert "get_provider" in text
            assert "OpenRouterProvider" not in text
            assert "DigitalOceanInferenceProvider" not in text
            assert "select_provider_class" not in text
