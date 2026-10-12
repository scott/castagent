import os
from typing import Optional

from langchain_openai import ChatOpenAI


class DigitalOceanInferenceProvider:
    """DigitalOcean serverless inference (OpenAI-compatible chat completions).

    This is not the DigitalOcean deploy token. Auth is
    ``DIGITALOCEAN_MODEL_ACCESS_KEY`` only.
    """

    name = "digitalocean"
    default_base_url = "https://inference.do-ai.run/v1"

    def __init__(self):
        self.api_key = os.getenv("DIGITALOCEAN_MODEL_ACCESS_KEY")
        if not self.api_key:
            raise ValueError(
                "DIGITALOCEAN_MODEL_ACCESS_KEY environment variable is required "
                "for DigitalOcean serverless inference"
            )

    def create_llm(self, model: Optional[str] = None, **kwargs) -> ChatOpenAI:
        """Create a ChatOpenAI client for the DigitalOcean catalog id.

        Strips a leading ``digitalocean/`` and passes the rest through.
        Catalog ids are not rewritten and are not given a vendor prefix.
        """
        model_name = model or "llama3.3-70b-instruct"
        if model_name.startswith("digitalocean/"):
            model_name = model_name[len("digitalocean/"):]
        return ChatOpenAI(
            model=model_name,
            api_key=self.api_key,
            base_url=self.default_base_url,
            **kwargs,
        )

    @classmethod
    def is_available(cls) -> bool:
        """True only when the model access key is set."""
        return bool(os.getenv("DIGITALOCEAN_MODEL_ACCESS_KEY"))
