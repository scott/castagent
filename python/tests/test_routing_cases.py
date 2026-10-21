"""Shared routing fixture. TypeScript mocha reads the same JSON."""

import json
from pathlib import Path

import pytest

from cast.providers.registry import InferenceProviderError, get_provider

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "inference" / "routing-cases.json").read_text()
)


def _home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in ("OPENROUTER_API_KEY", "DIGITALOCEAN_MODEL_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.mark.parametrize("case", CASES, ids=[item["id"] for item in CASES])
def test_routing_case(case, monkeypatch, tmp_path):
    _home(monkeypatch, tmp_path)
    if case["provider"] is None:
        with pytest.raises(InferenceProviderError) as exc:
            get_provider(case["id"])
        assert case["error"] in str(exc.value)
        return
    provider = get_provider(case["id"])
    assert provider.key == case["provider"]
    assert provider.impl.resolve_model_id(case["id"]) == case["model"]
    params = provider.llm_params(case["id"])
    if case["temperature"] is None:
        assert "temperature" not in params
    else:
        assert params.get("temperature") == case["temperature"]
