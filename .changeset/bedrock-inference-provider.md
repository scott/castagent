---
"cast-cli": minor
"cast-tui": minor
---

Amazon Bedrock is a direct inference provider. `bedrock/<inference-profile>` uses the OpenAI-compatible bedrock-runtime endpoint and `AWS_BEARER_TOKEN_BEDROCK`. `cast provider enable bedrock` stores the region, and a deployed agent receives that API key and `BEDROCK_REGION`. Base URLs stay on the builder. Long-term API keys are for exploration. Full IAM is not included.
