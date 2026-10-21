"""DigitalOcean serverless inference on the shared OpenAI-compatible class.

Catalog ids are not rewritten and are not given a vendor prefix.
``chat_cls`` is resolved from ``digitalocean_inference`` at call time.
"""

from .digitalocean_inference import chat_cls
from .openai_compatible import OpenAICompatibleProvider


class DigitalOceanProvider(OpenAICompatibleProvider):
    """Inference-provider object for the ``digitalocean/`` prefix."""

    def __init__(self):
        super().__init__("digitalocean", chat_factory=chat_cls)


provider = DigitalOceanProvider()
