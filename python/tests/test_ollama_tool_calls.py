"""Ollama chat against a local OpenAI-compatible mock. No live server.

invoke and astream both return two parallel tool calls. The request uses
the placeholder key, so the header is Bearer ollama and not an empty Bearer.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool

from cast.providers.registry import get_provider


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


@tool
def sub(a: int, b: int) -> int:
    """Subtract two integers."""
    return a - b


def _tool_call(index: int, call_id: str, name: str, arguments: str) -> dict:
    return {
        "index": index,
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


def _chunk(completion_id: str, delta: dict, finish_reason=None) -> dict:
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "qwen3",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _write(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        authorization = self.headers.get("Authorization")
        with self.server.lock:
            self.server.bodies.append(body)
            self.server.authorizations.append(authorization)
        messages = body.get("messages") or []
        follow_up = any(message.get("role") == "tool" for message in messages)
        if body.get("stream"):
            if follow_up:
                events = [
                    _chunk("stream-2", {"role": "assistant", "content": "done"}),
                    _chunk("stream-2", {}, "stop"),
                ]
            else:
                events = [
                    _chunk("stream-1", {
                        "role": "assistant",
                        "tool_calls": [_tool_call(0, "call-add", "add", '{"a": 1, "b": 2}')],
                    }),
                    _chunk("stream-1", {
                        "tool_calls": [_tool_call(1, "call-sub", "sub", '{"a": 5, "b": 3}')],
                    }),
                    _chunk("stream-1", {}, "tool_calls"),
                ]
            raw = b"".join(f"data: {json.dumps(event)}\n\n".encode() for event in events)
            raw += b"data: [DONE]\n\n"
            self._write(200, raw, "text/event-stream")
            return
        if follow_up:
            payload = {
                "id": "text",
                "object": "chat.completion",
                "created": 0,
                "model": body.get("model"),
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "done"},
                }],
            }
        else:
            payload = {
                "id": "tools",
                "object": "chat.completion",
                "created": 0,
                "model": body.get("model"),
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {key: value for key, value in call.items() if key != "index"}
                            for call in (
                                _tool_call(0, "call-add", "add", '{"a": 1, "b": 2}'),
                                _tool_call(1, "call-sub", "sub", '{"a": 5, "b": 3}'),
                            )
                        ],
                    },
                }],
            }
        self._write(200, json.dumps(payload).encode(), "application/json")


class _Server(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.bodies: list[dict] = []
        self.authorizations: list[str | None] = []
        self.lock = threading.Lock()


@contextmanager
def ollama_server():
    server = _Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _bind(monkeypatch, tmp_path, server):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}/v1")
    chat = get_provider("ollama/qwen3").create_llm(
        model="ollama/qwen3",
        **get_provider("ollama/qwen3").llm_params("ollama/qwen3"),
    )
    return chat.bind_tools([add, sub])


def _assert_request(server, first):
    assert [call["id"] for call in first.tool_calls] == ["call-add", "call-sub"]
    assert [call["name"] for call in first.tool_calls] == ["add", "sub"]
    assert server.bodies[0]["model"] == "qwen3"
    assert server.authorizations[0] == "Bearer ollama"
    assert server.authorizations[0] != "Bearer "
    follow_up = next(body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"]))
    assistant = next(message for message in follow_up["messages"] if message.get("tool_calls"))
    assert [call["id"] for call in assistant["tool_calls"]] == ["call-add", "call-sub"]


def _tool_messages(message):
    return [
        ToolMessage(content="1", tool_call_id=call["id"])
        for call in message.tool_calls
    ]


async def _collect(llm, messages):
    merged = None
    async for chunk in llm.astream(messages):
        merged = chunk if merged is None else merged + chunk
    return merged


@pytest.mark.asyncio
async def test_invoke_parallel_tool_calls(monkeypatch, tmp_path):
    with ollama_server() as server:
        llm = _bind(monkeypatch, tmp_path, server)
        history = [HumanMessage(content="1+2 and 5-3")]
        first = llm.invoke(history)
        second = llm.invoke(history + [first, *_tool_messages(first)])
        assert second.content == "done"
        _assert_request(server, first)


@pytest.mark.asyncio
async def test_astream_parallel_tool_calls(monkeypatch, tmp_path):
    with ollama_server() as server:
        llm = _bind(monkeypatch, tmp_path, server)
        history = [HumanMessage(content="1+2 and 5-3")]
        first = await _collect(llm, history)
        second = await _collect(llm, history + [first, *_tool_messages(first)])
        assert second.content == "done"
        _assert_request(server, first)
