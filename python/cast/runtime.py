import argparse
import asyncio
import json
import os
import re
import socket
import sys
import time
import traceback
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional

from .agent.base import AgentConfig
from .agent.runtime import RuntimeAgent
from .harness.permissions import PermissionPrompt

# Proxies that idle out a quiet response still need bytes on the wire.
# The MicroVM edge is different: it closes the response about 15 seconds
# after the request starts, even while these comments are arriving. A client
# that sends metadata.streamId keeps the reply running and reconnects with
# metadata.streamOffset. A request with no stream id still uses the one-shot
# wrapper below, which stops the reply when that connection closes.
STREAM_KEEPALIVE_INTERVAL = 5
STREAM_KEEPALIVE = ": " + ("keepalive " * 400) + "\n\n"
STREAM_RESUME_TTL = 120
_STREAM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


async def with_stream_keepalive(
    events: AsyncGenerator[str, None],
    interval: float = STREAM_KEEPALIVE_INTERVAL,
    keepalive: str = STREAM_KEEPALIVE,
) -> AsyncGenerator[str, None]:
    """Yield events from `events`, and a comment when it is quiet."""
    queue: asyncio.Queue = asyncio.Queue()

    async def pump() -> None:
        try:
            async for event in events:
                await queue.put(("event", event))
        except Exception as exc:
            await queue.put(("error", exc))
        else:
            await queue.put(("end", None))

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                kind, payload = await asyncio.wait_for(queue.get(), interval)
            except asyncio.TimeoutError:
                yield keepalive
                continue
            if kind == "end":
                break
            if kind == "error":
                raise payload
            yield payload
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


def stream_resume_marker(stream_id: str) -> str:
    """SSE comment that tells the client this reply can be resumed."""
    return f": cast-stream {stream_id}\n\n"


def stream_cursor(params: Any) -> tuple[Optional[str], int]:
    """Resume id and data-event offset from message/send metadata.

    A missing or invalid id keeps the one-shot stream. The offset counts
    stored `data:` events, not keepalive comments.
    """
    if not isinstance(params, dict):
        return None, 0
    metadata = params.get("metadata")
    if not isinstance(metadata, dict):
        return None, 0
    raw_id = metadata.get("streamId")
    if not isinstance(raw_id, str) or _STREAM_ID_RE.fullmatch(raw_id) is None:
        return None, 0
    raw_offset = metadata.get("streamOffset", 0)
    if isinstance(raw_offset, bool) or not isinstance(raw_offset, (int, float)):
        offset = 0
    else:
        offset = int(raw_offset)
    if offset < 0:
        offset = 0
    return raw_id, offset


class _StreamRun:
    def __init__(self) -> None:
        self.events: List[str] = []
        self.done = False
        self.error: Optional[BaseException] = None
        self.changed = asyncio.Event()
        self.generation = 0
        self.producer: Optional[asyncio.Task] = None
        self.finished_at: Optional[float] = None


class StreamHub:
    """Keep one chat reply running across HTTP connections.

    The MicroVM edge closes each response on a wall clock. Followers come
    and go. Closing one does not cancel the producer. A second follow with
    the same id yields only the events after `offset`.
    """

    def __init__(self, ttl: float = STREAM_RESUME_TTL) -> None:
        self._ttl = ttl
        self._runs: Dict[str, _StreamRun] = {}

    def _purge(self) -> None:
        now = time.monotonic()
        expired = [
            key
            for key, run in self._runs.items()
            if run.done and run.finished_at is not None and now - run.finished_at >= self._ttl
        ]
        for key in expired:
            self._runs.pop(key, None)

    async def _produce(self, run: _StreamRun, events: AsyncGenerator[str, None]) -> None:
        try:
            async for event in events:
                run.events.append(event)
                run.generation += 1
                run.changed.set()
        except asyncio.CancelledError:
            run.error = asyncio.CancelledError()
            raise
        except Exception as exc:
            run.error = exc
        finally:
            run.done = True
            run.finished_at = time.monotonic()
            run.generation += 1
            run.changed.set()

    async def follow(
        self,
        stream_id: str,
        offset: int,
        events_factory: Callable[[], AsyncGenerator[str, None]],
        interval: float = STREAM_KEEPALIVE_INTERVAL,
        keepalive: str = STREAM_KEEPALIVE,
    ) -> AsyncGenerator[str, None]:
        """Yield the resume marker, then stored events from `offset`.

        A quiet wait yields `keepalive` and leaves the producer running.
        """
        self._purge()
        run = self._runs.get(stream_id)
        if run is None:
            run = _StreamRun()
            self._runs[stream_id] = run
            run.producer = asyncio.create_task(self._produce(run, events_factory()))

        index = offset
        # The marker is not a stored event, so it does not move the offset.
        yield stream_resume_marker(stream_id)
        while True:
            if index < len(run.events):
                event = run.events[index]
                index += 1
                yield event
                continue
            if run.error is not None:
                raise run.error
            if run.done:
                return
            seen = run.generation
            run.changed.clear()
            if (
                run.generation != seen
                or index < len(run.events)
                or run.done
                or run.error is not None
            ):
                continue
            try:
                await asyncio.wait_for(run.changed.wait(), interval)
            except TimeoutError:
                yield keepalive


def request_auth_error(auth_token_hash: Optional[str], headers) -> Optional[str]:
    """Return an error message when a request must be rejected, else None.

    A present X-Cast-Authorization header is the agent token. Authorization
    is only checked when that header is absent.
    """
    if not auth_token_hash:
        return None

    def bearer(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = str(value)
        if text == "":
            return ""
        if text.startswith("Bearer "):
            return text[7:]
        return None

    cast_header = headers.get("x-cast-authorization")
    if cast_header is None:
        cast_header = headers.get("X-Cast-Authorization")
    if cast_header is not None and str(cast_header) != "":
        token = bearer(str(cast_header))
        if not token:
            return "Authentication required"
        import hashlib
        if hashlib.sha256(token.encode()).hexdigest() != auth_token_hash:
            return "Invalid auth token"
        return None

    auth_header = headers.get("authorization")
    if auth_header is None:
        auth_header = headers.get("Authorization", "")
    token = bearer(str(auth_header or ""))
    if not token:
        return "Authentication required"
    import hashlib
    if hashlib.sha256(token.encode()).hexdigest() != auth_token_hash:
        return "Invalid auth token"
    return None


def session_context_from_params(
    params: Dict[str, Any],
) -> tuple[Optional[str], Optional[List[Dict[str, Any]]]]:
    """Session id and one-time transcript from a message/send.

    A missing id is not a new session. Callers keep the legacy shared
    history so an old client that omits the id still appends to it.
    """
    if not isinstance(params, dict):
        return None, None
    metadata = params.get("metadata")
    if not isinstance(metadata, dict):
        return None, None
    raw_id = metadata.get("sessionId")
    if raw_id is None:
        raw_id = metadata.get("session_id")
    session_id = raw_id.strip() if isinstance(raw_id, str) else None
    if not session_id:
        session_id = None
    history = metadata.get("history")
    if not isinstance(history, list):
        history = None
    return session_id, history


# JSON-RPC 2.0 error codes
JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603
JSONRPC_SERVER_ERROR = -32000


class A2AServer:
    """A2A HTTP server for Runtime Agent."""

    def __init__(self, agent: RuntimeAgent, host: str = "localhost", port: int = 0):
        self.agent = agent
        self.host = host
        self.port = port or self._find_free_port()
        self.auth_token_hash: Optional[str] = None
        self.stream_hub = StreamHub()

    def _find_free_port(self, start: int = 10000, end: int = 65535) -> int:
        for port in range(start, end):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex((self.host, port)) != 0:
                    return port
        raise RuntimeError("No free ports available")

    def set_auth_token(self, token: str):
        """Set auth token for deployed mode."""
        import hashlib
        self.auth_token_hash = hashlib.sha256(token.encode()).hexdigest()

    def verify_token(self, token: str) -> bool:
        if self.auth_token_hash is None:
            return True  # Local mode, no auth required
        import hashlib
        return hashlib.sha256(token.encode()).hexdigest() == self.auth_token_hash

    def authorize_request(self, headers) -> Optional[str]:
        """Return an error message when the request is rejected, else None.

        X-Cast-Authorization wins when it is present so a platform edge can
        occupy Authorization without replacing the agent token.
        """
        return request_auth_error(self.auth_token_hash, headers)

    def _make_error_response(self, msg_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        response = {"jsonrpc": "2.0", "error": error}
        if msg_id is not None:
            response["id"] = msg_id
        return response

    def _validate_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Validate JSON-RPC request structure. Returns error response if invalid."""
        if not isinstance(request, dict):
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Request must be a JSON object")
        if request.get("jsonrpc") != "2.0":
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Invalid jsonrpc version")
        if "method" not in request:
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "Missing 'method' field")
        if not isinstance(request["method"], str):
            return self._make_error_response(None, JSONRPC_INVALID_REQUEST, "'method' must be a string")
        return None

    async def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        # Validate request structure
        validation_error = self._validate_request(request)
        if validation_error:
            return validation_error

        method = request.get("method")
        params = request.get("params", {})
        msg_id = request.get("id")

        try:
            if method == "agent/card":
                return await self._handle_agent_card(msg_id)
            elif method == "message/send":
                return await self._handle_message_send(msg_id, params)
            elif method == "permission/respond":
                return self._handle_permission_respond(msg_id, params)
            elif method == "task/get":
                return await self._handle_task_get(msg_id, params)
            else:
                return self._make_error_response(
                    msg_id, JSONRPC_METHOD_NOT_FOUND, f"Method '{method}' not found"
                )
        except Exception as e:
            error_msg = f"Internal error: {str(e)}"
            print(f"Error handling {method}: {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return self._make_error_response(
                msg_id, JSONRPC_INTERNAL_ERROR, error_msg
            )

    async def _handle_agent_card(self, msg_id: Any) -> Dict[str, Any]:
        try:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": self.agent.get_agent_card(),
            }
        except Exception as e:
            print(f"Error getting agent card: {e}", file=sys.stderr)
            return self._make_error_response(msg_id, JSONRPC_INTERNAL_ERROR, f"Failed to get agent card: {e}")

    async def _handle_message_send(self, msg_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        message = params.get("message", {})
        if not isinstance(message, dict):
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "'message' must be an object")

        parts = message.get("parts", [])
        if not isinstance(parts, list):
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "'message.parts' must be an array")

        # Extract text from parts
        text = ""
        for part in parts:
            if isinstance(part, dict) and part.get("kind") == "text":
                text += part.get("text", "")

        if not text.strip():
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "No text content found in message")

        # Process with agent. The client session id selects that
        # connection's model context. History is the saved transcript,
        # sent once on resume or fork.
        session_id, history = session_context_from_params(params)
        try:
            response_text = await self.agent.process_message(
                text, session_id=session_id, history=history,
            )
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "parts": [{"kind": "text", "text": response_text}],
                },
            }
        except Exception as e:
            error_msg = f"Tool execution failed: {str(e)}"
            print(f"Error processing message: {error_msg}", file=sys.stderr)
            traceback.print_exc()
            return self._make_error_response(
                msg_id, JSONRPC_SERVER_ERROR, error_msg
            )

    def _handle_permission_respond(self, msg_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        """Resolve an ask prompt. approved must be a boolean."""
        if not isinstance(params, dict):
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "'params' must be an object")
        request_id = params.get("id")
        approved = params.get("approved")
        if not isinstance(request_id, str) or not request_id.strip():
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "'id' must be a string")
        if not isinstance(approved, bool):
            return self._make_error_response(msg_id, JSONRPC_INVALID_PARAMS, "'approved' must be a boolean")
        broker = getattr(self.agent, "approval_broker", None)
        if broker is None or not broker.respond(request_id, approved):
            return self._make_error_response(
                msg_id, JSONRPC_INVALID_PARAMS, "No pending permission request"
            )
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"ok": True},
        }

    async def _handle_task_get(self, msg_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"status": "completed"},
        }

    async def handle_streaming_request(self, request: Dict[str, Any]) -> AsyncGenerator[str, None]:
        """Handle a streaming request and yield SSE formatted events."""
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")

        if method != "message/send":
            error_response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": JSONRPC_METHOD_NOT_FOUND, "message": f"Method '{method}' not supported for streaming"},
            }
            yield f"data: {json.dumps(error_response)}\n\n"
            yield "data: [DONE]\n\n"
            return

        message = params.get("message", {})
        parts = message.get("parts", [])

        # Extract text from parts
        text = ""
        for part in parts:
            if isinstance(part, dict) and part.get("kind") == "text":
                text += part.get("text", "")

        if not text.strip():
            error_response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": JSONRPC_INVALID_PARAMS, "message": "No text content found in message"},
            }
            yield f"data: {json.dumps(error_response)}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Stream tokens from agent. Same session pairing as message/send.
        session_id, history = session_context_from_params(params)
        try:
            async for chunk in self.agent.process_message_stream(
                text, session_id=session_id, history=history,
            ):
                if isinstance(chunk, PermissionPrompt):
                    event = {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "parts": [],
                            "metadata": {"permissionRequest": chunk.request},
                        },
                    }
                    yield f"data: {json.dumps(event)}\n\n"
                    continue
                event = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "parts": [{"kind": "text", "text": chunk}],
                    },
                }
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": JSONRPC_SERVER_ERROR, "message": f"Streaming error: {str(e)}"},
            }
            yield f"data: {json.dumps(error_response)}\n\n"

        yield "data: [DONE]\n\n"

    def iter_chat_stream(
        self,
        request: Dict[str, Any],
        interval: float = STREAM_KEEPALIVE_INTERVAL,
        keepalive: str = STREAM_KEEPALIVE,
    ) -> AsyncGenerator[str, None]:
        """SSE body for one chat POST.

        A stream id detaches the reply from this connection. Without one,
        the body is the one-shot keepalive wrapper.
        """
        params = request.get("params") if isinstance(request, dict) else None
        stream_id, offset = stream_cursor(params)
        if not stream_id:
            return with_stream_keepalive(
                self.handle_streaming_request(request),
                interval=interval,
                keepalive=keepalive,
            )

        def start() -> AsyncGenerator[str, None]:
            return self.handle_streaming_request(request)

        return self.stream_hub.follow(
            stream_id,
            offset,
            start,
            interval=interval,
            keepalive=keepalive,
        )

    async def run(self):
        try:
            from starlette.applications import Starlette
            from starlette.requests import Request
            from starlette.responses import JSONResponse, StreamingResponse
            from starlette.routing import Route

            async def handle_http(request: Request):
                auth_error = self.authorize_request(request.headers)
                if auth_error:
                    return JSONResponse({
                        "jsonrpc": "2.0",
                        "error": {"code": JSONRPC_SERVER_ERROR, "message": auth_error},
                    }, status_code=401)

                body = await request.body()
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    print(f"Invalid JSON request: {e}", file=sys.stderr)
                    return JSONResponse({
                        "jsonrpc": "2.0",
                        "error": {"code": JSONRPC_PARSE_ERROR, "message": f"Parse error: {e}"},
                    }, status_code=400)

                accept = request.headers.get("accept", "")

                # Check if client requests streaming
                if "text/event-stream" in accept:
                    return StreamingResponse(
                        self.iter_chat_stream(data),
                        media_type="text/event-stream",
                        headers={
                            "Cache-Control": "no-cache",
                            "X-Accel-Buffering": "no",
                        },
                    )

                response = await self.handle_request(data)
                # Return error status codes for JSON-RPC errors
                if "error" in response:
                    status_code = 400 if response["error"]["code"] >= -32603 else 200
                    return JSONResponse(response, status_code=status_code)
                return JSONResponse(response)

            routes = [
                Route("/", handle_http, methods=["POST"]),
            ]

            app = Starlette(routes=routes)

            import uvicorn
            config = uvicorn.Config(app, host=self.host, port=self.port, log_level="warning", access_log=False)
            server = uvicorn.Server(config)

            print(f"Agent ready on port {self.port}", flush=True)
            await server.serve()

        except ImportError:
            # Fallback simple HTTP server
            await self._run_simple_server()

    async def _run_simple_server(self):
        from http.server import HTTPServer, BaseHTTPRequestHandler
        import threading

        class Handler(BaseHTTPRequestHandler):
            # Store reference to server for auth checking
            server_ref = None

            def do_POST(self):
                if self.server_ref:
                    auth_error = self.server_ref.authorize_request(self.headers)
                    if auth_error:
                        self.send_response(401)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({
                            "jsonrpc": "2.0",
                            "error": {"code": JSONRPC_SERVER_ERROR, "message": auth_error},
                        }).encode())
                        return

                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)

                try:
                    request = json.loads(body)
                except json.JSONDecodeError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "jsonrpc": "2.0",
                        "error": {"code": JSONRPC_PARSE_ERROR, "message": f"Parse error: {e}"},
                    }).encode())
                    return

                # Run async handler
                try:
                    response = asyncio.run(self.handle_request(request))
                except Exception as e:
                    print(f"Error in request handler: {e}", file=sys.stderr)
                    response = {
                        "jsonrpc": "2.0",
                        "error": {"code": JSONRPC_INTERNAL_ERROR, "message": f"Internal error: {e}"},
                    }

                status_code = 400 if "error" in response else 200
                self.send_response(status_code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())

            def log_message(self, format, *args):
                pass

        # Set server reference for auth checking
        Handler.server_ref = self

        server = HTTPServer((self.host, self.port), Handler)
        print(f"Agent ready on port {self.port}", flush=True)

        thread = threading.Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        while True:
            await asyncio.sleep(1)


def configure_runtime_env(agent_path: str) -> str:
    """Set CAST_AGENT_PATH to the agent directory the runtime loaded."""
    root = os.path.abspath(agent_path)
    os.environ["CAST_AGENT_PATH"] = root
    return root


async def main():
    parser = argparse.ArgumentParser(description="Cast Runtime Agent")
    parser.add_argument("--agent-path", required=True, help="Path to agent directory")
    parser.add_argument("--port", type=int, default=0, help="Port for A2A server")
    parser.add_argument("--host", default="localhost", help="Host to bind the A2A server to")
    parser.add_argument("--auth-token", help="Auth token for deployed mode")
    args = parser.parse_args()

    # Validate agent path
    if not os.path.exists(args.agent_path):
        print(f"Error: Agent path does not exist: {args.agent_path}", file=sys.stderr)
        sys.exit(1)

    # Tools resolve relative paths against this directory. cast dev sets
    # the same variable; --agent-path wins when the parent omitted it.
    configure_runtime_env(args.agent_path)

    # Load agent config
    try:
        config = AgentConfig.from_path(args.agent_path)
    except Exception as e:
        print(f"Error loading agent config: {e}", file=sys.stderr)
        sys.exit(1)

    agent = RuntimeAgent(config, agent_path=args.agent_path)

    # Start A2A server
    server = A2AServer(agent, host=args.host, port=args.port)

    # Set auth token if provided via CLI or environment variable
    auth_token = args.auth_token or os.environ.get('AUTH_TOKEN')
    if auth_token:
        server.set_auth_token(auth_token)

    await server.run()


def run():
    asyncio.run(main())


if __name__ == "__main__":
    run()
