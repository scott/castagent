---
"cast-cli": minor
"cast-tui": minor
---

Google Gemini is a builder and runtime inference provider. `gemini/<model>` uses the OpenAI-compatible Gemini endpoint and `GEMINI_API_KEY`. `google/...` stays on OpenRouter. Deploy forwards only `GEMINI_API_KEY`. The builder omits temperature so Gemini 3 thinking models keep the API default of 1.0.
