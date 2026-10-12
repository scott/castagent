import asyncio
import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from langchain_core.messages import AIMessageChunk, HumanMessage
from langgraph.prebuilt import create_react_agent

from .base import AgentConfig
from ..memory import MemoryMiddleware
from ..providers.digitalocean_inference import DigitalOceanInferenceProvider
from ..providers.openrouter import OpenRouterProvider
from ..providers.select import api_key_env_for_model, select_provider_class
from ..tools.bash import bash_tool
from ..tools.read import read_tool
from ..tools.glob import glob_tool
from ..tools.git import git_status, git_commit, git_push, git_log, git_diff, git_add

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
        self.chat_history = []
        self.graph = None
        self.llm = None
        self.memory = None
        
        # Set up LLM only when the selected provider's key is set.
        # A missing key stays in echo mode and does not fall back.
        if self._llm_provider_class().is_available():
            self._setup_llm()
        
        # Pass the raw model so reflection uses the same provider.
        model_name = self.config.model
        api_key = os.environ.get(api_key_env_for_model(model_name))
        self.memory = MemoryMiddleware(self.agent_path, model_name=model_name, api_key=api_key)

    def _llm_provider_class(self):
        return select_provider_class(
            self.config.model,
            digitalocean_cls=DigitalOceanInferenceProvider,
            openrouter_cls=OpenRouterProvider,
        )

    def _llm_key_hint(self) -> str:
        env_name = api_key_env_for_model(self.config.model)
        return f"(Set {env_name} for full LLM capabilities)"
    
    def _setup_llm(self):
        """Initialize the LLM and ReAct agent graph."""
        try:
            provider_cls = self._llm_provider_class()
            provider = provider_cls()
            
            # Parse model from config (e.g., "openrouter/anthropic/claude-3-7-sonnet")
            model = self.config.model
            
            # Create the LLM
            self.llm = provider.create_llm(model=model)
            
            # Load built-in tools from config
            builtin_tool_names = self.config.tools.get("builtin", [])
            self.tools = [
                BUILTIN_TOOLS[name]
                for name in builtin_tool_names
                if name in BUILTIN_TOOLS
            ]
            
            # Create the ReAct agent graph with instructions as system prompt
            self.graph = create_react_agent(
                model=self.llm,
                tools=self.tools,
                prompt=self.config.instructions,
            )
        except Exception as e:
            # Log error but don't crash - fall back to echo mode
            print(f"Warning: Failed to initialize LLM: {e}", flush=True)
            self.graph = None
    
    async def process_message(self, message: str) -> str:
        """Process a user message and return the response."""
        
        # If no LLM available, use echo mode
        if self.graph is None:
            return self._echo_response(message)
        
        # Enrich message with relevant memories
        memory_context = self.memory.format_memories(message)
        
        # Process through LLM
        try:
            if memory_context:
                self.chat_history.append(HumanMessage(content=f"{memory_context}\n\nUser: {message}"))
            else:
                self.chat_history.append(HumanMessage(content=message))
            
            response = await self.graph.ainvoke({"messages": self.chat_history})
            
            # Update chat history with full conversation
            self.chat_history = response["messages"]
            
            # Extract the last AI message content
            last_message = self.chat_history[-1]
            agent_response = last_message.content
            
            # Record this exchange for future memory
            asyncio.create_task(
                self.memory.record(message, agent_response, f"exchange_{len(self.chat_history)//2}")
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
                    f"Error: {error_msg}\n\n"
                    f"{self._llm_key_hint()}"
                )
            
            return (
                f"I encountered an error: {error_msg}\n\n"
                f"{self._llm_key_hint()}"
            )
    
    async def process_message_stream(self, message: str) -> AsyncGenerator[str, None]:
        """Process a user message and yield response tokens as they're generated."""
        
        # If no LLM available, use echo mode with streaming simulation
        if self.graph is None:
            async for chunk in self._echo_response_stream(message):
                yield chunk
            return
        
        # Enrich message with relevant memories
        memory_context = self.memory.format_memories(message)
        
        # Process through LLM with streaming
        try:
            if memory_context:
                self.chat_history.append(HumanMessage(content=f"{memory_context}\n\nUser: {message}"))
            else:
                self.chat_history.append(HumanMessage(content=message))
            
            full_content = ""
            async for msg, metadata in self.graph.astream(
                {"messages": self.chat_history},
                stream_mode="messages",
            ):
                if isinstance(msg, AIMessageChunk) and msg.content:
                    if isinstance(msg.content, str):
                        yield msg.content
                        full_content += msg.content
                    elif isinstance(msg.content, list):
                        for block in msg.content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if text:
                                    yield text
                                    full_content += text
            
            # Update chat history with the final accumulated message
            from langchain_core.messages import AIMessage
            self.chat_history.append(AIMessage(content=full_content))
            
            # Record this exchange for future memory
            asyncio.create_task(
                self.memory.record(message, full_content, f"stream_exchange_{len(self.chat_history)//2}")
            )
        except Exception as e:
            yield f"Error processing message: {str(e)}"
    
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
        
        env_name = api_key_env_for_model(self.config.model)
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
            "skills": [
                {
                    "id": f"{self.config.name}-skill",
                    "name": self.config.name,
                    "description": self.config.description,
                }
            ],
        }
