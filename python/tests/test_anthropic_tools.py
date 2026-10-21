"""Native ChatAnthropic tool call against a mocked Messages API.

The mock is local HTTP. It does not call api.anthropic.com and it does
not use a real key. A later turn must carry the tool_use id from the
first response. The builder graph uses the same client.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool

from cast.builder import BuilderAgent
from cast.providers.registry import get_provider

_KEY = "sk-ant-test-key"


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


def _message(content, stop_reason: str) -> dict:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5-5",
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 12, "output_tokens": 6},
    }


def _tool_use() -> dict:
    return _message(
        [{
            "type": "tool_use",
            "id": "toolu_add",
            "name": "add",
            "input": {"a": 1, "b": 2},
        }],
        "tool_use",
    )


def _text(text: str) -> dict:
    return _message([{"type": "text", "text": text}], "end_turn")


def _has_tool_result(body: dict) -> bool:
    for message in body.get("messages") or []:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return True
    return False


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) or b"{}"
        body = json.loads(raw)
        record = {
            "path": self.path,
            "api_key": self.headers.get("x-api-key"),
            "version": self.headers.get("anthropic-version"),
            "body": body,
        }
        with self.server.lock:
            self.server.requests.append(record)
        if self.path != "/v1/messages":
            payload = {"type": "error", "error": {"type": "not_found_error", "message": self.path}}
            status = 404
        elif _has_tool_result(body):
            payload = _text("3")
            status = 200
        elif body.get("tools"):
            payload = _tool_use()
            status = 200
        else:
            payload = _text("ok")
            status = 200
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class _Server(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.requests: list[dict] = []
        self.lock = threading.Lock()


@contextmanager
def anthropic_server():
    server = _Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _home(monkeypatch, tmp_path, server):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("ANTHROPIC_API_KEY", _KEY)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.delenv("ANTHROPIC_API_URL", raising=False)


def _llm(monkeypatch, tmp_path, server, model: str):
    _home(monkeypatch, tmp_path, server)
    provider = get_provider(model)
    return provider.create_llm(model=model, **provider.llm_params(model)).bind_tools([add])


def _follow_up(first):
    call = first.tool_calls[0]
    return ToolMessage(content=str(add.invoke(call["args"])), tool_call_id=call["id"])


def test_invoke_round_trip_keeps_the_tool_id_and_omits_temperature(monkeypatch, tmp_path):
    model = "anthropic-api/claude-sonnet-5-5"
    with anthropic_server() as server:
        llm = _llm(monkeypatch, tmp_path, server, model)
        first = llm.invoke([HumanMessage(content="1+2?")])
        assert first.tool_calls[0]["name"] == "add"
        assert first.tool_calls[0]["id"] == "toolu_add"
        assert first.tool_calls[0]["args"] == {"a": 1, "b": 2}
        second = llm.invoke([HumanMessage(content="1+2?"), first, _follow_up(first)])
        assert second.content == "3"

    assert len(server.requests) == 2
    for record in server.requests:
        assert record["path"] == "/v1/messages"
        assert record["api_key"] == _KEY
        body = record["body"]
        assert body["model"] == "claude-sonnet-5-5"
        assert "temperature" not in body
        assert "top_p" not in body
        assert "top_k" not in body
        assert "tool_choice" not in body
        assert isinstance(body.get("max_tokens"), int)
        names = [item["name"] for item in body["tools"]]
        assert "add" in names

    follow = server.requests[1]["body"]
    results = [
        block
        for message in follow["messages"]
        for block in (message.get("content") or [])
        if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    assert results
    assert results[0]["tool_use_id"] == "toolu_add"
    assert "3" in str(results[0].get("content"))


def test_builder_graph_completes_a_tool_turn(monkeypatch, tmp_path):
    with anthropic_server() as server:
        llm = _llm(monkeypatch, tmp_path, server, "anthropic-api/claude-sonnet-5-5")
        agent = BuilderAgent.__new__(BuilderAgent)
        agent.llm = llm.bound
        agent.tools = [add]
        graph = BuilderAgent._build_graph(agent)
        result = graph.invoke(
            {"messages": [HumanMessage(content="1+2?")]},
            {"recursion_limit": 8},
        )
        assert result["messages"][-1].content == "3"
        assert any(message.tool_calls for message in result["messages"] if getattr(message, "tool_calls", None))
    assert server.requests[0]["body"]["model"] == "claude-sonnet-5-5"
    assert "tool_choice" not in server.requests[0]["body"]


def test_older_sonnet_still_sends_temperature(monkeypatch, tmp_path):
    model = "anthropic-api/claude-sonnet-4-6"
    with anthropic_server() as server:
        _home(monkeypatch, tmp_path, server)
        provider = get_provider(model)
        llm = provider.create_llm(model=model, **provider.llm_params(model))
        reply = llm.invoke([HumanMessage(content="hi")])
        assert reply.content == "ok"
    body = server.requests[0]["body"]
    assert body["model"] == "claude-sonnet-4-6"
    assert body["temperature"] == 0.7
    assert "tool_choice" not in body
    assert server.requests[0]["path"] == "/v1/messages"
