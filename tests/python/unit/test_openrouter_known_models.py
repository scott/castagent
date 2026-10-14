"""The curated OpenRouter catalog must be ids the API still serves."""

import json
import urllib.request
from pathlib import Path

from cast.providers.openrouter import OpenRouterProvider
from cast.providers.registry import model_status

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "python" / "cast" / "providers" / "manifest.json"
DOCS_MANIFEST = ROOT / "docs-site" / "data" / "manifest.json"
MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models"

# Ids from issue 208 that OpenRouter rejects with HTTP 400.
RETIRED_IDS = (
    "google/gemini-2.0-flash",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3-haiku",
    "kimi/k2.5",
    "minimax/minimax-m4",
    "x-ai/grok-2",
)


def known_models() -> list[str]:
    rows = json.loads(MANIFEST.read_text())
    openrouter = next(row for row in rows if row["key"] == "openrouter")
    return list(openrouter["knownModels"])


def test_catalog_copies_agree_and_omit_retired_ids():
    known = known_models()
    assert known
    assert list(OpenRouterProvider.supported_models) == known
    docs = json.loads(DOCS_MANIFEST.read_text())
    assert sorted(item["id"] for item in docs["models"]) == sorted(known)
    for model_id in RETIRED_IDS:
        assert model_id not in known
        status = model_status(model_id)
        assert status["valid"] is False
        assert status["error"].startswith(f"Unknown model '{model_id}'.")
        prefixed = model_status(f"openrouter/{model_id}")
        assert prefixed["valid"] is False


def test_every_known_model_is_a_live_openrouter_id():
    request = urllib.request.Request(
        MODELS_ENDPOINT,
        headers={"User-Agent": "castagent-tests"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    live = {row["id"] for row in payload["data"]}
    missing = [model_id for model_id in known_models() if model_id not in live]
    assert missing == []
