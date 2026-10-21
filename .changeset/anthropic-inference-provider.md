---
"cast-cli": minor
"cast-tui": minor
---

Anthropic is a direct inference provider. `anthropic-api/<model>` uses native ChatAnthropic and `ANTHROPIC_API_KEY`. `anthropic/` stays on OpenRouter. Deploy forwards only `ANTHROPIC_API_KEY`. Claude 4.7 and later omit temperature.
