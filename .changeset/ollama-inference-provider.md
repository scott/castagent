---
"cast-cli": minor
"cast-tui": minor
---

Add Ollama as a local, keyless inference provider. Model ids use the ollama/ prefix and http://localhost:11434/v1 with no API key. OLLAMA_API_KEY is optional and stays on the builder. Remote deploy refuses an ollama/ model. Docker rewrites loopback to host.docker.internal and does not copy the key.
