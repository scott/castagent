"""Fetch a public http or https URL and return text.

HTML is converted to markdown. Private, loopback, link-local, and
metadata addresses are refused before a connection, again when the
name is resolved, and again on each redirect. A missing
harness.permissions entry defaults to ask. An explicit always-allow
still fetches without a prompt.
"""

from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
from html.parser import HTMLParser
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from langchain_core.tools import tool

# One mebibyte is enough for a page or a registry document and bounds
# what is returned to the model.
MAX_RESPONSE_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 20
MAX_REDIRECTS = 5
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_USER_AGENT = "CastAgent/web_fetch"

_BLOCKED_HOSTS = frozenset({
    "localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "kubernetes",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kubernetes.default.svc.cluster.local",
})
_BLOCKED_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".localdomain",
    ".cluster.local",
)


class FetchError(Exception):
    """The URL was refused or the fetch could not finish."""


def is_blocked_ip(value: str) -> bool:
    """True for private, loopback, link-local, metadata, and other non-global addresses.

    An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
    An unparseable value is blocked.
    """
    text = value.split("%", 1)[0].strip()
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return True
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or not address.is_global
    )


def _is_blocked_host(host: str) -> bool:
    name = host.rstrip(".").lower()
    if name in _BLOCKED_HOSTS:
        return True
    if any(name.endswith(suffix) for suffix in _BLOCKED_SUFFIXES):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return is_blocked_ip(name)


def _require_public_url(url: str) -> None:
    """Refuse a URL whose scheme, host, or resolved addresses are not public."""
    if not isinstance(url, str) or not url.strip():
        raise FetchError("A URL is required.")
    if len(url) > 2048:
        raise FetchError("The URL is too long.")
    if any(char in url for char in ("\x00", "\n", "\r")):
        raise FetchError("The URL contains a control character.")

    parsed = urllib_parse.urlsplit(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise FetchError("Only http and https URLs are allowed.")
    if parsed.username is not None or parsed.password is not None:
        raise FetchError("URLs with credentials are not allowed.")
    host = parsed.hostname
    if not host:
        raise FetchError("The URL has no host.")
    host = host.rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise FetchError("The URL host is not allowed.") from exc
    if _is_blocked_host(host):
        raise FetchError(
            "Refusing a private, loopback, link-local, or metadata address."
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise FetchError("The URL port is invalid.") from exc
    if port is None:
        port = 443 if scheme == "https" else 80
    if port < 1 or port > 65535:
        raise FetchError("The URL port is invalid.")
    _require_public_dns(host, port)


def _require_public_dns(host: str, port: int) -> None:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        literal = False
    else:
        literal = True
        if is_blocked_ip(host):
            raise FetchError(
                "Refusing a private, loopback, link-local, or metadata address."
            )
    try:
        results = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"Could not resolve host: {exc.strerror or exc}.") from exc
    if not results:
        raise FetchError("Could not resolve host.")
    for _family, _socktype, _proto, _canon, sockaddr in results:
        ip = sockaddr[0]
        if is_blocked_ip(ip):
            kind = "address" if literal else "resolved address"
            raise FetchError(
                f"Refusing a private, loopback, link-local, or metadata {kind}."
            )


def _create_public_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    """Connect to a resolved address that is still public at connect time."""
    host, port = address
    try:
        results = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise OSError(f"Could not resolve host: {exc.strerror or exc}") from exc
    checked = []
    for family, socktype, proto, _canon, sockaddr in results:
        if is_blocked_ip(sockaddr[0]):
            raise OSError("Refusing a private, loopback, link-local, or metadata address.")
        checked.append((family, socktype, proto, sockaddr))
    if not checked:
        raise OSError("Could not resolve host.")
    last_error: Exception | None = None
    for family, socktype, proto, sockaddr in checked:
        sock = socket.socket(family, socktype, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            sock.close()
            last_error = exc
    if last_error is not None:
        raise last_error
    raise OSError("connection failed")


class _GuardedHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self._create_connection = _create_public_connection
        super().connect()


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        self._create_connection = _create_public_connection
        super().connect()


class _GuardedHTTPHandler(urllib_request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_GuardedHTTPConnection, req)


class _GuardedHTTPSHandler(urllib_request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(
            _GuardedHTTPSConnection,
            req,
            context=ssl.create_default_context(),
        )


def _guarded_opener() -> urllib_request.OpenerDirector:
    """Opener with no proxy, no file handler, and no automatic redirects."""
    opener = urllib_request.OpenerDirector()
    opener.add_handler(urllib_request.ProxyHandler({}))
    opener.add_handler(_GuardedHTTPHandler())
    opener.add_handler(_GuardedHTTPSHandler())
    opener.add_handler(urllib_request.HTTPErrorProcessor())
    opener.add_handler(urllib_request.HTTPDefaultErrorHandler())
    return opener


def _read_limited(response, limit: int) -> tuple[bytes, bool]:
    chunks = []
    total = 0
    while total <= limit:
        chunk = response.read(min(65536, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            chunks.append(chunk)
            return b"".join(chunks)[:limit], True
        chunks.append(chunk)
    return b"".join(chunks), False


def _media_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _charset(content_type: str) -> str:
    match = re.search(r"charset=\s*([^;\s]+)", content_type, re.IGNORECASE)
    if not match:
        return "utf-8"
    name = match.group(1).strip("\"'")
    try:
        import codecs
        codecs.lookup(name)
    except LookupError:
        return "utf-8"
    return name


def _is_text_type(content_type: str, body: bytes) -> bool:
    media = _media_type(content_type)
    if not media:
        return b"\x00" not in body[:1024]
    if media.startswith("text/"):
        return True
    if media.endswith(("+json", "+xml", "+yaml")):
        return True
    return media in {
        "application/json",
        "application/xml",
        "application/javascript",
        "application/xhtml+xml",
        "application/markdown",
        "application/yaml",
        "application/x-yaml",
        "application/toml",
        "application/x-www-form-urlencoded",
        "application/graphql",
        "application/ld+json",
    }


def _is_html(content_type: str, text: str) -> bool:
    media = _media_type(content_type)
    if media in {"text/html", "application/xhtml+xml"}:
        return True
    if media:
        return False
    sample = text.lstrip()[:256].lower()
    return sample.startswith(("<!doctype html", "<html"))


def _safe_href(href: str | None) -> str | None:
    if not href:
        return None
    cleaned = href.strip()
    lowered = cleaned.lower()
    if lowered.startswith(("javascript:", "data:", "vbscript:", "file:")):
        return None
    return cleaned


def html_to_markdown(html: str) -> str:
    """Convert an HTML document to markdown text. Script and style are dropped."""
    parser = _MarkdownHTMLParser()
    parser.feed(html)
    parser.close()
    text = "".join(parser.parts)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class _MarkdownHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0
        self._href: str | None = None
        self._link_text: list[str] | None = None
        self._in_pre = False
        self._in_code = False

    def handle_starttag(self, tag, attrs):
        name = tag.lower()
        if name in {"script", "style", "noscript", "template", "svg", "head"}:
            self._skip += 1
            return
        if self._skip:
            return
        attributes = {key.lower(): value for key, value in attrs}
        if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n\n" + ("#" * int(name[1])) + " ")
        elif name in {"p", "div", "section", "article", "blockquote", "tr"}:
            self.parts.append("\n\n")
        elif name == "br":
            self.parts.append("\n")
        elif name == "li":
            self.parts.append("\n- ")
        elif name == "pre":
            self._in_pre = True
            self.parts.append("\n\n```\n")
        elif name == "code" and not self._in_pre:
            self._in_code = True
            self.parts.append("`")
        elif name == "a":
            self._href = _safe_href(attributes.get("href"))
            self._link_text = []
        elif name == "img":
            alt = attributes.get("alt") or ""
            if alt:
                self.parts.append(alt)

    def handle_endtag(self, tag):
        name = tag.lower()
        if name in {"script", "style", "noscript", "template", "svg", "head"}:
            if self._skip:
                self._skip -= 1
            return
        if self._skip:
            return
        if name == "pre" and self._in_pre:
            self._in_pre = False
            self.parts.append("\n```\n")
        elif name == "code" and self._in_code:
            self._in_code = False
            self.parts.append("`")
        elif name == "a" and self._link_text is not None:
            text = re.sub(r"\s+", " ", "".join(self._link_text)).strip()
            href = self._href
            self._href = None
            self._link_text = None
            if text and href:
                self.parts.append(f"[{text}]({href})")
            elif text:
                self.parts.append(text)
        elif name in {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip or not data:
            return
        if self._link_text is not None:
            self._link_text.append(data)
            return
        if not self._in_pre:
            data = re.sub(r"\s+", " ", data)
        self.parts.append(data)


def _format_body(url: str, status: int, content_type: str, raw: bytes, truncated: bool) -> str:
    if not _is_text_type(content_type, raw):
        shown = _media_type(content_type) or "binary"
        return f"Error: Response from {url} is {shown}, not text."
    text = raw.decode(_charset(content_type), errors="replace")
    if _is_html(content_type, text):
        try:
            text = html_to_markdown(text)
        except Exception:  # noqa: BLE001
            text = re.sub(r"<[^>]+>", " ", text)
    text = text.strip()
    if not text:
        text = "(empty)"
    media = _media_type(content_type) or "text"
    lines = [f"Fetched {url} (HTTP {status}, {media})", "", text]
    if truncated:
        lines.extend(["", f"[truncated at {MAX_RESPONSE_BYTES} bytes]"])
    body = "\n".join(lines)
    if status >= 400:
        return f"Error: HTTP {status} for {url}\n\n{body}"
    return body


def _header_map(headers) -> dict[str, str]:
    if headers is None:
        return {}
    location = None
    content_type = ""
    if hasattr(headers, "get"):
        location = headers.get("Location")
        content_type = headers.get("Content-Type") or headers.get("content-type") or ""
    return {"location": location or "", "content_type": content_type}


def fetch_url(url: str, *, opener=None) -> str:
    """GET `url` and return text or markdown. Raises FetchError when refused."""
    current = url.strip() if isinstance(url, str) else url
    open_request = opener.open if opener is not None else _guarded_opener().open
    for hop in range(MAX_REDIRECTS + 1):
        _require_public_url(current)
        request = urllib_request.Request(
            current,
            method="GET",
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/markdown, text/plain, text/html;q=0.9, application/json;q=0.8",
            },
        )
        try:
            response = open_request(request, timeout=TIMEOUT_SECONDS)
        except urllib_error.HTTPError as exc:
            # The except target is deleted when the clause ends.
            response = exc
        except TimeoutError as exc:
            raise FetchError(f"Fetch timed out after {TIMEOUT_SECONDS} seconds.") from exc
        except urllib_error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, TimeoutError):
                raise FetchError(
                    f"Fetch timed out after {TIMEOUT_SECONDS} seconds."
                ) from exc
            message = getattr(reason, "strerror", None) or str(reason)
            raise FetchError(f"Fetch failed: {message}") from exc
        status = getattr(response, "status", None)
        if status is None:
            status = getattr(response, "code", None)
        if status is None and hasattr(response, "getcode"):
            status = response.getcode()
        headers = _header_map(getattr(response, "headers", None))
        try:
            if status in _REDIRECT_CODES:
                location = headers["location"]
                if not location:
                    raise FetchError(f"HTTP {status} from {current} had no redirect target.")
                if hop == MAX_REDIRECTS:
                    raise FetchError("Too many redirects.")
                current = urllib_parse.urljoin(current, location.strip())
                continue
            raw, truncated = _read_limited(response, MAX_RESPONSE_BYTES)
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
        return _format_body(
            current,
            int(status or 0),
            headers["content_type"],
            raw,
            truncated,
        )
    raise FetchError("Too many redirects.")


@tool
def web_fetch(url: str) -> str:
    """
    Fetch a public http or https URL with GET and return text.

    HTML is converted to markdown. Other text, JSON, and XML bodies
    are returned as text. The body is limited to 1 MiB and the request
    times out after 20 seconds. Private, loopback, link-local, and
    metadata addresses are refused, including after DNS resolution and
    on redirects. A missing permission defaults to ask.

    Args:
        url: Absolute http or https URL.
    """
    try:
        return fetch_url(url)
    except FetchError as exc:
        return f"Error: {exc}"
    except Exception as exc:  # noqa: BLE001
        return f"Error: Fetch failed: {exc}"
