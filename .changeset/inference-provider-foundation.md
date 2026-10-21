---
"cast-cli": minor
"cast-tui": minor
---

OpenRouter and DigitalOcean inference share one OpenAI-compatible provider class driven by the manifest. Any slash prefix that is not a registered provider and not a reserved direct prefix stays on OpenRouter, including qwen/ and z-ai/. Reserved direct prefixes are not registered yet. Builder temperature comes from the provider row. OpenRouter and DigitalOcean still send 0.7, and Claude 4.7 and later omit temperature.
