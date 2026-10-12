import json
import sys
from datetime import datetime, timezone
from typing import Optional
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from .store import MemoryHighlight
from .filter import PrivacyFilter
from ..providers.registry import get_provider


REFLECTION_PROMPT = """You are a reflection agent that identifies notable moments worth remembering.

Given a conversation exchange, decide if anything is worth remembering for future reference.

Categories to consider:
- learned: New knowledge or insights gained
- decision: Important choices or conclusions made
- pattern: Repeated behavior or common patterns noticed
- error_learned: Mistakes made and lessons learned
- accomplishment: Goals achieved or milestones reached
- preference: User's personal preferences (name, how they want to be addressed, communication style)
- context: Current state of work, where agent left off
- project: Project-specific state, goals, architecture
- tools_used: What tools/methods worked or failed
- boundary: Discovered constraints or limitations
- relationship: Interaction history, user communication style
- todo: Pending tasks, follow-ups the user mentioned
- question_asked: Any questions the user asks the agent
- directive_given: Specific directives on how the agent should act (e.g., "use TypeScript", "follow this style", "always do X")

IMPORTANT: Always mark as notable if the user shares:
- Their name or how they want to be addressed
- Preferred pronouns or communication style
- Project goals or architecture decisions
- Tools that worked or failed
- Pending tasks or follow-ups
- Explicit instructions on how to behave or work

Respond with JSON only (no markdown):
{
  "notable": true/false,
  "category": "category_name or null",
  "content": "What to remember (1-2 sentences, be concise)",
  "tags": ["relevant", "tags"],
  "reasoning": "Why this is notable (brief)"
}

Only mark as notable if it provides genuine future value to remember."""


class ReflectionAgent:
    def __init__(self, model_name: str = "claude-haiku-4", api_key: Optional[str] = None):
        # Callers still pass api_key. Selection uses the model string, and
        # availability is only the selected provider's environment variable.
        self.api_key = api_key
        self.filter = PrivacyFilter()
        self.system_message = SystemMessage(content=REFLECTION_PROMPT)
        self.llm = None
        provider = get_provider(model_name)
        if not provider.is_available():
            print(
                f"Warning: No {provider.env_var} found. Using echo mode.",
                file=sys.stderr,
            )
            return
        try:
            self.llm = provider.create_llm(model=model_name)
        except Exception as exc:
            print(f"Warning: Failed to create {provider.name} LLM: {exc}", flush=True)
            self.llm = None

    async def reflect(self, user_message: str, agent_response: str, source: str) -> Optional[MemoryHighlight]:
        if not self.llm:
            return None

        conversation = f"""User: {user_message}

Agent: {agent_response}"""

        try:
            response = await self.llm.ainvoke([
                self.system_message,
                HumanMessage(content=conversation)
            ])
            
            result = self._parse_response(response.content)
            
            if not result or not result.get("notable"):
                return None

            content = self.filter.scrub(result.get("content", ""))
            
            return MemoryHighlight(
                timestamp=datetime.now(timezone.utc).isoformat(),
                category=result.get("category", "learned"),
                content=content,
                source=source,
                tags=result.get("tags", []),
            )
        except Exception:
            return None

    def reflect_sync(self, user_message: str, agent_response: str, source: str) -> Optional[MemoryHighlight]:
        if not self.llm:
            return None

        conversation = f"""User: {user_message}

Agent: {agent_response}"""

        try:
            response = self.llm.invoke([
                self.system_message,
                HumanMessage(content=conversation)
            ])
            
            result = self._parse_response(response.content)
            
            if not result or not result.get("notable"):
                return None

            content = self.filter.scrub(result.get("content", ""))
            
            return MemoryHighlight(
                timestamp=datetime.now(timezone.utc).isoformat(),
                category=result.get("category", "learned"),
                content=content,
                source=source,
                tags=result.get("tags", []),
            )
        except Exception:
            return None

    def _parse_response(self, response: str) -> Optional[dict]:
        try:
            json_str = response.strip()
            if "```" in json_str:
                parts = json_str.split("```")
                for part in parts:
                    part = part.strip()
                    if part.startswith("json"):
                        part = part[4:].strip()
                    if part.startswith("{"):
                        return json.loads(part)
                for part in parts:
                    if part.startswith("{"):
                        return json.loads(part.strip())
            if json_str.startswith("{"):
                return json.loads(json_str)
            return None
        except json.JSONDecodeError:
            return None