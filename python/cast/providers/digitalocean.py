"""Registry binding for DigitalOcean serverless inference.

Wraps ``DigitalOceanInferenceProvider``. Catalog ids are not rewritten
and are not given a vendor prefix.
"""

from ._manifest import row_for
from .credentials import resolve_base_url, resolve_token
from .digitalocean_inference import DigitalOceanInferenceProvider


class DigitalOceanProvider:
    """Inference-provider object for the ``digitalocean/`` prefix."""

    def __init__(self):
        row = row_for("digitalocean")
        self.key = row["key"]
        self.name = row["name"]
        self.prefixes = tuple(row["prefixes"])
        self.default = bool(row["default"])
        self.env_var = row["envVar"]
        self.config_key = row["configKey"]
        self.base_url = row["baseUrl"]
        self.base_url_env = row.get("baseUrlEnv") or ""
        self.accepts_any_model = bool(row["acceptsAnyModel"])
        self.known_models = tuple(row.get("knownModels") or ())

    def is_available(self) -> bool:
        return bool(resolve_token(self.env_var, self.config_key, self.key))

    def create_llm(self, model=None, **kwargs):
        token = resolve_token(self.env_var, self.config_key, self.key)
        base_url = resolve_base_url(self.base_url_env, self.config_key, self.base_url)
        return DigitalOceanInferenceProvider(api_key=token, base_url=base_url).create_llm(
            model=model,
            **kwargs,
        )


provider = DigitalOceanProvider()
