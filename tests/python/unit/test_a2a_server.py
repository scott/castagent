import asyncio
import os
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.runtime import (
    A2AServer,
    StreamHub,
    stream_cursor,
    with_stream_keepalive,
    JSONRPC_PARSE_ERROR,
    JSONRPC_INVALID_REQUEST,
    JSONRPC_METHOD_NOT_FOUND,
    JSONRPC_INVALID_PARAMS,
    JSONRPC_INTERNAL_ERROR,
    JSONRPC_SERVER_ERROR,
)


@pytest.fixture
def temp_agent_dir(tmp_path):
    """Create a temporary agent directory."""
    agent_dir = tmp_path / "a2a-test-agent"
    agent_dir.mkdir()

    agent_yaml = agent_dir / "agent.yaml"
    agent_yaml.write_text("""
name: a2a-test-agent
version: "1.0"
description: "A2A test agent"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow

tools:
  builtin:
    - bash
  mcp: []
  custom: []
""")

    instructions = agent_dir / "instructions.md"
    instructions.write_text("You are an A2A test agent.")

    return str(agent_dir)


@pytest.fixture
def a2a_server(temp_agent_dir):
    """Create an A2A server in echo mode."""
    with patch.dict(os.environ, {}, clear=True):
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent, port=0)
        return server


class TestA2AServerInitialization:
    """Tests for A2AServer initialization."""

    def test_default_initialization(self, temp_agent_dir):
        """Server should initialize with default values."""
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent)

        assert server.agent is not None
        assert server.host == "localhost"
        assert server.port > 0
        assert server.auth_token_hash is None

    def test_custom_host_and_port(self, temp_agent_dir):
        """Server should accept custom host and port."""
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent, host="0.0.0.0", port=9999)

        assert server.host == "0.0.0.0"
        assert server.port == 9999

    def test_port_auto_selection(self, temp_agent_dir):
        """Server should auto-select port when port=0."""
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent, port=0)

        # Should select a valid port
        assert server.port >= 10000
        assert server.port <= 65535


class TestA2AServerPortFinding:
    """Tests for _find_free_port method."""

    def test_find_free_port_returns_valid_port(self, a2a_server):
        """_find_free_port should return a valid port number."""
        port = a2a_server._find_free_port()
        assert isinstance(port, int)
        assert port >= 10000
        assert port <= 65535

    def test_find_free_port_range(self, temp_agent_dir):
        """_find_free_port should search within specified range."""
        config = AgentConfig(temp_agent_dir)
        agent = RuntimeAgent(config)
        server = A2AServer(agent, port=0)

        # Test with custom range
        port = server._find_free_port(start=50000, end=60000)
        assert port >= 50000
        assert port < 60000


class TestA2AServerAuthToken:
    """Tests for auth token handling."""

    def test_set_auth_token(self, a2a_server):
        """set_auth_token should store token hash."""
        a2a_server.set_auth_token("test-token")
        assert a2a_server.auth_token_hash is not None
        assert len(a2a_server.auth_token_hash) == 64  # SHA256 hex

    def test_verify_token_no_auth_set(self, a2a_server):
        """verify_token should return True when no auth set (local mode)."""
        assert a2a_server.verify_token("") is True
        assert a2a_server.verify_token("any-token") is True

    def test_verify_token_correct(self, a2a_server):
        """verify_token should return True for correct token."""
        a2a_server.set_auth_token("secret-token")
        assert a2a_server.verify_token("secret-token") is True

    def test_verify_token_incorrect(self, a2a_server):
        """verify_token should return False for incorrect token."""
        a2a_server.set_auth_token("secret-token")
        assert a2a_server.verify_token("wrong-token") is False
        assert a2a_server.verify_token("") is False

    def test_verify_token_different_hashes(self, a2a_server):
        """Different tokens should produce different hashes."""
        a2a_server.set_auth_token("token1")
        hash1 = a2a_server.auth_token_hash

        a2a_server.set_auth_token("token2")
        hash2 = a2a_server.auth_token_hash

        assert hash1 != hash2


class TestA2AServerValidateRequest:
    """Tests for _validate_request method."""

    def test_valid_request(self, a2a_server):
        """Valid request should return None (no error)."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        error = a2a_server._validate_request(request)
        assert error is None

    def test_invalid_request_not_dict(self, a2a_server):
        """Non-dict request should return error."""
        error = a2a_server._validate_request("not a dict")
        assert error is not None
        assert error["error"]["code"] == JSONRPC_INVALID_REQUEST

    def test_invalid_request_wrong_jsonrpc_version(self, a2a_server):
        """Wrong jsonrpc version should return error."""
        request = {
            "jsonrpc": "1.0",  # Wrong version
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        error = a2a_server._validate_request(request)
        assert error is not None
        assert error["error"]["code"] == JSONRPC_INVALID_REQUEST

    def test_missing_method_field(self, a2a_server):
        """Missing method field should return error."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "params": {},
        }
        error = a2a_server._validate_request(request)
        assert error is not None
        assert error["error"]["code"] == JSONRPC_INVALID_REQUEST

    def test_method_not_string(self, a2a_server):
        """Non-string method should return error."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": 123,  # Not a string
            "params": {},
        }
        error = a2a_server._validate_request(request)
        assert error is not None
        assert error["error"]["code"] == JSONRPC_INVALID_REQUEST


class TestA2AServerMakeErrorResponse:
    """Tests for _make_error_response method."""

    def test_error_response_with_id(self, a2a_server):
        """Error response should include id when provided."""
        response = a2a_server._make_error_response(
            msg_id="123",
            code=-32600,
            message="Invalid request"
        )

        assert response["jsonrpc"] == "2.0"
        assert response["id"] == "123"
        assert response["error"]["code"] == -32600
        assert response["error"]["message"] == "Invalid request"

    def test_error_response_without_id(self, a2a_server):
        """Error response should not include id when None."""
        response = a2a_server._make_error_response(
            msg_id=None,
            code=-32700,
            message="Parse error"
        )

        assert response["jsonrpc"] == "2.0"
        assert "id" not in response
        assert response["error"]["code"] == -32700

    def test_error_response_with_data(self, a2a_server):
        """Error response should include data when provided."""
        response = a2a_server._make_error_response(
            msg_id="456",
            code=-32602,
            message="Invalid params",
            data={"param_name": "value"}
        )

        assert response["error"]["data"] == {"param_name": "value"}


class TestA2AServerHandleRequest:
    """Tests for handle_request method."""

    @pytest.mark.asyncio
    async def test_invalid_json_request(self, a2a_server):
        """Invalid JSON should return parse error."""
        # This is handled by the HTTP layer, but we test the validation
        request = {"invalid": "json"}
        response = await a2a_server.handle_request(request)
        # Non-2.0 version should fail validation
        assert response is not None

    @pytest.mark.asyncio
    async def test_unknown_method_returns_method_not_found(self, a2a_server):
        """Unknown method should return -32601 error."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "unknown/method",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
        assert "not found" in response["error"]["message"]

    @pytest.mark.asyncio
    async def test_missing_method_returns_error(self, a2a_server):
        """Request without method should return error."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INVALID_REQUEST

    @pytest.mark.asyncio
    async def test_handle_request_internal_error(self, a2a_server):
        """handle_request should catch and format internal errors."""
        # Mock the agent to throw
        original_handler = a2a_server._handle_agent_card
        async def failing_handler(msg_id):
            raise Exception("Internal failure")

        a2a_server._handle_agent_card = failing_handler

        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INTERNAL_ERROR

        # Restore
        a2a_server._handle_agent_card = original_handler


class TestA2AServerAgentCard:
    """Tests for A2A agent/card endpoint."""

    @pytest.mark.asyncio
    async def test_agent_card(self, a2a_server):
        """agent/card should return valid AgentCard."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response
        assert response["result"]["name"] == "a2a-test-agent"
        assert response["result"]["protocolVersion"] == "0.2.9"
        assert response["result"]["capabilities"]["chatAgent"] is True

    @pytest.mark.asyncio
    async def test_agent_card_error_handling(self, a2a_server):
        """agent/card should handle errors gracefully."""
        original_handler = a2a_server._handle_agent_card
        async def failing_handler(msg_id):
            raise Exception("Card generation failed")

        a2a_server._handle_agent_card = failing_handler

        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "agent/card",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INTERNAL_ERROR

        # Restore
        a2a_server._handle_agent_card = original_handler


class TestA2AServerMessageSend:
    """Tests for A2A message/send endpoint."""

    @pytest.mark.asyncio
    async def test_message_send_hello(self, a2a_server):
        """message/send should process user message and return response."""
        request = {
            "jsonrpc": "2.0",
            "id": "2",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "hello"}],
                    "messageId": "test-1",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response
        assert "parts" in response["result"]
        assert response["result"]["parts"][0]["kind"] == "text"
        assert "a2a-test-agent" in response["result"]["parts"][0]["text"]

    @pytest.mark.asyncio
    async def test_message_send_tools(self, a2a_server):
        """message/send should respond to tool queries."""
        request = {
            "jsonrpc": "2.0",
            "id": "3",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "what tools do you have?"}],
                    "messageId": "test-2",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "bash" in response["result"]["parts"][0]["text"]

    @pytest.mark.asyncio
    async def test_message_send_empty_text(self, a2a_server):
        """message/send should return error for empty text."""
        request = {
            "jsonrpc": "2.0",
            "id": "4",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": ""}],
                    "messageId": "test-3",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        # Empty text should return an error with invalid params code
        assert "error" in response
        assert response["error"]["code"] == -32602

    @pytest.mark.asyncio
    async def test_message_send_missing_message(self, a2a_server):
        """message/send should return error for missing message."""
        request = {
            "jsonrpc": "2.0",
            "id": "5",
            "method": "message/send",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_message_send_non_object_message(self, a2a_server):
        """message/send should return error for non-object message."""
        request = {
            "jsonrpc": "2.0",
            "id": "6",
            "method": "message/send",
            "params": {
                "message": "not an object",
            },
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_message_send_non_array_parts(self, a2a_server):
        """message/send should return error for non-array parts."""
        request = {
            "jsonrpc": "2.0",
            "id": "7",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": "not an array",
                },
            },
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_message_send_multiple_text_parts(self, a2a_server):
        """message/send should concatenate multiple text parts."""
        request = {
            "jsonrpc": "2.0",
            "id": "8",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [
                        {"kind": "text", "text": "Hello "},
                        {"kind": "text", "text": "World"},
                    ],
                    "messageId": "test-4",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response

    @pytest.mark.asyncio
    async def test_message_send_non_text_parts(self, a2a_server):
        """message/send should ignore non-text parts."""
        request = {
            "jsonrpc": "2.0",
            "id": "9",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [
                        {"kind": "text", "text": "hello"},
                        {"kind": "image", "url": "http://example.com/image.png"},
                    ],
                    "messageId": "test-5",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response


class TestA2AServerTaskGet:
    """Tests for A2A task/get endpoint."""

    @pytest.mark.asyncio
    async def test_task_get(self, a2a_server):
        """task/get should return completed status."""
        request = {
            "jsonrpc": "2.0",
            "id": "5",
            "method": "task/get",
            "params": {"taskId": "task-1"},
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert response["result"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_task_get_with_id(self, a2a_server):
        """task/get should include the request id."""
        request = {
            "jsonrpc": "2.0",
            "id": "my-task-id",
            "method": "task/get",
            "params": {"taskId": "task-1"},
        }
        response = await a2a_server.handle_request(request)

        assert response["id"] == "my-task-id"


class TestA2AServerStreaming:
    """Tests for streaming request handling."""

    @pytest.mark.asyncio
    async def test_streaming_request_unsupported_method(self, a2a_server):
        """Streaming should return error for non-message/send methods."""
        request = {
            "jsonrpc": "2.0",
            "id": "stream-1",
            "method": "agent/card",
            "params": {},
        }

        chunks = []
        async for chunk in a2a_server.handle_streaming_request(request):
            chunks.append(chunk)

        assert len(chunks) == 2  # Error response and DONE
        assert "[DONE]" in chunks[1]
        assert "not supported" in chunks[0]

    @pytest.mark.asyncio
    async def test_streaming_request_empty_text(self, a2a_server):
        """Streaming should return error for empty text."""
        request = {
            "jsonrpc": "2.0",
            "id": "stream-2",
            "method": "message/send",
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": ""}],
                }
            },
        }

        chunks = []
        async for chunk in a2a_server.handle_streaming_request(request):
            chunks.append(chunk)

        assert len(chunks) == 2  # Error response and DONE
        assert "[DONE]" in chunks[1]

    @pytest.mark.asyncio
    async def test_streaming_request_echo_mode(self, a2a_server):
        """Streaming should work in echo mode (no LLM)."""
        request = {
            "jsonrpc": "2.0",
            "id": "stream-3",
            "method": "message/send",
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": "hello"}],
                }
            },
        }

        chunks = []
        async for chunk in a2a_server.handle_streaming_request(request):
            chunks.append(chunk)

        # Should have chunks and DONE
        assert len(chunks) > 0
        assert any("[DONE]" in c for c in chunks)

    @pytest.mark.asyncio
    async def test_streaming_response_format(self, a2a_server):
        """Streaming should yield SSE formatted events."""
        request = {
            "jsonrpc": "2.0",
            "id": "stream-4",
            "method": "message/send",
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": "hello"}],
                }
            },
        }

        async for chunk in a2a_server.handle_streaming_request(request):
            if not chunk.startswith("data:"):
                continue
            # Should be JSON data
            import json
            data = json.loads(chunk.replace("data: ", "").replace("data:", ""))
            if "result" in data or "error" in data:
                assert data["jsonrpc"] == "2.0"
                break


class TestStreamKeepalive:
    """Idle proxies still need a comment while a one-shot stream is quiet."""

    @pytest.mark.asyncio
    async def test_emits_a_comment_while_the_agent_is_quiet(self):
        async def slow():
            await asyncio.sleep(0.15)
            yield "data: hi\n\n"

        chunks = []
        async for chunk in with_stream_keepalive(slow(), interval=0.05, keepalive=": keepalive\n\n"):
            chunks.append(chunk)

        assert chunks[-1] == "data: hi\n\n"
        assert any(chunk == ": keepalive\n\n" for chunk in chunks[:-1])

    @pytest.mark.asyncio
    async def test_propagates_agent_errors(self):
        async def broken():
            await asyncio.sleep(0.01)
            raise RuntimeError("boom")
            yield "unused"

        with pytest.raises(RuntimeError, match="boom"):
            async for _chunk in with_stream_keepalive(broken(), interval=1, keepalive=": keepalive\n\n"):
                pass

    @pytest.mark.asyncio
    async def test_stops_the_agent_when_the_client_disconnects(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def forever():
            started.set()
            try:
                await asyncio.sleep(30)
                yield "data: late\n\n"
            except asyncio.CancelledError:
                cancelled.set()
                raise

        generator = with_stream_keepalive(forever(), interval=0.05, keepalive=": keepalive\n\n")
        first = await generator.__anext__()
        assert first == ": keepalive\n\n"
        await generator.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=1)


class TestStreamResume:
    """The MicroVM edge closes a response about 15 seconds after it starts."""

    def test_cursor_reads_a_stream_id_and_offset(self):
        stream_id, offset = stream_cursor({
            "metadata": {"streamId": "msg_1", "streamOffset": 4, "sessionId": "s"},
        })
        assert stream_id == "msg_1"
        assert offset == 4

    def test_cursor_ignores_a_missing_or_invalid_id(self):
        assert stream_cursor({"metadata": {"sessionId": "s"}}) == (None, 0)
        assert stream_cursor({"metadata": {"streamId": "has space", "streamOffset": 3}}) == (None, 0)
        assert stream_cursor({"metadata": {"streamId": "ok", "streamOffset": True}}) == ("ok", 0)
        assert stream_cursor("nope") == (None, 0)

    @pytest.mark.asyncio
    async def test_producer_survives_the_follower_closing(self):
        calls = 0
        release = asyncio.Event()

        async def events():
            nonlocal calls
            calls += 1
            yield "data: one\n\n"
            await release.wait()
            yield "data: two\n\n"
            yield "data: [DONE]\n\n"

        hub = StreamHub()
        gen = hub.follow("s1", 0, events, interval=0.05, keepalive=": keepalive\n\n")
        marker = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert marker == ": cast-stream s1\n\n"
        first = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert first == "data: one\n\n"
        await gen.aclose()

        assert calls == 1
        run = hub._runs["s1"]
        assert run.producer is not None
        assert not run.producer.done()

        release.set()
        tail = []
        async for chunk in hub.follow("s1", 1, events, interval=0.05, keepalive=": keepalive\n\n"):
            if chunk.startswith(": "):
                continue
            tail.append(chunk)
        assert tail == ["data: two\n\n", "data: [DONE]\n\n"]
        assert calls == 1

    @pytest.mark.asyncio
    async def test_follower_sends_keepalive_while_the_reply_is_quiet(self):
        release = asyncio.Event()

        async def events():
            yield "data: one\n\n"
            await release.wait()
            yield "data: [DONE]\n\n"

        hub = StreamHub()
        gen = hub.follow("s", 1, events, interval=0.05, keepalive=": keepalive\n\n")
        marker = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert marker == ": cast-stream s\n\n"
        nxt = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert nxt == ": keepalive\n\n"
        release.set()
        rest = []
        async for chunk in gen:
            if chunk.startswith(": "):
                continue
            rest.append(chunk)
        assert rest == ["data: [DONE]\n\n"]

    @pytest.mark.asyncio
    async def test_finished_run_is_dropped_after_the_ttl(self):
        calls = 0

        async def events():
            nonlocal calls
            calls += 1
            yield f"data: {calls}\n\n"
            yield "data: [DONE]\n\n"

        hub = StreamHub(ttl=0.05)
        async for _chunk in hub.follow("s", 0, events, interval=1, keepalive=": k\n\n"):
            pass
        assert calls == 1
        await asyncio.sleep(0.12)
        seen = []
        async for chunk in hub.follow("s", 0, events, interval=1, keepalive=": k\n\n"):
            seen.append(chunk)
        assert calls == 2
        assert "data: 2\n\n" in seen

    @pytest.mark.asyncio
    async def test_same_stream_id_does_not_start_a_second_reply(self, a2a_server):
        calls = 0
        release = asyncio.Event()

        async def fake(_request):
            nonlocal calls
            calls += 1
            yield 'data: {"jsonrpc":"2.0","result":{"parts":[{"kind":"text","text":"hi"}]}}\n\n'
            await release.wait()
            yield "data: [DONE]\n\n"

        a2a_server.handle_streaming_request = fake
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {
                "message": {"parts": [{"kind": "text", "text": "hello"}]},
                "metadata": {"streamId": "s1", "streamOffset": 0},
            },
        }
        gen = a2a_server.iter_chat_stream(request)
        first = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert first == ": cast-stream s1\n\n"
        data = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert '"hi"' in data
        await gen.aclose()

        request["params"]["metadata"]["streamOffset"] = 1
        tail = []
        release.set()
        async for chunk in a2a_server.iter_chat_stream(request):
            if chunk.startswith(": "):
                continue
            tail.append(chunk)
        assert calls == 1
        assert tail == ["data: [DONE]\n\n"]

    @pytest.mark.asyncio
    async def test_missing_stream_id_stops_when_the_client_leaves(self, a2a_server):
        cancelled = asyncio.Event()

        async def fake(_request):
            try:
                await asyncio.sleep(30)
                yield "data: late\n\n"
            except asyncio.CancelledError:
                cancelled.set()
                raise

        a2a_server.handle_streaming_request = fake
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {"message": {"parts": [{"kind": "text", "text": "hello"}]}},
        }
        gen = a2a_server.iter_chat_stream(request, interval=0.05, keepalive=": keepalive\n\n")
        first = await asyncio.wait_for(gen.__anext__(), timeout=1)
        assert first == ": keepalive\n\n"
        await gen.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=1)


class TestA2AServerErrors:
    """Tests for A2A error handling."""

    @pytest.mark.asyncio
    async def test_unknown_method(self, a2a_server):
        """Unknown method should return error."""
        request = {
            "jsonrpc": "2.0",
            "id": "6",
            "method": "unknown/method",
            "params": {},
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == -32601

    @pytest.mark.asyncio
    async def test_port_selection(self, a2a_server):
        """Server should select a valid port."""
        assert a2a_server.port > 0
        assert a2a_server.port <= 65535

    def test_auth_token_verification(self, a2a_server):
        """Token verification should work correctly."""
        # Local mode - no auth required
        assert a2a_server.verify_token("") is True
        assert a2a_server.verify_token("any-token") is True

        # Set auth token
        a2a_server.set_auth_token("secret-token")
        assert a2a_server.verify_token("secret-token") is True
        assert a2a_server.verify_token("wrong-token") is False


class TestA2AServerJsonRpcErrorCodes:
    """Tests for JSON-RPC error codes."""

    def test_error_codes_are_defined(self):
        """All standard JSON-RPC error codes should be defined."""
        assert JSONRPC_PARSE_ERROR == -32700
        assert JSONRPC_INVALID_REQUEST == -32600
        assert JSONRPC_METHOD_NOT_FOUND == -32601
        assert JSONRPC_INVALID_PARAMS == -32602
        assert JSONRPC_INTERNAL_ERROR == -32603
        assert JSONRPC_SERVER_ERROR == -32000

    def test_error_codes_are_negative(self):
        """All JSON-RPC error codes should be negative."""
        assert JSONRPC_PARSE_ERROR < 0
        assert JSONRPC_INVALID_REQUEST < 0
        assert JSONRPC_METHOD_NOT_FOUND < 0
        assert JSONRPC_INVALID_PARAMS < 0
        assert JSONRPC_INTERNAL_ERROR < 0

    def test_server_error_is_custom_range(self):
        """Server error (-32000) should be in custom error range."""
        assert JSONRPC_SERVER_ERROR == -32000
        assert JSONRPC_SERVER_ERROR >= -32099
        assert JSONRPC_SERVER_ERROR <= -32000


class TestA2AServerInternalErrorHandling:
    """Tests for internal error handling in handle_request."""

    @pytest.mark.asyncio
    async def test_handles_message_send_processing_error(self, a2a_server):
        """handle_request should catch processing errors in message/send."""
        # Mock agent.process_message to throw
        original_process = a2a_server.agent.process_message
        a2a_server.agent.process_message = AsyncMock(side_effect=Exception("Processing failed"))

        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": "hello"}],
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert "error" in response
        assert response["error"]["code"] == JSONRPC_SERVER_ERROR
        assert "Processing failed" in response["error"]["message"]

        # Restore
        a2a_server.agent.process_message = original_process


class TestA2AServerMessageSendEdgeCases:
    """Tests for edge cases in message/send handling."""

    @pytest.mark.asyncio
    async def test_message_send_with_extra_fields(self, a2a_server):
        """message/send should handle messages with extra fields."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "hello"}],
                    "messageId": "test-1",
                    "extra": "ignored",
                }
            },
        }
        response = await a2a_server.handle_request(request)

        assert response["jsonrpc"] == "2.0"
        assert "result" in response

    @pytest.mark.asyncio
    async def test_message_send_parts_with_non_dict_items(self, a2a_server):
        """message/send should handle non-dict parts gracefully."""
        request = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {
                "message": {
                    "parts": [
                        {"kind": "text", "text": "hello"},
                        "not a dict",
                        None,
                    ],
                }
            },
        }
        response = await a2a_server.handle_request(request)

        # Should still work, ignoring non-dict parts
        assert response["jsonrpc"] == "2.0"