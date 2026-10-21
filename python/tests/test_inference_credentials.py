"""Token and base URL resolution. The deploy token is not an inference key."""

import os
from pathlib import Path

import pytest

from cast.providers.credentials import expand_config_string, resolve_base_url, resolve_token
from cast.providers.digitalocean_inference import DigitalOceanInferenceProvider
from cast.providers.openrouter import OpenRouterProvider


@pytest.fixture
def home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DIGITALOCEAN_MODEL_ACCESS_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    monkeypatch.delenv("DIGITALOCEAN_INFERENCE_BASE_URL", raising=False)
    return tmp_path


def test_placeholder_is_not_a_token(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert expand_config_string("${OPENROUTER_API_KEY}") is None


def test_config_token_enables_openrouter(home, monkeypatch):
    cast = home / ".cast"
    cast.mkdir()
    (cast / "config.yaml").write_text(
        "providers:\n  openrouter:\n    api_key: sk-from-config\n"
    )
    assert resolve_token("OPENROUTER_API_KEY", "providers.openrouter.api_key", "openrouter") == "sk-from-config"
    provider = OpenRouterProvider()
    assert provider.api_key == "sk-from-config"


def test_env_wins_over_config(home, monkeypatch):
    cast = home / ".cast"
    cast.mkdir()
    (cast / "config.yaml").write_text(
        "providers:\n  openrouter:\n    api_key: sk-from-config\n"
    )
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-from-env")
    assert resolve_token("OPENROUTER_API_KEY", "providers.openrouter.api_key", "openrouter") == "sk-from-env"


def test_private_token_file(home):
    token = home / ".cast" / "tokens" / "inference" / "digitalocean.token"
    token.parent.mkdir(parents=True)
    token.write_text("do-file-key\n")
    assert resolve_token(
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "providers.digitalocean_inference.api_key",
        "digitalocean",
    ) == "do-file-key"
    assert DigitalOceanInferenceProvider.is_available() is True


def test_base_url_prefers_config_over_manifest(home):
    cast = home / ".cast"
    cast.mkdir()
    (cast / "config.yaml").write_text(
        "providers:\n  digitalocean_inference:\n    base_url: https://inference.example/v1\n"
    )
    resolved = resolve_base_url(
        "DIGITALOCEAN_INFERENCE_BASE_URL",
        "providers.digitalocean_inference.api_key",
        "https://inference.do-ai.run/v1",
    )
    assert resolved == "https://inference.example/v1"
    monkey_home = Path(os.environ["HOME"])
    assert monkey_home == home


def test_deploy_token_is_not_the_inference_key(home, monkeypatch):
    cast = home / ".cast"
    cast.mkdir()
    (cast / "config.yaml").write_text(
        "providers:\n  digitalocean:\n    token: deploy-token\n"
    )
    assert resolve_token(
        "DIGITALOCEAN_MODEL_ACCESS_KEY",
        "providers.digitalocean_inference.api_key",
        "digitalocean",
    ) is None
