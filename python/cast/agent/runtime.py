import asyncio
import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from langchain_core.messages import AIMessageChunk, HumanMessage
from langgraph.prebuilt import create_react_agent

from .base import AgentConfig
from ..providers.openrouter import OpenRouterProvider
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
    """Runtime agent with optional LLM integration via OpenRouter."""
    
    def __init__(self, config: AgentConfig):
        self.config = config
        self.chat_history = []
        self.graph = None
        
        # Set up LLM if OpenRouter API key is available
        if OpenRouterProvider.is_available():
            self._setup_llm()
    
    def _setup_llm(self):
        """Initialize the LLM and ReAct agent graph."""
        try:
            provider = OpenRouterProvider()
            
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
        
        # Process through LLM
        try:
            self.chat_history.append(HumanMessage(content=message))
            
            response = await self.graph.ainvoke({"messages": self.chat_history})
            
            # Update chat history with full conversation
            self.chat_history = response["messages"]
            
            # Extract the last AI message content
            last_message = self.chat_history[-1]
            return last_message.content
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
                    f"(Set OPENROUTER_API_KEY for full LLM capabilities)"
                )
            
            return (
                f"I encountered an error: {error_msg}\n\n"
                f"(Set OPENROUTER_API_KEY for full LLM capabilities)"
            )
    
    async def process_message_stream(self, message: str) -> AsyncGenerator[str, None]:
        """Process a user message and yield response tokens as they're generated."""
        
        # If no LLM available, use echo mode with streaming simulation
        if self.graph is None:
            async for chunk in self._echo_response_stream(message):
                yield chunk
            return
        
        # Process through LLM with streaming
        try:
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
        
        return f"You said: {message}\n\n(I'm a demo agent - set OPENROUTER_API_KEY for full LLM capabilities)"
    
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
