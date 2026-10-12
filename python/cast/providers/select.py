"""Choose an LLM provider from a model string.

``digitalocean/<model-id>`` selects DigitalOcean serverless inference.
``openrouter/...`` and bare aliases stay on OpenRouter. The prefix wins
when both API keys are set. A missing key does not fall back.
"""

from typing import Optional

DIGITALOCEAN_PREFIX = "digitalocean/"
DIGITALOCEAN_KEY_ENV = "DIGITALOCEAN_MODEL_ACCESS_KEY"
OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY"


def is_digitalocean_model(model: Optional[str]) -> bool:
    return bool(model) and model.startswith(DIGITALOCEAN_PREFIX)


def select_provider_class(model: Optional[str], digitalocean_cls, openrouter_cls):
    """Return the provider class for ``model``.

    Callers pass the classes they imported so tests can patch those names.
    """
    if is_digitalocean_model(model):
        return digitalocean_cls
    return openrouter_cls


def api_key_env_for_model(model: Optional[str]) -> str:
    """Environment variable required by the provider ``model`` selects."""
    if is_digitalocean_model(model):
        return DIGITALOCEAN_KEY_ENV
    return OPENROUTER_KEY_ENV
