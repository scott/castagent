---
"cast-cli": patch
"cast-tui": patch
---

OpenRouter and DigitalOcean inference share one OpenAI-compatible provider class driven by the manifest. Vendor ids such as openai/ and x-ai/ stay on OpenRouter. Reserved direct prefixes are not registered yet. Builder temperature comes from the provider row, and OpenRouter and DigitalOcean still send 0.7.
