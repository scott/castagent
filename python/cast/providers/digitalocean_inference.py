import os
from typing import Optional

from langchain_openai import ChatOpenAI

from .openai_compatible import OpenAICompatibleProvider


def chat_cls():
    """ChatOpenAI looked up at call time so tests can patch this module."""
    return ChatOpenAI


class DigitalOceanInferenceProvider:
    """DigitalOcean serverless inference (OpenAI-compatible chat completions).

    This is not the DigitalOcean deploy token. Auth is
    ``DIGITALOCEAN_MODEL_ACCESS_KEY`` only.
    """

    name = "digitalocean"
    default_base_url = "https://inference.do-ai.run/v1"

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.api_key = api_key if api_key is not None else os.getenv("DIGITALOCEAN_MODEL_ACCESS_KEY")
        if not self.api_key:
            raise ValueError(
                "DIGITALOCEAN_MODEL_ACCESS_KEY environment variable is required "
                "for DigitalOcean serverless inference"
            )
        self.default_base_url = base_url or self.default_base_url

    def create_llm(self, model: Optional[str] = None, **kwargs) -> ChatOpenAI:
        """Create a ChatOpenAI client for the DigitalOcean catalog id.

        Strips a leading ``digitalocean/`` and passes the rest through.
        Catalog ids are not rewritten and are not given a vendor prefix.
        """
        shared = OpenAICompatibleProvider("digitalocean", chat_factory=chat_cls)
        return shared.create_llm(
            model=model,
            api_key=self.api_key,
            base_url=self.default_base_url,
            **kwargs,
        )

    @classmethod
    def is_available(cls) -> bool:
        """True when the model access key is set in the environment, the private token file, or config."""
        return OpenAICompatibleProvider("digitalocean").is_available()
