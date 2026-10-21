"""Gemini 3/4 tool calls must echo extra_content.google.thought_signature.

The mock returns 400 when a later turn's assistant tool call is missing the
signature from the first response. A plain ChatOpenAI fails that check.
Signatures ride on the assistant message, so two streams on one client
keep their own.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from cast.agent.base import AgentConfig
from cast.agent.runtime import BUILTIN_TOOLS, RuntimeAgent
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


def _issued_call(index: int, call_id: str, signature: str | None, arguments: str = '{"a": 1, "b": 2}') -> dict:
    call = {
        "index": index,
        "id": call_id,
        "type": "function",
        "function": {"name": "add", "arguments": arguments},
    }
    if signature is not None:
        call["extra_content"] = {"google": {"thought_signature": signature}}
    return call


def _issued_calls(mode: str, n: int) -> list[dict]:
    if mode == "parallel":
        return [
            _issued_call(0, f"pa{n}", f"SIGA{n}"),
            _issued_call(1, f"pb{n}", f"SIGB{n}"),
        ]
    if mode == "partial":
        return [
            _issued_call(0, f"fa{n}", f"SIGF{n}"),
            _issued_call(1, f"fb{n}", None),
        ]
    if mode == "nosig":
        return [_issued_call(0, f"n{n}", None)]
    return [_issued_call(0, f"c{n}", f"SIG{n}")]


def _expected_extras(mode: str, n: int) -> dict:
    return {call["id"]: call.get("extra_content") for call in _issued_calls(mode, n)}


class _IssuingHandler(BaseHTTPRequestHandler):
    """Each first response gets its own signature. A follow-up must echo it."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def _write_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        with self.server.lock:
            self.server.bodies.append(body)
        messages = body.get("messages") or []
        follow_up = any(message.get("role") == "tool" for message in messages)
        if follow_up:
            assistant_calls = [
                tool_call
                for message in messages
                if message.get("role") == "assistant"
                for tool_call in (message.get("tool_calls") or [])
            ]
            digits = "".join(ch for ch in (assistant_calls[0]["id"] if assistant_calls else "") if ch.isdigit())
            expected = _expected_extras(self.server.mode, int(digits or "0"))
            ok = bool(assistant_calls) and all(
                tool_call.get("extra_content") == expected.get(tool_call.get("id"))
                for tool_call in assistant_calls
            )
            if not ok or _SKIP in json.dumps(body):
                self._write_json(400, {"error": {"message": "missing a `thought_signature`", "status": "INVALID_ARGUMENT"}})
                return
            tool_calls = None
        else:
            with self.server.lock:
                self.server.counter += 1
                number = self.server.counter
            tool_calls = _issued_calls(self.server.mode, number)
        if body.get("stream"):
            completion_id = f"comp-{time.time_ns()}"
            if tool_calls:
                events = _issuing_tool_events(
                    completion_id,
                    tool_calls,
                    self.server.signature_first,
                    self.server.repeat_signature,
                )
            else:
                events = [
                    _chunk(completion_id, {"role": "assistant", "content": "3"}),
                    _chunk(completion_id, {}, "stop"),
                ]
            raw_events = [f"data: {json.dumps(event)}\n\n".encode() for event in events]
            raw_events.append(b"data: [DONE]\n\n")
            payload = b"".join(raw_events)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            for piece in raw_events:
                self.wfile.write(piece)
                self.wfile.flush()
                if self.server.chunk_delay:
                    time.sleep(self.server.chunk_delay)
            return
        if tool_calls:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {key: value for key, value in call.items() if key != "index"}
                    for call in tool_calls
                ],
            }
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": "3"}
            finish = "stop"
        self._write_json(200, {
            "id": "issued",
            "object": "chat.completion",
            "created": 0,
            "model": body.get("model"),
            "choices": [{"index": 0, "finish_reason": finish, "message": message}],
        })


def _issuing_tool_events(
    completion_id: str,
    tool_calls: list[dict],
    signature_first: bool,
    repeat_signature: bool = False,
) -> list[dict]:
    id_events = []
    extra_events = []
    for position, call in enumerate(tool_calls):
        delta = {
            "tool_calls": [{
                "index": call["index"],
                "id": call["id"],
                "type": "function",
                "function": {"name": "add", "arguments": ""},
            }],
        }
        if repeat_signature and "extra_content" in call:
            delta["tool_calls"][0]["extra_content"] = call["extra_content"]
        if position == 0:
            delta["role"] = "assistant"
        id_events.append(_chunk(completion_id, delta))
        extra = {"index": call["index"], "function": {"arguments": call["function"]["arguments"]}}
        if "extra_content" in call:
            extra["extra_content"] = call["extra_content"]
        extra_events.append(_chunk(completion_id, {"tool_calls": [extra]}))
    events = (extra_events + id_events) if signature_first else (id_events + extra_events)
    events.append(_chunk(completion_id, {}, "tool_calls"))
    return events


class _IssuingServer(ThreadingHTTPServer):
    def __init__(
        self,
        mode: str,
        *,
        chunk_delay: float = 0.0,
        signature_first: bool = False,
        repeat_signature: bool = False,
    ):
        super().__init__(("127.0.0.1", 0), _IssuingHandler)
        self.mode = mode
        self.chunk_delay = chunk_delay
        self.signature_first = signature_first
        self.repeat_signature = repeat_signature
        self.counter = 0
        self.lock = threading.Lock()
        self.bodies: list[dict] = []


@contextmanager
def issuing_server(
    mode: str,
    *,
    chunk_delay: float = 0.0,
    signature_first: bool = False,
    repeat_signature: bool = False,
):
    server = _IssuingServer(
        mode,
        chunk_delay=chunk_delay,
        signature_first=signature_first,
        repeat_signature=repeat_signature,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _bind_issuing(monkeypatch, tmp_path, server, model: str = "gemini/gemini-3.8-flash"):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("GEMINI_BASE_URL", _base_url(server))
    chat = get_provider(model).create_llm(model=model)
    assert not hasattr(chat, "_gemini_extra_content")
    return chat.bind_tools([add])


def _tool_messages(message):
    return [
        ToolMessage(content="3", tool_call_id=call["id"])
        for call in message.tool_calls
    ]


async def _collect(llm, messages):
    merged = None
    async for chunk in llm.astream(messages):
        merged = chunk if merged is None else merged + chunk
    return merged


async def _two_turn(llm, stream: bool):
    history = [HumanMessage(content="1+2?")]
    if stream:
        first = await _collect(llm, history)
        second = await _collect(llm, history + [first, *_tool_messages(first)])
    else:
        first = await llm.ainvoke(history)
        second = await llm.ainvoke(history + [first, *_tool_messages(first)])
    assert second.content == "3"
    return first


async def test_ainvoke_replays_thought_signature(monkeypatch, tmp_path):
    with issuing_server("single") as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        await _two_turn(llm, stream=False)
        follow_ups = [body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"])]
        assert len(follow_ups) == 1
        replayed = follow_ups[0]["messages"]
        assistant = next(message for message in replayed if message["role"] == "assistant" and message.get("tool_calls"))
        assert assistant["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": "SIG1"}}


async def test_parallel_tool_calls_replay_each_signature(monkeypatch, tmp_path):
    with issuing_server("parallel") as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        first = await _two_turn(llm, stream=False)
        assert [call["id"] for call in first.tool_calls] == ["pa1", "pb1"]
    with issuing_server("partial") as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        first = await _two_turn(llm, stream=False)
        assert len(first.tool_calls) == 2
    with issuing_server("parallel") as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        first = await _two_turn(llm, stream=True)
        assert [call["id"] for call in first.tool_calls] == ["pa1", "pb1"]


async def test_repeated_signature_on_two_chunks_is_replayed_once(monkeypatch, tmp_path):
    with issuing_server("single", repeat_signature=True) as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        first = await _two_turn(llm, stream=True)
        stored = first.additional_kwargs["gemini_tool_call_extra_stream"]
        assert [entry["i"] for entry in stored] == [0, 0]
        assert [entry["extra"]["google"]["thought_signature"] for entry in stored] == ["SIG1", "SIG1"]
        follow_up = next(body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"]))
        replayed = json.dumps(follow_up)
        assert "SIG1SIG1" not in replayed
        assert "gemini_tool_call_extra" not in replayed


async def test_astream_keeps_a_signature_that_arrives_before_the_id(monkeypatch, tmp_path):
    with issuing_server("single", signature_first=True) as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        first = await _two_turn(llm, stream=True)
        assert first.tool_calls[0]["id"] == "c1"


async def test_concurrent_astreams_on_one_instance(monkeypatch, tmp_path):
    with issuing_server("single", chunk_delay=0.05) as server:
        llm = _bind_issuing(monkeypatch, tmp_path, server)
        for count in (2, 4):
            await asyncio.gather(*[_two_turn(llm, stream=True) for _ in range(count)])
        follow_ups = [body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"])]
        assert len(follow_ups) == 6
        assert not hasattr(llm.bound, "_gemini_extra_content")


def test_debug_log_when_payload_message_count_differs(caplog):
    from cast.providers.gemini import GeminiChatOpenAI

    secret = "do-not-log-this-prompt"
    llm = GeminiChatOpenAI(
        model="gemini-3.8-flash",
        api_key="gemini-test-key",
        base_url="http://127.0.0.1/v1",
    )

    def short_payload(self, input_, *, stop=None, **kwargs):
        return {"messages": [{"role": "user", "content": "only-one"}]}

    with caplog.at_level(logging.DEBUG, logger="cast.providers.gemini"):
        with patch("cast.providers.gemini.ChatOpenAI._get_request_payload", short_payload):
            payload = llm._get_request_payload([
                HumanMessage(content=secret),
                HumanMessage(content="second"),
            ])
    assert payload == {"messages": [{"role": "user", "content": "only-one"}]}
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelno == logging.DEBUG
    assert record.message.startswith("Not attaching Gemini thought signatures")
    assert "2" in record.message
    assert "1" in record.message
    assert secret not in caplog.text
    assert "gemini-test-key" not in caplog.text
    assert "only-one" not in caplog.text
    assert "second" not in caplog.text


def _runtime_agent(tmp_path, monkeypatch, server):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("GEMINI_BASE_URL", _base_url(server))
    monkeypatch.setitem(BUILTIN_TOOLS, "add", add)
    agent_dir = tmp_path / "demo"
    agent_dir.mkdir()
    (agent_dir / "agent.yaml").write_text(
        "\n".join([
            "name: demo",
            'version: "1.0"',
            "description: demo",
            "brain:",
            "  model: gemini/gemini-3.8-flash",
            "  instructions_file: instructions.md",
            "harness:",
            "  permissions:",
            "    add: always-allow",
            "tools:",
            "  builtin:",
            "    - add",
            "  mcp: []",
            "  custom: []",
            "",
        ])
    )
    (agent_dir / "instructions.md").write_text("Add numbers when asked.")
    memory = agent_dir / "memory"
    memory.mkdir()
    (memory / "config.yaml").write_text("memory:\n  enabled: false\n")
    agent = RuntimeAgent(AgentConfig.from_path(str(agent_dir)))
    assert agent.graph is not None
    assert type(agent.llm).__name__ == "GeminiChatOpenAI"
    return agent


async def test_runtime_agent_astream_round_trip(monkeypatch, tmp_path):
    with issuing_server("single") as server:
        agent = _runtime_agent(tmp_path, monkeypatch, server)
        try:
            result = await agent.graph.ainvoke(
                {"messages": [HumanMessage(content="1+2?")]},
                {"recursion_limit": 8},
            )
            assert result["messages"][-1].content == "3"
            seen = []
            async for message, _metadata in agent.graph.astream(
                {"messages": [HumanMessage(content="1+2?")]},
                stream_mode="messages",
                config={"recursion_limit": 8},
            ):
                seen.append(message)
            assert any(getattr(message, "content", None) == "3" for message in seen)
        finally:
            agent.close()
        follow_ups = [body for body in server.bodies if any(m.get("role") == "tool" for m in body["messages"])]
        assert len(follow_ups) == 2
        for body in follow_ups:
            assistant_calls = [
                tool_call
                for message in body["messages"]
                if message.get("role") == "assistant"
                for tool_call in (message.get("tool_calls") or [])
            ]
            assert assistant_calls
            assert all(
                tool_call.get("extra_content", {}).get("google", {}).get("thought_signature")
                for tool_call in assistant_calls
            )
