---
"cast-cli": minor
"cast-tui": minor
---

Add Ollama as a local, keyless inference provider. Model ids use the ollama/ prefix and http://localhost:11434/v1 with no API key. OLLAMA_API_KEY is optional and stays on the builder. The chat list leaves out embedding names. When Ollama answers, the switch keeps ollama/qwen3 only if that pull is present and otherwise stores the first pulled chat model. When it does not answer, the switch stores ollama/qwen3 and prints ollama pull qwen3. Remote deploy refuses an ollama/ model before extract. Docker rewrites loopback to host.docker.internal and does not copy the key.
