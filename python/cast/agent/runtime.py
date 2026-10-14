import asyncio
import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langgraph.prebuilt import create_react_agent

from .base import AgentConfig
from ..harness.permissions import ApprovalBroker, PermissionGate, PermissionPrompt, guard_tool
from ..memory import MemoryMiddleware
from ..memory.prompt import append_persistent_memory_instructions
from ..providers.registry import get_provider
from ..tools.bash import bash_tool
from ..tools.read import read_tool
from ..tools.glob import glob_tool
from ..tools.git import git_status, git_commit, git_push, git_log, git_diff, git_add

def _chunk_text(msg: Any) -> str:
    """Text from one streamed model chunk. Tool messages contribute nothing."""
    if not isinstance(msg, AIMessageChunk) or not msg.content:
        return ""
    if isinstance(msg.content, str):
        return msg.content
    if isinstance(msg.content, list):
        parts = []
        for block in msg.content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if isinstance(text, str) and text:
                    parts.append(text)
        return "".join(parts)
    return ""


# Map of built-in tool names to their implementations
BUILTIN_TOOLS = {
    "bash": bash_tool,
    "read": read_tool,
    "glob": glob_tool,
    "git_status": git_status,
    "git_commit": git_commit,
    "git_push": git_push,
    "git_log": git_log,
    "git_diff": git_diff,
    "git_add": git_add,
}


class RuntimeAgent:
    """Runtime agent with optional LLM integration via the selected provider."""
    
    def __init__(self, config: AgentConfig, agent_path: str = None):
        self.config = config
        self.agent_path = agent_path or os.environ.get("AGENT_PATH", ".")
        self.approval_broker = ApprovalBroker()
        self.permission_gate = PermissionGate(self.config.permissions, self.approval_broker)
        # Callers that omit a session id keep appending to this one list.
        # A missing id is not a new session.
        self.chat_history = []
        self.session_histories: Dict[str, list] = {}
        self.graph = None
        self.llm = None
        self._provider = get_provider(self.config.model)
        self._warn_if_tools_unreadable()

        # Pass the raw model so reflection uses the same provider.
        # Memory is ready before the graph so the prompt can describe it.
        model_name = self.config.model
        env_name = self._llm_env_var()
        api_key = os.environ.get(env_name) if isinstance(env_name, str) else None
        self.memory = MemoryMiddleware(self.agent_path, model_name=model_name, api_key=api_key)

        # A missing key stays in echo mode and does not fall back.
        if self._provider.is_available():
            self._setup_llm()

    def _warn_if_tools_unreadable(self) -> None:
        """A tools list is not tools.builtin. Say that, and do not blame the provider."""
        raw = self.config.config.get("tools", {})
        if isinstance(raw, dict) or raw is None:
            return
        print(
            "Warning: agent.yaml tools must be a mapping with builtin, mcp, and custom. "
            "No tools were loaded.",
            flush=True,
        )

    def _llm_env_var(self) -> str:
        env_name = getattr(self._provider, "env_var", None)
        if isinstance(env_name, str) and env_name:
            return env_name
        return "OPENROUTER_API_KEY"

    def _llm_key_hint(self) -> str:
        return f"(Set {self._llm_env_var()} for full LLM capabilities)"

    def _llm_failure_suffix(self) -> str:
        """Ask for a key only when this process never had one.

        A configured key that still gets a 400 or 404 is a model or
        provider failure. Telling the user to set the key is wrong then.
        """
        if self._provider.is_available():
            return ""
        return f"\n\n{self._llm_key_hint()}"

    def _setup_llm(self):
        """Initialize the LLM and ReAct agent graph."""
        try:
            provider = self._provider
            model = self.config.model
            self.llm = provider.create_llm(model=model)
            
            # Load built-in tools from config. The graph receives guarded
            # copies so harness.permissions is checked before each call.
            # self.tools stays the raw implementations.
            builtin_tool_names = self.config.tools.get("builtin", [])
            self.tools = [
                BUILTIN_TOOLS[name]
                for name in builtin_tool_names
                if name in BUILTIN_TOOLS
            ]
            guarded = [
                guard_tool(BUILTIN_TOOLS[name], name, self.permission_gate)
                for name in builtin_tool_names
                if name in BUILTIN_TOOLS
            ]
            
            # Instructions, plus how persistent memory is stored when enabled.
            prompt = self.config.rendered_prompt()
            if self.memory is not None and self.memory.enabled:
                prompt = append_persistent_memory_instructions(prompt)
            self.graph = create_react_agent(
                model=self.llm,
                tools=guarded,
                prompt=prompt,
            )
        except Exception as e:
            # Log error but don't crash - fall back to echo mode.
            # The warning names the provider the model selected.
            print(f"Warning: Failed to initialize {self._provider.name} LLM: {e}", flush=True)
            self.graph = None

    def _normalize_session_id(self, session_id: Optional[str]) -> Optional[str]:
        if session_id is None:
            return None
        if not isinstance(session_id, str):
            session_id = str(session_id)
        session_id = session_id.strip()
        return session_id or None

    def _messages_from_transcript(self, transcript: Optional[List[Dict[str, Any]]]) -> list:
        """Turn a client transcript into model messages. Unknown roles are skipped."""
        messages = []
        if not transcript:
            return messages
        for turn in transcript:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            text = turn.get("text")
            if text is None:
                text = turn.get("content", "")
            if not isinstance(text, str):
                continue
            if role == "user":
                messages.append(HumanMessage(content=text))
            elif role in ("agent", "assistant"):
                messages.append(AIMessage(content=text))
        return messages

    def _history_for(
        self,
        session_id: Optional[str],
        transcript: Optional[List[Dict[str, Any]]],
    ) -> list:
        """Mutable model context for this turn.

        No session id uses the legacy shared list. An unknown id starts
        empty. A transcript is applied only then, so resume can seed a
        process that cannot read ~/.cast/sessions without duplicating a
        context this process already has.
        """
        session_id = self._normalize_session_id(session_id)
        if session_id is None:
            return self.chat_history
        existing = self.session_histories.get(session_id)
        if existing is None:
            existing = self._messages_from_transcript(transcript)
            self.session_histories[session_id] = existing
        return existing

    def _store_history(self, session_id: Optional[str], messages: list) -> None:
        session_id = self._normalize_session_id(session_id)
        if session_id is None:
            self.chat_history = messages
        else:
            self.session_histories[session_id] = messages

    def _append_user_turn(
        self,
        message: str,
        session_id: Optional[str],
        history: Optional[List[Dict[str, Any]]],
    ) -> list:
        memory_context = self.memory.format_memories(message)
        messages = self._history_for(session_id, history)
        if memory_context:
            messages.append(HumanMessage(content=f"{memory_context}\n\nUser: {message}"))
        else:
            messages.append(HumanMessage(content=message))
        return messages

    async def process_message(
        self,
        message: str,
        session_id: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Process a user message and return the response."""
        
        # Save an explicit remember request before the model can refuse.
        self.memory.remember_explicit(message)

        # If no LLM available, use echo mode
        if self.graph is None:
            return self._echo_response(message)
        
        # Enrich message with relevant memories and append to this session.
        messages = self._append_user_turn(message, session_id, history)
        
        # Process through LLM
        try:
            response = await self.graph.ainvoke({"messages": messages})
            
            # Update chat history with full conversation
            messages = response["messages"]
            self._store_history(session_id, messages)
            
            # Extract the last AI message content
            last_message = messages[-1]
            agent_response = last_message.content
            
            # Record this exchange for future memory
            asyncio.create_task(
                self.memory.record(message, agent_response, f"exchange_{len(messages)//2}")
            )
            
            return agent_response
        except Exception as e:
            # Log the error but return a friendly message
            error_msg = str(e)
            print(f"[LLM Error] {error_msg}", flush=True)
            
            # Check if it's a 404 (model not found)
            if "404" in error_msg:
                return (
                    f"I'm having trouble connecting to the AI model.\n\n"
                    f"This might be because:\n"
                    f"- The model name is incorrect\n"
                    f"- Your API key doesn't have access to this model\n"
                    f"- The model is temporarily unavailable\n\n"
                    f"Error: {error_msg}"
                    f"{self._llm_failure_suffix()}"
                )

            return f"I encountered an error: {error_msg}{self._llm_failure_suffix()}"
    
    async def process_message_stream(
        self,
        message: str,
        session_id: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[Any, None]:
        """Process a user message and yield response tokens as they're generated.

        An `ask` tool yields a PermissionPrompt and waits until
        permission/respond resolves it. Text chunks stay strings.
        """
        
        # Save an explicit remember request before the model can refuse.
        self.memory.remember_explicit(message)

        # If no LLM available, use echo mode with streaming simulation
        if self.graph is None:
            async for chunk in self._echo_response_stream(message):
                yield chunk
            return
        
        # Enrich message with relevant memories and append to this session.
        messages = self._append_user_turn(message, session_id, history)
        events: asyncio.Queue = asyncio.Queue()
        task: Optional[asyncio.Task] = None
        try:
            self.approval_broker.attach(events)
            task = asyncio.create_task(self._pump_graph_stream(message, messages, events))
            while True:
                kind, payload = await events.get()
                if kind == "permission":
                    yield PermissionPrompt(payload)
                elif kind == "text":
                    yield payload
                elif kind == "error":
                    yield f"Error processing message: {payload}"
                    return
                elif kind == "done":
                    return
        finally:
            self.approval_broker.detach()
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def _pump_graph_stream(self, message: str, messages: list, events: asyncio.Queue) -> None:
        """Run the graph and push text or errors onto `events`.

        Tool calls that need approval push onto this same queue from the
        broker, so the HTTP handler can emit them while the tool waits.
        """
        full_content = ""
        try:
            async for msg, _metadata in self.graph.astream(
                {"messages": messages},
                stream_mode="messages",
            ):
                text = _chunk_text(msg)
                if text:
                    full_content += text
                    await events.put(("text", text))
            # The list is the live session history. Appending keeps the reply.
            messages.append(AIMessage(content=full_content))
            asyncio.create_task(
                self.memory.record(message, full_content, f"stream_exchange_{len(messages)//2}")
            )
            await events.put(("done", None))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await events.put(("error", str(exc)))
    
    async def _echo_response_stream(self, message: str) -> AsyncGenerator[str, None]:
        """Generate an echo response with word-by-word streaming simulation."""
        response = self._echo_response(message)
        words = response.split(" ")
        for i, word in enumerate(words):
            if i > 0:
                yield " "
            yield word
            await asyncio.sleep(0.03)  # Small delay for streaming effect
    
    def _echo_response(self, message: str) -> str:
        """Generate an echo response when LLM is not available."""
        if message.lower() in ['hi', 'hello', 'hey']:
            return f"Hello! I'm {self.config.name}. How can I help you today?"
        
        if 'tool' in message.lower():
            builtin_tools = self.config.tools.get("builtin", [])
            return f"I have these tools available: {', '.join(builtin_tools)}"
        
        if 'help' in message.lower():
            return (
                f"I'm {self.config.name}. I can:\n"
                f"- Run bash commands\n"
                f"- Read files\n"
                f"- Search for files\n"
                f"\nWhat would you like me to do?"
            )
        
        env_name = self._llm_env_var()
        return f"You said: {message}\n\n(I'm a demo agent - set {env_name} for full LLM capabilities)"
    
    def get_agent_card(self) -> Dict[str, Any]:
        """Return AgentCard for A2A discoverability."""
        return {
            "protocolVersion": "0.2.9",
            "name": self.config.name,
            "description": self.config.description,
            "url": f"http://localhost/",
            "version": self.config.version,
            "capabilities": {
                "streaming": True,
                "pushNotifications": False,
                "stateTransitionHistory": True,
                "chatAgent": True,
            },
            "defaultInputModes": ["text/plain"],
            "defaultOutputModes": ["text/plain"],
            "skills": self.config.agent_card_skills(),
        }
