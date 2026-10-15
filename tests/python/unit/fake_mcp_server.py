"""Stdio MCP test double. Modes: echo, ping, banner, framed, exit, paginate, run."""

from __future__ import annotations

import json
import os
import subprocess
import sys


def send_line(message: dict) -> None:
    payload = json.dumps(message).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def send_framed(message: dict) -> None:
    body = json.dumps(message).encode()
    header = f"Content-Length: {len(body)}\r\n\r\n".encode()
    sys.stdout.buffer.write(header + body)
    sys.stdout.buffer.flush()


def note_call() -> None:
    path = os.environ.get("CAST_MCP_COUNT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("1\n")


def tool_specs(mode: str) -> list[dict]:
    echo = {
        "name": "echo_text",
        "description": "Echo the text argument",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to echo"},
            },
            "required": ["text"],
        },
    }
    if mode == "run":
        # CAST_MCP_TOOL_NAME lets a test advertise a built-in name such as read.
        name = os.environ.get("CAST_MCP_TOOL_NAME", "run")
        if not isinstance(name, str) or not name.strip():
            name = "run"
        return [{
            "name": name.strip(),
            "description": "Run a command",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run"},
                },
                "required": ["command"],
            },
        }]
    if mode == "paginate":
        alpha = {
            "name": "alpha",
            "description": "First page tool",
            "inputSchema": {"type": "object", "properties": {}},
        }
        beta = {
            "name": "beta",
            "description": "Second page tool",
            "inputSchema": {"type": "object", "properties": {}},
        }
        return [alpha, beta]
    return [echo]


def call_text(arguments: dict, initialized: bool) -> str:
    text = arguments.get("text", "")
    if text == "status":
        return "initialized" if initialized else "not-initialized"
    if text == "env":
        return os.environ.get("CAST_MCP_MARKER", "")
    return str(text)


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "echo"
    if mode == "exit":
        return
    send = send_framed if mode == "framed" else send_line
    if mode == "banner":
        sys.stdout.buffer.write(b"booting fake mcp\n")
        sys.stdout.buffer.flush()
    initialized = False
    page = 0
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        stripped = line.strip()
        if not stripped:
            continue
        try:
            message = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        method = message.get("method")
        req_id = message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "fake", "version": "0.0.1"},
                    },
                }
            )
        elif method == "notifications/initialized":
            initialized = True
        elif method == "tools/list":
            specs = tool_specs(mode)
            if mode == "paginate":
                if page == 0:
                    batch = [specs[0]]
                    cursor = "page-2"
                else:
                    batch = [specs[1]]
                    cursor = None
                page += 1
            else:
                batch = specs
                cursor = None
            result: dict = {"tools": batch}
            if cursor:
                result["nextCursor"] = cursor
            send({"jsonrpc": "2.0", "id": req_id, "result": result})
        elif method == "tools/call":
            if mode == "run":
                # Stand-in for a server tool that executes a command. The
                # permission gate must stop the call before this runs.
                arguments = params.get("arguments") or {}
                note_call()
                command = arguments.get("command", "")
                if not isinstance(command, str):
                    command = ""
                completed = subprocess.run(
                    command,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                text = completed.stdout or completed.stderr or "ran"
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": [{"type": "text", "text": text}],
                            "isError": False,
                        },
                    }
                )
                continue
            if mode == "ping":
                send_line({"jsonrpc": "2.0", "id": "srv-ping", "method": "ping"})
                while True:
                    extra = sys.stdin.readline()
                    if not extra:
                        return
                    try:
                        incoming = json.loads(extra)
                    except json.JSONDecodeError:
                        continue
                    if incoming.get("id") == "srv-ping":
                        break
            note_call()
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if name in ("alpha", "beta"):
                text = name
            elif result_is_error(arguments):
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": [{"type": "text", "text": "nope"}],
                            "isError": True,
                        },
                    }
                )
                continue
            else:
                text = call_text(arguments, initialized)
                if mode == "ping":
                    text = f"pong:{text}"
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": [{"type": "text", "text": text}], "isError": False},
                }
            )


def result_is_error(arguments: dict) -> bool:
    return arguments.get("text") == "fail"


if __name__ == "__main__":
    main()
