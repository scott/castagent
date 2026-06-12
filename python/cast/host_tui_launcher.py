#!/usr/bin/env python3
"""
host_tui_launcher.py — On-host TUI launcher for deployed agents.

This script is bundled into the agent's Docker image at /opt/cast-tui/.
When a user runs `cast-tui` from inside the agent container, this script:

1. Waits for the A2A server on localhost:8080 to be reachable
   (polls agent/card via JSON-RPC for up to 30 seconds).
2. Locates a JavaScript runtime (bun preferred, then node).
3. Execs the bundled cast-tui with the appropriate flags.

If no JS runtime is found, it falls back to a built-in Python REPL
chat interface that speaks the A2A protocol.

The A2A wire format matches the server at runtime.py:
  - Method: "message/send"
  - Parts use "kind" (not "type")
  - Responses read from result.parts
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

A2A_BASE = os.environ.get("CAST_A2A_URL", "http://localhost:8080")
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
AGENT_NAME = os.environ.get("CAST_AGENT_NAME", "unknown")
TUI_DIR = os.environ.get("CAST_TUI_DIR", "/opt/cast-tui")
POLL_INTERVAL = 2  # seconds
POLL_TIMEOUT = 30  # seconds


# ---------------------------------------------------------------------------
# JSON-RPC 2.0 helpers
# ---------------------------------------------------------------------------

def _headers() -> dict:
    h = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        h["Authorization"] = f"Bearer {AUTH_TOKEN}"
    return h


def _jsonrpc_request(method: str, params: dict | None = None) -> dict | None:
    """
    Send a JSON-RPC 2.0 POST to the A2A server and return the result dict,
    or None on any failure.
    """
    url = A2A_BASE
    payload = {
        "jsonrpc": "2.0",
        "id": str(int(time.time() * 1000)),
        "method": method,
    }
    if params is not None:
        payload["params"] = params

    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            response = json.loads(resp.read().decode())
        if "result" in response:
            return response["result"]
        if "error" in response:
            print(f"  [A2A Error] {response['error']}", file=sys.stderr)
            return None
        return None
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as e:
        if isinstance(e, urllib.error.HTTPError) and e.code == 401:
            print("  [Auth Error] Invalid or missing AUTH_TOKEN", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# A2A server health check
# ---------------------------------------------------------------------------

def wait_for_a2a_server() -> bool:
    """Poll agent/card until the A2A server responds or timeout."""
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        result = _jsonrpc_request("agent/card")
        if result is not None:
            return True
        time.sleep(POLL_INTERVAL)
    return False


# ---------------------------------------------------------------------------
# A2A chat helpers
# ---------------------------------------------------------------------------

def send_message(text: str) -> str | None:
    """Send a chat message via message/send and return the response text."""
    message_id = str(int(time.time() * 1000))
    params = {
        "message": {
            "role": "user",
            "parts": [{"kind": "text", "text": text}],
            "messageId": message_id,
        },
        "metadata": {},
    }
    result = _jsonrpc_request("message/send", params)
    if result is None:
        return None

    # Extract text from response parts
    parts = result.get("parts", [])
    text_parts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("kind") == "text"]
    return "".join(text_parts) if text_parts else None


# ---------------------------------------------------------------------------
# Fallback Python REPL chat
# ---------------------------------------------------------------------------

def run_python_repl():
    """Simple A2A chat REPL in Python (no JS runtime required)."""
    import readline  # noqa: F401 — enables line editing

    print(f"\n╔══════════════════════════════════════════════════════════════╗")
    print(f"║         On-Host Chat — {AGENT_NAME:<35} ║")
    print(f"╚══════════════════════════════════════════════════════════════╝")
    print(f"Connected to {A2A_BASE}")
    print("Type /help for commands, Ctrl+C or /exit to quit.\n")

    while True:
        try:
            text = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not text:
            continue

        if text == "/exit" or text == "/quit":
            break

        if text == "/help":
            print("  /exit  — Quit the chat")
            print("  /help  — Show this help")
            print("  Anything else is sent to the agent as a message.\n")
            continue

        print("  Sending...", end="\r", flush=True)
        response = send_message(text)
        if response is None:
            print("\r  [Error] Agent did not respond. Is it running?\n")
            continue

        print(f"\r{response}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Step 1: Wait for A2A server
    print("Waiting for A2A server...", end="", flush=True)
    ready = wait_for_a2a_server()
    if not ready:
        print(" timeout!")
        print(f"A2A server did not respond within {POLL_TIMEOUT} seconds.")
        print(f"Expected at: {A2A_BASE}/")
        print("Make sure the agent container is running and the A2A server is started.")
        sys.exit(1)
    print(" ready!")

    # Step 2: Try to find a JS runtime for the bundled TUI
    # Note: bun is preferred because @opentui/core imports bun:ffi
    # (a Bun built-in) and cannot run on Node.js.
    js_runtime = None
    for candidate in ["bun", "node", "nodejs"]:
        try:
            subprocess.run(
                [candidate, "--version"],
                capture_output=True,
                check=True,
            )
            js_runtime = candidate
            break
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue

    tui_script = os.path.join(TUI_DIR, "dist", "index.js")
    if js_runtime and os.path.exists(tui_script):
        # Step 3a: Exec the bundled TUI
        # Note: --token is intentionally NOT passed as a CLI arg
        # because it would be visible in `ps` output. Instead, the
        # TUI reads AUTH_TOKEN from the environment (inherited).
        tui_args = [
            js_runtime, tui_script,
            "--agent", AGENT_NAME,
            "--url", A2A_BASE,
            "--mode", "on-host",
        ]

        # If a welcome message is provided, pass it through
        welcome = os.environ.get("CAST_TUI_WELCOME", "")
        if welcome:
            tui_args.extend(["--welcome", welcome])

        try:
            os.execvp(js_runtime, tui_args)
        except FileNotFoundError:
            print(f"Warning: '{js_runtime}' not found at exec time, falling back to Python REPL.")
        except OSError as e:
            print(f"Warning: Could not launch TUI ({e}), falling back to Python REPL.")
    else:
        msg_parts = []
        if not js_runtime:
            msg_parts.append("no JS runtime (node/bun) found")
        if not os.path.exists(tui_script):
            msg_parts.append(f"TUI bundle not found at {tui_script}")
        if msg_parts:
            print(f"Cannot launch bundled TUI ({'; '.join(msg_parts)}).")
            print("Using built-in Python chat REPL instead.\n")

    # Step 3b: Fallback Python REPL
    run_python_repl()


if __name__ == "__main__":
    main()
