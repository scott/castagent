import argparse
import asyncio
import json
import os
import socket
import sys
import traceback
from typing import Any, AsyncGenerator, Dict, List, Optional

from .agent.base import AgentConfig
from .agent.runtime import RuntimeAgent

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

        # Process with agent
        try:
            response_text = await self.agent.process_message(text)
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

        # Stream tokens from agent
        try:
            async for chunk in self.agent.process_message_stream(text):
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

    async def run(self):
        try:
            from starlette.applications import Starlette
            from starlette.requests import Request
            from starlette.responses import JSONResponse, StreamingResponse
            from starlette.routing import Route

            async def handle_http(request: Request):
                # Verify auth token if configured
                if self.auth_token_hash:
                    auth_header = request.headers.get("authorization", "")
                    if not auth_header.startswith("Bearer "):
                        return JSONResponse({
                            "jsonrpc": "2.0",
                            "error": {"code": JSONRPC_SERVER_ERROR, "message": "Authentication required"},
                        }, status_code=401)

                    token = auth_header[7:]  # Strip "Bearer " prefix
                    if not self.verify_token(token):
                        return JSONResponse({
                            "jsonrpc": "2.0",
                            "error": {"code": JSONRPC_SERVER_ERROR, "message": "Invalid auth token"},
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
                    async def event_generator():
                        async for event in self.handle_streaming_request(data):
                            yield event

                    return StreamingResponse(
                        event_generator(),
                        media_type="text/event-stream",
                        headers={
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
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
                # Verify auth token if configured
                if self.server_ref and self.server_ref.auth_token_hash:
                    auth_header = self.headers.get('Authorization', '')
                    if not auth_header.startswith('Bearer '):
                        self.send_response(401)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({
                            "jsonrpc": "2.0",
                            "error": {"code": JSONRPC_SERVER_ERROR, "message": "Authentication required"},
                        }).encode())
                        return

                    token = auth_header[7:]  # Strip "Bearer " prefix
                    if not self.server_ref.verify_token(token):
                        self.send_response(401)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({
                            "jsonrpc": "2.0",
                            "error": {"code": JSONRPC_SERVER_ERROR, "message": "Invalid auth token"},
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
