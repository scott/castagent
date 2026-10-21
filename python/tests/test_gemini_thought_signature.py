"""Gemini 3/4 tool calls must echo extra_content.google.thought_signature.

The mock returns 400 when a later turn's assistant tool call is missing the
signature from the first response. A plain ChatOpenAI fails that check.
GeminiChatOpenAI stores the field from the response and from stream chunks.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from cast.builder import BuilderAgent
from cast.providers.registry import get_provider

_SKIP = "skip_thought_signature_validator"


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


def _tool_message(signature: str, call_id: str = "call_1") -> dict:
    return {
        "id": "1",
        "object": "chat.completion",
        "created": 0,
        "model": "gemini-3.8-flash",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "add", "arguments": "{\"a\": 1, \"b\": 2}"},
                    "extra_content": {"google": {"thought_signature": signature}},
                }],
            },
        }],
    }


def _text_message(text: str) -> dict:
    return {
        "id": "2",
        "object": "chat.completion",
        "created": 0,
        "model": "gemini-3.8-flash",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": text},
        }],
    }


def _chunk(completion_id: str, delta: dict, finish_reason=None) -> dict:
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gemini-3.8-flash",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def _stream_tool_chunks(signature: str, call_id: str = "call_stream") -> list[dict]:
    # The signature arrives on a later chunk that has the index and not the id.
    return [
        _chunk("stream-1", {
            "role": "assistant",
            "tool_calls": [{
                "index": 0,
                "id": call_id,
                "type": "function",
                "function": {"name": "add", "arguments": ""},
            }],
        }),
        _chunk("stream-1", {
            "tool_calls": [{
                "index": 0,
                "function": {"arguments": "{\"a\": 1, \"b\": 2}"},
                "extra_content": {"google": {"thought_signature": signature}},
            }],
        }),
        _chunk("stream-1", {}, "tool_calls"),
    ]


def _stream_text_chunks(text: str) -> list[dict]:
    return [
        _chunk("stream-2", {"role": "assistant", "content": text}),
        _chunk("stream-2", {}, "stop"),
    ]


def _signature_ok(body: dict, signature: str) -> bool:
    tool_calls = [
        tool_call
        for message in body.get("messages") or []
        if message.get("role") == "assistant"
        for tool_call in (message.get("tool_calls") or [])
    ]
    if not tool_calls:
        return False
    for tool_call in tool_calls:
        extra = tool_call.get("extra_content") or {}
        found = (extra.get("google") or {}).get("thought_signature")
        if found != signature or found == _SKIP:
            return False
    return True


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.bodies.append(body)
        messages = body.get("messages") or []
        follow_up = any(message.get("role") == "tool" for message in messages)
        if follow_up and not _signature_ok(body, self.server.signature):
            payload = {
                "error": {
                    "code": 400,
                    "message": (
                        "Function call `add` in the `1.` content block is missing "
                        "a `thought_signature`."
                    ),
                    "status": "INVALID_ARGUMENT",
                }
            }
            raw = json.dumps(payload).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if body.get("stream"):
            events = _stream_text_chunks("3") if follow_up else _stream_tool_chunks(self.server.signature)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for event in events:
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = _text_message("3") if follow_up else _tool_message(self.server.signature)
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class _Server(HTTPServer):
    def __init__(self, signature: str):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.signature = signature
        self.bodies: list[dict] = []


@contextmanager
def gemini_server(signature: str):
    server = _Server(signature)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _base_url(server: _Server) -> str:
    return f"http://127.0.0.1:{server.server_port}/v1beta/openai"


def _bind(monkeypatch, tmp_path, server, model: str):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("GEMINI_BASE_URL", _base_url(server))
    llm = get_provider(model).create_llm(model=model)
    return llm.bind_tools([add])


def _follow_up(first):
    call = first.tool_calls[0]
    return ToolMessage(content=str(add.invoke(call["args"])), tool_call_id=call["id"])


def _assert_replay(server: _Server, signature: str):
    follow_ups = [body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"])]
    assert follow_ups, "expected a second request"
    body = follow_ups[-1]
    assert body["model"] == "gemini-3.8-flash"
    assert _SKIP not in json.dumps(body)
    assert _signature_ok(body, signature)
    replayed = [
        tool_call.get("extra_content")
        for message in body["messages"]
        if message.get("role") == "assistant"
        for tool_call in message.get("tool_calls") or []
    ]
    assert replayed == [{"google": {"thought_signature": signature}}]


def test_invoke_replays_thought_signature(monkeypatch, tmp_path):
    signature = "SIG-invoke-416"
    with gemini_server(signature) as server:
        llm = _bind(monkeypatch, tmp_path, server, "gemini/models/gemini-3.8-flash")
        first = llm.invoke([HumanMessage(content="1+2?")])
        assert first.tool_calls[0]["name"] == "add"
        second = llm.invoke([HumanMessage(content="1+2?"), first, _follow_up(first)])
        assert second.content == "3"
        assert all(body["model"] == "gemini-3.8-flash" for body in server.bodies)
        _assert_replay(server, signature)


async def test_astream_replays_thought_signature_from_a_later_chunk(monkeypatch, tmp_path):
    signature = "SIG-stream-416"

    async def collect(llm, messages):
        merged = None
        async for chunk in llm.astream(messages):
            merged = chunk if merged is None else merged + chunk
        return merged

    with gemini_server(signature) as server:
        llm = _bind(monkeypatch, tmp_path, server, "gemini/gemini-3.8-flash")
        first = await collect(llm, [HumanMessage(content="1+2?")])
        assert first.tool_calls[0]["id"] == "call_stream"
        second = await collect(llm, [HumanMessage(content="1+2?"), first, _follow_up(first)])
        assert second.content == "3"
        _assert_replay(server, signature)


def test_plain_chat_openai_is_rejected_without_the_signature(monkeypatch, tmp_path):
    signature = "SIG-plain-416"
    with gemini_server(signature) as server:
        monkeypatch.setenv("HOME", str(tmp_path))
        llm = ChatOpenAI(
            model="gemini-3.8-flash",
            api_key="gemini-test-key",
            base_url=_base_url(server),
        ).bind_tools([add])
        first = llm.invoke([HumanMessage(content="1+2?")])
        with pytest.raises(Exception, match="thought_signature"):
            llm.invoke([HumanMessage(content="1+2?"), first, _follow_up(first)])
        follow_up = next(body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"]))
        assert not _signature_ok(follow_up, signature)


def test_builder_graph_replays_thought_signature(monkeypatch, tmp_path):
    signature = "SIG-builder-416"
    with gemini_server(signature) as server:
        llm = _bind(monkeypatch, tmp_path, server, "gemini/gemini-3.8-flash")
        # Unbind: _build_graph calls bind_tools itself. _bind already bound,
        # and the underlying chat model is the same instance.
        chat = llm.bound
        agent = BuilderAgent.__new__(BuilderAgent)
        agent.llm = chat
        agent.tools = [add]
        graph = BuilderAgent._build_graph(agent)
        result = graph.invoke(
            {"messages": [HumanMessage(content="1+2?")]},
            {"recursion_limit": 8},
        )
        assert result["messages"][-1].content == "3"
        _assert_replay(server, signature)
