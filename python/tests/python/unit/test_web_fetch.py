"""Tests for web_fetch. No test opens a network connection."""

import socket
from urllib import error as urllib_error

import pytest
from cast.harness.permissions import ASK, DENY, MCP_ORIGIN, PermissionGate, guard_tool
from cast.tools import web_fetch as web_fetch_mod
from cast.tools.web_fetch import (
    FetchError,
    fetch_url,
    html_to_markdown,
    is_blocked_ip,
    web_fetch,
)


class _Headers:
    def __init__(self, mapping):
        self._mapping = {key.lower(): value for key, value in mapping.items()}

    def get(self, key, default=None):
        return self._mapping.get(key.lower(), default)


class _Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = _Headers(headers)
        self._body = body if isinstance(body, bytes) else body.encode("utf-8")

    def read(self, amount=-1):
        if amount is None or amount < 0 or amount >= len(self._body):
            data = self._body
            self._body = b""
            return data
        data = self._body[:amount]
        self._body = self._body[amount:]
        return data

    def close(self):
        return None


class _Opener:
    def __init__(self, responses):
        self.calls = []
        self._responses = list(responses)

    def open(self, request, timeout=None):
        self.calls.append(request.full_url)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def _public_dns(monkeypatch, extra=None):
    real = socket.getaddrinfo
    allowed = {"example.com", "example.org", "registry.example"}
    if extra:
        allowed.update(extra)

    def fake(host, port, *args, **kwargs):
        if host in allowed:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
        return real(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", fake)


class TestBlockedAddresses:
    @pytest.mark.parametrize(
        "value",
        [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "224.0.0.1",
            "::1",
            "fe80::1",
            "fd00:ec2::254",
            "::ffff:127.0.0.1",
        ],
    )
    def test_non_public_addresses_are_blocked(self, value):
        assert is_blocked_ip(value) is True

    def test_public_addresses_are_allowed(self):
        assert is_blocked_ip("8.8.8.8") is False
        assert is_blocked_ip("93.184.216.34") is False
        assert is_blocked_ip("2606:4700:4700::1111") is False
        assert is_blocked_ip("::ffff:8.8.8.8") is False

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/latest",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://10.0.0.8/",
            "http://192.168.0.2/agent",
            "http://localhost/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://metadata.google.internal./",
            "http://foo.cluster.local/",
            "http://printer.local/",
            "file:///etc/passwd",
            "ftp://example.com/file",
            "http://user:secret@example.com/",
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://0x7f.0.0.1/",
            "http://127.1/",
        ],
    )
    def test_refuses_before_any_request(self, url, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([])
        with pytest.raises(FetchError):
            fetch_url(url, opener=opener)
        assert opener.calls == []

    def test_refuses_a_name_that_resolves_to_a_private_address(self, monkeypatch):
        def fake(host, port, *args, **kwargs):
            assert host == "rebind.example"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.4", port))]

        monkeypatch.setattr(socket, "getaddrinfo", fake)
        opener = _Opener([])
        with pytest.raises(FetchError, match="resolved address"):
            fetch_url("http://rebind.example/secret", opener=opener)
        assert opener.calls == []

    def test_refuses_when_any_resolved_address_is_private(self, monkeypatch):
        def fake(host, port, *args, **kwargs):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.9", port)),
            ]

        monkeypatch.setattr(socket, "getaddrinfo", fake)
        opener = _Opener([])
        with pytest.raises(FetchError):
            fetch_url("https://mixed.example/", opener=opener)
        assert opener.calls == []


class TestFetchUrl:
    def test_returns_text(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([
            _Response(200, {"Content-Type": "text/plain; charset=utf-8"}, b"hello"),
        ])
        result = fetch_url("https://example.com/readme", opener=opener)
        assert opener.calls == ["https://example.com/readme"]
        assert "hello" in result
        assert "HTTP 200" in result
        assert "Error" not in result

    def test_converts_html_to_markdown_and_drops_scripts(self, monkeypatch):
        _public_dns(monkeypatch)
        html = """
        <html><head><title>Hidden</title><style>body{}</style></head>
        <body>
          <h1>Hello</h1>
          <p>See <a href="https://example.com/docs">the docs</a>.</p>
          <script>secret()</script>
          <a href="javascript:alert(1)">click</a>
        </body></html>
        """
        opener = _Opener([
            _Response(200, {"Content-Type": "text/html; charset=utf-8"}, html),
        ])
        result = fetch_url("https://example.com/page", opener=opener)
        assert "# Hello" in result
        assert "[the docs](https://example.com/docs)" in result
        assert "secret()" not in result
        assert "javascript:" not in result
        assert "Hidden" not in result
        assert "text/html" in result

    def test_html_helper_keeps_a_code_span(self):
        text = html_to_markdown("<p>Run <code>cast dev</code> now</p>")
        assert "`cast dev`" in text

    def test_truncates_a_large_body(self, monkeypatch):
        _public_dns(monkeypatch)
        # Patch the module object. A string path breaks after another test
        # drops the cast package from sys.modules.
        monkeypatch.setattr(web_fetch_mod, "MAX_RESPONSE_BYTES", 8)
        opener = _Opener([
            _Response(200, {"Content-Type": "text/plain"}, b"0123456789abcdef"),
        ])
        result = fetch_url("https://example.com/big", opener=opener)
        assert "01234567" in result
        assert "89abcdef" not in result
        assert "truncated at 8 bytes" in result

    def test_reports_a_non_text_body(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([
            _Response(200, {"Content-Type": "image/png"}, b"\x89PNG"),
        ])
        result = fetch_url("https://example.com/pic.png", opener=opener)
        assert result.startswith("Error:")
        assert "image/png" in result
        assert "PNG" not in result

    def test_includes_an_error_status(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([
            _Response(404, {"Content-Type": "text/plain"}, b"missing"),
        ])
        result = fetch_url("https://example.com/nope", opener=opener)
        assert result.startswith("Error: HTTP 404")
        assert "missing" in result

    def test_does_not_follow_a_redirect_to_a_metadata_address(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([
            _Response(302, {"Location": "http://169.254.169.254/latest/meta-data"}, b""),
            _Response(200, {"Content-Type": "text/plain"}, b"credential"),
        ])
        with pytest.raises(FetchError, match="metadata|link-local|private|loopback"):
            fetch_url("https://example.com/start", opener=opener)
        assert opener.calls == ["https://example.com/start"]

    def test_follows_a_redirect_that_stays_public(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([
            _Response(302, {"Location": "https://example.org/final"}, b""),
            _Response(200, {"Content-Type": "text/markdown"}, b"# Done"),
        ])
        result = fetch_url("https://example.com/start", opener=opener)
        assert opener.calls == ["https://example.com/start", "https://example.org/final"]
        assert "# Done" in result

    def test_stops_after_too_many_redirects(self, monkeypatch):
        _public_dns(monkeypatch)
        responses = [
            _Response(302, {"Location": f"https://example.com/r{index}"}, b"")
            for index in range(1, 8)
        ]
        opener = _Opener(responses)
        with pytest.raises(FetchError, match="Too many redirects"):
            fetch_url("https://example.com/r0", opener=opener)
        assert len(opener.calls) == 6

    def test_timeout(self, monkeypatch):
        _public_dns(monkeypatch)
        opener = _Opener([TimeoutError("timed out")])
        with pytest.raises(FetchError, match="timed out after 20 seconds"):
            fetch_url("https://example.com/", opener=opener)

    def test_http_error_is_read(self, monkeypatch):
        _public_dns(monkeypatch)
        import io

        failure = urllib_error.HTTPError(
            "https://example.com/missing",
            404,
            "Not Found",
            _Headers({"Content-Type": "text/plain"}),
            io.BytesIO(b"gone"),
        )
        opener = _Opener([failure])
        result = fetch_url("https://example.com/missing", opener=opener)
        assert "HTTP 404" in result
        assert "gone" in result

    def test_tool_returns_the_error_prefix(self, monkeypatch):
        result = web_fetch.invoke({"url": "http://127.0.0.1/"})
        assert result.startswith("Error:")
        assert "127.0.0.1" not in result or "Refusing" in result

    def test_tool_name_and_default_permission(self):
        assert web_fetch.name == "web_fetch"
        gate = PermissionGate({})
        assert gate.action_for("web_fetch") == ASK
        assert gate.action_for("web_fetch", origin=MCP_ORIGIN) == DENY
        asked = guard_tool(web_fetch, "web_fetch", gate)
        blocked = asked.invoke({"url": "https://example.com/?q=secret"})
        assert "not executed" in blocked
        denied = guard_tool(web_fetch, "web_fetch", PermissionGate({"web_fetch": "deny"}))
        assert "not executed" in denied.invoke({"url": "https://example.com/"})
        allowed = guard_tool(
            web_fetch,
            "web_fetch",
            PermissionGate({"web_fetch": "always-allow"}),
        )
        fetched = allowed.invoke({"url": "http://127.0.0.1/"})
        assert "not executed" not in fetched
        assert fetched.startswith("Error:")
