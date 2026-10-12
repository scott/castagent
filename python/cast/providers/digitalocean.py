"""Registry binding for DigitalOcean serverless inference.

Wraps ``DigitalOceanInferenceProvider``. Catalog ids are not rewritten
and are not given a vendor prefix.
"""

import os

from ._manifest import row_for
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
        self.accepts_any_model = bool(row["acceptsAnyModel"])
        self.known_models = tuple(row.get("knownModels") or ())

    def is_available(self) -> bool:
        return bool(os.getenv(self.env_var))

    def create_llm(self, model=None, **kwargs):
        return DigitalOceanInferenceProvider().create_llm(model=model, **kwargs)


provider = DigitalOceanProvider()
