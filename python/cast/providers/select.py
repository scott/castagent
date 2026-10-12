"""Model-string selection.

The two-way OpenRouter / DigitalOcean branch is gone. Callers use
``get_provider(model)``.
"""

from .registry import get_provider

__all__ = ["get_provider"]
