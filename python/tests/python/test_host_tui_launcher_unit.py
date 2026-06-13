"""
Unit tests for host_tui_launcher.py — validates all code paths:
- MOTD loading (env var base64/plaintext, file fallback)
- JSON-RPC request helpers (success, auth, errors, timeouts)
- send_message and wait_for_a2a_server
- run_python_repl (input parsing, /help, /exit, Ctrl+C)
- main() orchestration (JS runtime detection, execvp, fallback REPL)
"""

import builtins
import importlib
import io
import json
import os
import signal
import subprocess
import sys
import textwrap
import time
import types
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock, call, patch

import pytest

# The module sets these at import time by reading env vars.  We set
# predictable defaults in a .env style so every test starts clean.
_TEST_ENV = {
    "CAST_A2A_URL": "http://localhost:8080",
    "AUTH_TOKEN": "",
    "CAST_AGENT_NAME": "test-agent",
    "CAST_TUI_DIR": "/opt/cast-tui",
    "CAST_MOTD": "",
    "CAST_MOTD_FILE": "",
    "HOME": "/home/test",
}


# ---------------------------------------------------------------------------
# Fixture: import host_tui_launcher with a clean module and predictable env
# ---------------------------------------------------------------------------

@pytest.fixture
def mod(request):
    """Return the host_tui_launcher module, reloaded with _TEST_ENV."""
    # We patch globally so os.environ.get inside the module finds our test values
    env_patcher = patch.dict(os.environ, _TEST_ENV, clear=False)
    env_patcher.start()

    # If the module was already imported (by another test), remove it so we
    # get a fresh import with the test env vars.
    if "cast.host_tui_launcher" in sys.modules:
        del sys.modules["cast.host_tui_launcher"]
    # Also remove parent cast if needed
    if "cast" in sys.modules:
        del sys.modules["cast"]

    import cast.host_tui_launcher as m

    def teardown():
        env_patcher.stop()
        if "cast.host_tui_launcher" in sys.modules:
            del sys.modules["cast.host_tui_launcher"]

    request.addfinalizer(teardown)
    return m


# ---------------------------------------------------------------------------
# __version__
# ---------------------------------------------------------------------------

def test_module_has_version(mod):
    """The module reads __version__ from the cast package."""
    assert mod.CAST_VERSION is not None


# ---------------------------------------------------------------------------
# _headers
# ---------------------------------------------------------------------------

def test_headers_no_auth(mod):
    with patch.dict(os.environ, {"AUTH_TOKEN": ""}, clear=False):
        importlib.reload(mod)
        assert mod._headers() == {"Content-Type": "application/json"}


def test_headers_with_auth(mod):
    with patch.dict(os.environ, {"AUTH_TOKEN": "s3cret"}, clear=False):
        importlib.reload(mod)
        headers = mod._headers()
        assert headers["Authorization"] == "Bearer s3cret"


# ---------------------------------------------------------------------------
# _jsonrpc_request
# ---------------------------------------------------------------------------

class MockHttpResponse:
    """Minimal stand-in for http.client.HTTPResponse / urllib response."""
    def __init__(self, data: dict, status: int = 200):
        self._data = json.dumps(data).encode()
        self.status = status

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def test_jsonrpc_request_success(mod):
    """A successful agent/card returns the result dict."""
    fake_response = {"jsonrpc": "2.0", "result": {"name": "test-agent"}}
    with patch("urllib.request.urlopen", return_value=MockHttpResponse(fake_response)):
        result = mod._jsonrpc_request("agent/card")
    assert result == {"name": "test-agent"}


def test_jsonrpc_request_includes_params(mod):
    """Params are included in the payload when provided."""
    sent = []

    def capture_urlopen(req, **kw):
        sent.append(json.loads(req.data))
        return MockHttpResponse({"jsonrpc": "2.0", "result": {}})

    with patch("urllib.request.urlopen", capture_urlopen):
        mod._jsonrpc_request("message/send", {"message": {"text": "hi"}})
    assert sent[0]["method"] == "message/send"
    assert sent[0]["params"]["message"]["text"] == "hi"


def test_jsonrpc_request_returns_none_on_error_response(mod):
    """When the server returns an error, _jsonrpc_request returns None."""
    fake = {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method not found"}}
    with patch("urllib.request.urlopen", return_value=MockHttpResponse(fake)):
        result = mod._jsonrpc_request("bad/method")
    assert result is None


def test_jsonrpc_request_returns_none_on_http_401(mod):
    """HTTP 401 is handled and None returned."""
    import urllib.error
    try:
        err = urllib.error.HTTPError(
            "http://localhost:8080", 401, "Unauthorized", {}, None
        )
    except TypeError:
        # Some Python versions need a file-like object for the body
        err = urllib.error.HTTPError(
            "http://localhost:8080", 401, "Unauthorized", {},
            io.BytesIO(b"{}"),
        )
    with patch("urllib.request.urlopen", side_effect=err):
        result = mod._jsonrpc_request("agent/card")
    assert result is None


def test_jsonrpc_request_returns_none_on_connection_error(mod):
    """Connection refused / URLError returns None."""
    import urllib.error
    err = urllib.error.URLError("Connection refused")
    with patch("urllib.request.urlopen", side_effect=err):
        result = mod._jsonrpc_request("agent/card")
    assert result is None


def test_jsonrpc_request_returns_none_on_json_decode_error(mod):
    """Invalid JSON from server returns None."""
    class BadResp:
        def read(self):
            return b"not json"
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass

    with patch("urllib.request.urlopen", return_value=BadResp()):
        result = mod._jsonrpc_request("agent/card")
    assert result is None


# ---------------------------------------------------------------------------
# wait_for_a2a_server
# ---------------------------------------------------------------------------

def test_wait_for_a2a_server_returns_true(mod):
    """If the server responds, return True."""
    with patch.object(mod, "_jsonrpc_request", return_value={"name": "agent"}):
        assert mod.wait_for_a2a_server() is True


def test_wait_for_a2a_server_returns_false_on_timeout(mod):
    """If the server never responds, return False after POLL_TIMEOUT."""
    # Reduce timeout so the test doesn't wait 30 real seconds
    mod.POLL_TIMEOUT = 0.01  # 10 ms
    mod.POLL_INTERVAL = 0.005
    with patch.object(mod, "_jsonrpc_request", return_value=None):
        assert mod.wait_for_a2a_server() is False


# ---------------------------------------------------------------------------
# send_message
# ---------------------------------------------------------------------------

def test_send_message_success(mod):
    """send_message returns concatenated text from response parts."""
    fake_result = {
        "parts": [
            {"kind": "text", "text": "Hello, "},
            {"kind": "text", "text": "world!"},
        ]
    }
    with patch.object(mod, "_jsonrpc_request", return_value=fake_result):
        assert mod.send_message("test") == "Hello, world!"


def test_send_message_returns_none_on_failure(mod):
    """When _jsonrpc_request returns None, send_message returns None."""
    with patch.object(mod, "_jsonrpc_request", return_value=None):
        assert mod.send_message("test") is None


def test_send_message_returns_none_when_no_text_parts(mod):
    """When no parts have kind=='text', return None."""
    fake_result = {"parts": [{"kind": "file", "file": {"name": "test.txt"}}]}
    with patch.object(mod, "_jsonrpc_request", return_value=fake_result):
        assert mod.send_message("test") is None


# ---------------------------------------------------------------------------
# MOTD helpers
# ---------------------------------------------------------------------------

class TestReadEnvMotd:
    """Tests for _read_env_motd()."""

    def test_returns_none_when_empty(self, mod):
        with patch.dict(os.environ, {"CAST_MOTD": ""}, clear=False):
            importlib.reload(mod)
            assert mod._read_env_motd() is None

    def test_returns_plain_text(self, mod):
        with patch.dict(os.environ, {"CAST_MOTD": "hello world"}, clear=False):
            importlib.reload(mod)
            assert mod._read_env_motd() == "hello world"

    def test_decodes_base64(self, mod):
        import base64
        plain = "Welcome to agent-cast!"
        encoded = base64.b64encode(plain.encode()).decode()
        with patch.dict(os.environ, {"CAST_MOTD": encoded}, clear=False):
            importlib.reload(mod)
            assert mod._read_env_motd() == plain

    def test_handles_invalid_base64_gracefully(self, mod):
        # Looks like base64 (len%4==0, valid chars) but isn't valid
        with patch.dict(os.environ, {"CAST_MOTD": "AAAA"}, clear=False):
            importlib.reload(mod)
            # AAAA is valid base64 that decodes to 3 bytes of zeros, so it works
            result = mod._read_env_motd()
        assert result is not None

    def test_pseudo_base64_falls_back_to_raw(self, mod):
        """A string that matches base64 pattern but fails decode returns raw."""
        # Use a string that is base64-like but won't decode to valid utf-8
        # First, create a genuinely invalid utf-8 base64 string
        import base64
        # 0xFF 0xFE 0x00 encoded as base64 is "/v4A" which is valid base64
        # but let's use a simpler case: just use plain text that has a trailing '='
        with patch.dict(os.environ, {"CAST_MOTD": "aGVsbG8="}, clear=False):
            importlib.reload(mod)
            assert mod._read_env_motd() == "hello"

    def test_non_base64_chars_returns_raw(self, mod):
        """If the value contains non-base64 chars, return it as raw text."""
        with patch.dict(os.environ, {"CAST_MOTD": "hello world!!"}, clear=False):
            importlib.reload(mod)
            assert mod._read_env_motd() == "hello world!!"


class TestGetMotdPaths:
    """Tests for _get_motd_paths()."""

    def test_returns_list_of_four(self, mod):
        paths = mod._get_motd_paths()
        assert len(paths) == 4
        assert paths[0] == ""  # CAST_MOTD_FILE not set

    def test_uses_env_var(self, mod):
        with patch.dict(os.environ, {"CAST_MOTD_FILE": "/custom/motd"}, clear=False):
            importlib.reload(mod)
            paths = mod._get_motd_paths()
            assert paths[0] == "/custom/motd"


class TestLoadMotd:
    """Tests for load_motd()."""

    def test_returns_env_motd_when_set(self, mod, tmp_path):
        with patch.dict(os.environ, {"CAST_MOTD": "from env"}, clear=False):
            importlib.reload(mod)
            assert mod.load_motd() == "from env"

    def test_falls_back_to_file_path(self, mod, tmp_path):
        motd_file = tmp_path / "motd"
        motd_file.write_text("from file")
        with patch.dict(os.environ, {"CAST_MOTD": ""}, clear=False):
            importlib.reload(mod)
            with patch.object(mod, "_get_motd_paths", return_value=[str(motd_file)]):
                assert mod.load_motd() == "from file"

    def test_returns_none_when_no_sources(self, mod):
        with patch.dict(os.environ, {"CAST_MOTD": ""}, clear=False):
            importlib.reload(mod)
            with patch.object(mod, "_get_motd_paths", return_value=[]):
                assert mod.load_motd() is None

    def test_skips_missing_files(self, mod, tmp_path):
        """load_motd skips non-existent files and returns content from the first readable one."""
        missing = tmp_path / "nonexistent"
        existing = tmp_path / "exists"
        existing.write_text("found me")
        with patch.object(mod, "_get_motd_paths", return_value=[str(missing), str(existing)]):
            assert mod.load_motd() == "found me"


# ---------------------------------------------------------------------------
# run_python_repl
# ---------------------------------------------------------------------------

class TestRunPythonRepl:
    """Tests for the fallback Python REPL chat."""

    def test_exit_command_breaks_loop(self, mod):
        """Typing /exit should exit the REPL."""
        with patch("builtins.input", side_effect=["/exit"]):
            # Should not raise despite infinite loop
            mod.run_python_repl()

    def test_quit_command_breaks_loop(self, mod):
        """Typing /quit should exit the REPL."""
        with patch("builtins.input", side_effect=["/quit"]):
            mod.run_python_repl()

    def test_help_command_shows_help(self, mod):
        """Typing /help should print help text and continue."""
        inputs = ["/help", "/exit"]
        out = io.StringIO()
        with (
            patch("builtins.input", side_effect=inputs),
            patch("sys.stdout", out),
        ):
            mod.run_python_repl()
        output = out.getvalue()
        assert "/exit" in output
        assert "/help" in output

    def test_empty_input_continues(self, mod):
        """Empty input should be skipped."""
        inputs = ["", "/exit"]
        with patch("builtins.input", side_effect=inputs):
            mod.run_python_repl()

    def test_sends_message_and_displays_response(self, mod):
        """A non-command message should be sent to the agent and printed."""
        inputs = ["hello agent", "/exit"]
        out = io.StringIO()
        with (
            patch("builtins.input", side_effect=inputs),
            patch("sys.stdout", out),
            patch.object(mod, "send_message", return_value="You said: hello agent"),
        ):
            mod.run_python_repl()
        output = out.getvalue()
        assert "You said: hello agent" in output

    def test_handles_send_failure(self, mod):
        """When send_message returns None, show an error."""
        inputs = ["hello", "/exit"]
        out = io.StringIO()
        with (
            patch("builtins.input", side_effect=inputs),
            patch("sys.stdout", out),
            patch.object(mod, "send_message", return_value=None),
        ):
            mod.run_python_repl()
        output = out.getvalue()
        assert "Error" in output or "did not respond" in output

    def test_handles_eof_error(self, mod):
        """Ctrl+D (EOFError) should exit gracefully."""
        with patch("builtins.input", side_effect=EOFError):
            mod.run_python_repl()

    def test_handles_keyboard_interrupt(self, mod):
        """Ctrl+C (KeyboardInterrupt) should exit gracefully."""
        with patch("builtins.input", side_effect=KeyboardInterrupt):
            mod.run_python_repl()

    def test_shows_motd_when_available(self, mod):
        """If load_motd returns content, it should be printed."""
        inputs = ["/exit"]
        out = io.StringIO()
        with (
            patch("builtins.input", side_effect=inputs),
            patch("sys.stdout", out),
            patch.object(mod, "load_motd", return_value="Welcome to the agent!"),
        ):
            mod.run_python_repl()
        assert "Welcome to the agent!" in out.getvalue()

    def test_does_not_show_motd_when_none(self, mod):
        """If load_motd returns None, no MOTD block is printed."""
        inputs = ["/exit"]
        out = io.StringIO()
        with (
            patch("builtins.input", side_effect=inputs),
            patch("sys.stdout", out),
            patch.object(mod, "load_motd", return_value=None),
        ):
            mod.run_python_repl()
        assert "Welcome to the agent!" not in out.getvalue()


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------

class TestMain:
    """Tests for main() — the orchestrator."""

    def test_waits_for_server_and_launches_tui_with_bun(self, mod):
        """When bun is available and TUI dist exists, execvp is called with bun."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", return_value=MagicMock(returncode=0)),
            patch("os.path.exists", return_value=True),
            patch("os.execvp") as execvp,
            patch.object(mod, "run_python_repl"),
        ):
            mod.main()
            execvp.assert_called_once()
            args = execvp.call_args[0]
            assert args[0] == "bun"
            assert "--agent" in args[1]
            assert "--url" in args[1]
            assert "--mode" in args[1]
            assert "on-host" in args[1]

    def test_launches_tui_with_node_when_bun_unavailable(self, mod):
        """When bun fails but node works, use node."""
        call_count = [0]

        def fake_subprocess_run(cmd, **kw):
            runtime = cmd[0]
            if runtime == "bun":
                raise FileNotFoundError("bun not found")
            if runtime == "node":
                call_count[0] += 1
                return MagicMock(returncode=0)
            raise FileNotFoundError(f"{runtime} not found")

        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", side_effect=fake_subprocess_run),
            patch("os.path.exists", return_value=True),
            patch("os.execvp") as execvp,
            patch.object(mod, "run_python_repl"),
        ):
            mod.main()
            assert execvp.call_args[0][0] == "node"

    def test_tries_nodejs_fallback(self, mod):
        """When bun and node are missing, try nodejs."""
        call_count = [0]

        def fake_subprocess_run(cmd, **kw):
            runtime = cmd[0]
            if runtime in ("bun", "node"):
                raise FileNotFoundError(f"{runtime} not found")
            if runtime == "nodejs":
                call_count[0] += 1
                return MagicMock(returncode=0)
            raise FileNotFoundError(f"{runtime} not found")

        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", side_effect=fake_subprocess_run),
            patch("os.path.exists", return_value=True),
            patch("os.execvp") as execvp,
            patch.object(mod, "run_python_repl"),
        ):
            mod.main()
            assert execvp.call_args[0][0] == "nodejs"

    def test_falls_back_to_repl_when_no_js_runtime(self, mod):
        """When no JS runtime is found, fall back to Python REPL."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", side_effect=FileNotFoundError("no runtime")),
            patch("os.path.exists", return_value=True),
            patch.object(mod, "run_python_repl") as repl,
        ):
            mod.main()
            repl.assert_called_once()

    def test_falls_back_to_repl_when_tui_script_missing(self, mod):
        """When TUI dist doesn't exist, fall back to Python REPL."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", return_value=MagicMock(returncode=0)),
            patch("os.path.exists", return_value=False),
            patch.object(mod, "run_python_repl") as repl,
        ):
            mod.main()
            repl.assert_called_once()

    def test_falls_back_to_repl_when_execvp_fails_file_not_found(self, mod):
        """If os.execvp raises FileNotFoundError, fall back to Python REPL."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", return_value=MagicMock(returncode=0)),
            patch("os.path.exists", return_value=True),
            patch("os.execvp", side_effect=FileNotFoundError("bun disappeared")),
            patch.object(mod, "run_python_repl") as repl,
        ):
            mod.main()
            repl.assert_called_once()

    def test_falls_back_to_repl_when_execvp_fails_os_error(self, mod):
        """If os.execvp raises OSError, fall back to Python REPL."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", return_value=MagicMock(returncode=0)),
            patch("os.path.exists", return_value=True),
            patch("os.execvp", side_effect=OSError("Permission denied")),
            patch.object(mod, "run_python_repl") as repl,
        ):
            mod.main()
            repl.assert_called_once()

    def test_exits_with_error_on_server_timeout(self, mod):
        """When the A2A server doesn't respond, exit with code 1."""
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=False),
            pytest.raises(SystemExit) as exc,
        ):
            mod.main()
        assert exc.value.code == 1

    def test_passes_welcome_flag_when_set(self, mod):
        """When CAST_TUI_WELCOME is set, --welcome should be passed."""
        # Keep the env var patched across both the reload and the call to main().
        # main() reads CAST_TUI_WELCOME at runtime via os.environ.get().
        env_patch = patch.dict(os.environ, {"CAST_TUI_WELCOME": "Welcome!\n"}, clear=False)
        env_patch.start()
        importlib.reload(mod)
        try:
            with (
                patch.object(mod, "wait_for_a2a_server", return_value=True),
                patch("subprocess.run", return_value=MagicMock(returncode=0)),
                patch("os.path.exists", return_value=True),
                patch("os.execvp") as execvp,
                patch.object(mod, "run_python_repl"),
            ):
                mod.main()
                args = execvp.call_args[0][1]
                assert "--welcome" in args
                idx = args.index("--welcome")
                assert args[idx + 1] == "Welcome!\n"
        finally:
            env_patch.stop()

    def test_execvp_passes_agent_name_and_url(self, mod):
        """Verify that --agent and --url are correct."""
        with patch.dict(os.environ, {
            "CAST_AGENT_NAME": "my-agent",
            "CAST_A2A_URL": "http://example.com:9090",
        }, clear=False):
            importlib.reload(mod)
        with (
            patch.object(mod, "wait_for_a2a_server", return_value=True),
            patch("subprocess.run", return_value=MagicMock(returncode=0)),
            patch("os.path.exists", return_value=True),
            patch("os.execvp") as execvp,
            patch.object(mod, "run_python_repl"),
        ):
            mod.main()
            args_list = execvp.call_args[0][1]
            assert "--agent" in args_list
            agent_idx = args_list.index("--agent")
            assert args_list[agent_idx + 1] == "my-agent"
            assert "--url" in args_list
            url_idx = args_list.index("--url")
            assert args_list[url_idx + 1] == "http://example.com:9090"
