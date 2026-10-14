"""Stdio client for one MCP server process.

The runtime speaks newline-delimited JSON-RPC, and also accepts
Content-Length framing from servers that still use it. The process is
kept open so later tool calls reuse the same session.
"""

from __future__ import annotations

import atexit
import json
import subprocess
import threading
from typing import IO, Any

# Handshake can include a cold `npx` download. Later calls stay shorter.
DEFAULT_TIMEOUT = 120.0
_MAX_MESSAGE_BYTES = 8_000_000
_OPEN_LOCK = threading.Lock()
_OPEN_SESSIONS: list[McpStdioSession] = []


def _track(session: McpStdioSession) -> None:
    with _OPEN_LOCK:
        _OPEN_SESSIONS.append(session)


def _untrack(session: McpStdioSession) -> None:
    with _OPEN_LOCK:
        try:
            _OPEN_SESSIONS.remove(session)
        except ValueError:
            pass


def _shutdown_open_sessions() -> None:
    with _OPEN_LOCK:
        sessions = list(_OPEN_SESSIONS)
    for session in sessions:
        session.close()


atexit.register(_shutdown_open_sessions)


class McpError(Exception):
    """The MCP server could not complete a request."""


class McpStdioSession:
    """One MCP server subprocess and its JSON-RPC session."""

    def __init__(
        self,
        name: str,
        argv: list[str],
        env: dict[str, str],
        cwd: str,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.name = name
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.timeout = timeout
        self.returncode: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._stdout: IO[bytes] | None = None
        self._pending: dict[Any, tuple[threading.Event, dict[str, Any]]] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._closed = False
        self._ids = 0

    def is_running(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    def start(self) -> list[dict[str, Any]]:
        """Spawn the server, complete initialize, and return tools/list."""
        self._spawn()
        try:
            self._initialize()
            return self.list_tools()
        except Exception:
            self.close()
            raise

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(20):
            params: dict[str, Any] = {}
            if cursor:
                params["cursor"] = cursor
            result = self.request("tools/list", params)
            if not isinstance(result, dict):
                raise McpError(f"MCP server '{self.name}' returned an invalid tools/list result")
            batch = result.get("tools") or []
            if not isinstance(batch, list):
                raise McpError(f"MCP server '{self.name}' tools/list result has no tools array")
            for item in batch:
                if isinstance(item, dict):
                    tools.append(item)
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                return tools
            cursor = next_cursor
        raise McpError(f"MCP server '{self.name}' tools/list did not finish")

    def call_tool(self, name: str, arguments: dict[str, Any] | None) -> Any:
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def request(self, method: str, params: dict[str, Any] | None) -> Any:
        if self._closed or not self.is_running():
            raise McpError(f"MCP server '{self.name}' is not running")
        req_id = self._next_id()
        event = threading.Event()
        holder: dict[str, Any] = {}
        with self._pending_lock:
            self._pending[req_id] = (event, holder)
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            self._write(message)
        except Exception:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise
        if not event.wait(self.timeout):
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise McpError(f"MCP server '{self.name}' timed out during {method}")
        if "error" in holder:
            error = holder["error"]
            detail = error.get("message") if isinstance(error, dict) else str(error)
            raise McpError(f"MCP server '{self.name}' {method} failed: {detail}")
        return holder.get("result")

    def close(self) -> None:
        """Stop the server process. A second call does nothing."""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            _untrack(self)
            proc = self._proc
            if proc is None:
                return
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except OSError as exc:
                    if proc.poll() is None:
                        _warn(f"MCP server '{self.name}' stdin close failed: {exc}")
            if proc.poll() is None:
                try:
                    proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=2)
            self.returncode = proc.poll()
            self._proc = None
        self._fail_pending(f"MCP server '{self.name}' closed")

    def _spawn(self) -> None:
        try:
            self._proc = subprocess.Popen(
                self.argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.env,
                cwd=self.cwd,
            )
        except OSError as exc:
            raise McpError(f"MCP server '{self.name}' failed to start: {exc}") from exc
        stdout = self._proc.stdout
        if stdout is None:
            self.close()
            raise McpError(f"MCP server '{self.name}' has no stdout pipe")
        self._stdout = stdout
        _track(self)
        threading.Thread(
            target=self._read_loop,
            name=f"mcp-read-{self.name}",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._drain_stderr,
            name=f"mcp-err-{self.name}",
            daemon=True,
        ).start()

    def _initialize(self) -> None:
        # Local import: cast/__init__.py pulls versioning, which this
        # module does not need at import time.
        try:
            from cast import __version__ as version
        except ImportError:
            version = "0"
        result = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "cast", "version": version},
            },
        )
        if not isinstance(result, dict):
            raise McpError(f"MCP server '{self.name}' returned an invalid initialize result")
        self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _next_id(self) -> int:
        with self._pending_lock:
            self._ids += 1
            return self._ids

    def _write(self, message: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise McpError(f"MCP server '{self.name}' is not running")
        payload = json.dumps(message, default=str).encode("utf-8") + b"\n"
        with self._write_lock:
            proc.stdin.write(payload)
            proc.stdin.flush()

    def _read_loop(self) -> None:
        try:
            while not self._closed:
                message = self._read_message()
                if message is None:
                    self._fail_pending(f"MCP server '{self.name}' exited")
                    return
                self._dispatch(message)
        except Exception as exc:  # noqa: BLE001
            # Any read failure has to unblock the caller waiting on this session.
            self._fail_pending(f"MCP server '{self.name}' read failed: {exc}")

    def _read_message(self) -> dict[str, Any] | None:
        stdout = self._stdout
        if stdout is None:
            return None
        while not self._closed:
            line = stdout.readline()
            if line == b"":
                return None
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.lower().startswith(b"content-length:"):
                return self._read_framed(stripped)
            try:
                parsed = json.loads(stripped.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                text = stripped.decode("utf-8", errors="replace")
                _warn(f"MCP server '{self.name}' ignored non-JSON stdout: {text[:200]}")
                continue
            if isinstance(parsed, dict):
                return parsed
            _warn(f"MCP server '{self.name}' ignored a non-object JSON message")
        return None

    def _read_framed(self, first_line: bytes) -> dict[str, Any] | None:
        stdout = self._stdout
        if stdout is None:
            return None
        try:
            length = int(first_line.split(b":", 1)[1].strip())
        except ValueError as exc:
            raise McpError(f"MCP server '{self.name}' sent an invalid Content-Length") from exc
        if length < 0 or length > _MAX_MESSAGE_BYTES:
            raise McpError(f"MCP server '{self.name}' message exceeds the size limit")
        while True:
            header = stdout.readline()
            if header == b"":
                return None
            if header in (b"\n", b"\r\n"):
                break
        body = self._read_exact(length)
        if body is None:
            return None
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise McpError(f"MCP server '{self.name}' sent a non-JSON frame") from exc
        if not isinstance(parsed, dict):
            raise McpError(f"MCP server '{self.name}' frame was not an object")
        return parsed

    def _read_exact(self, length: int) -> bytes | None:
        stdout = self._stdout
        if stdout is None:
            return None
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = stdout.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        req_id = message.get("id")
        if method and req_id is not None:
            self._respond_to_server(message)
            return
        if req_id is not None and method is None:
            self._resolve(req_id, message)

    def _respond_to_server(self, message: dict[str, Any]) -> None:
        req_id = message.get("id")
        method = message.get("method")
        if method == "ping":
            self._write({"jsonrpc": "2.0", "id": req_id, "result": {}})
            return
        self._write(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }
        )

    def _resolve(self, req_id: Any, message: dict[str, Any]) -> None:
        with self._pending_lock:
            pending = self._pending.pop(req_id, None)
        if pending is None:
            return
        event, holder = pending
        if message.get("error") is not None:
            holder["error"] = message["error"]
        else:
            holder["result"] = message.get("result")
        event.set()

    def _fail_pending(self, message: str) -> None:
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for event, holder in pending:
            holder["error"] = {"code": -32000, "message": message}
            event.set()

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                _warn(f"MCP {self.name}: {text[:500]}")


def _warn(message: str) -> None:
    import sys

    print(f"Warning: {message}", file=sys.stderr, flush=True)
