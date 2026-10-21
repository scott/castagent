---
"cast-cli": minor
"cast-tui": minor
---

xAI is a direct inference provider. `xai/<model>` calls https://api.x.ai/v1 with `XAI_API_KEY`. `x-ai/` still uses OpenRouter. The model list keeps chat models and drops image, video, voice, embedding, and latest aliases. Deploy forwards `XAI_API_KEY` only when the agent uses `xai/`.
