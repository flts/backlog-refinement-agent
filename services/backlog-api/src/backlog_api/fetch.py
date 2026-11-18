"""Server-side URL fetching for URL sources, guarded against SSRF.

Policy (every hop, including redirects, is validated again):

* ``https`` only; ``http`` only when :attr:`Settings.fetch_allows_http` (``BACKLOG_ENV=development`` *and*
  ``BACKLOG_URL_FETCH_ALLOW_HTTP=true``). No credentials in the URL, only the default ports (443 / 80).
* The host is resolved once and **every** returned address must be a public unicast address (private, loopback,
  link-local, multicast, reserved, CGNAT, unique-local and unspecified ranges are rejected, as are IPv4-mapped / NAT64 /
  6to4 forms of them). The connection is then **pinned to the vetted IP**: the request goes to the IP literal with the
  original ``Host`` header and TLS SNI/certificate verification against the original hostname, so DNS rebinding between
  check and connect is not possible.
* Redirects are followed manually (at most ``url_fetch_max_redirects``), each target re-validated.
* Timeout for the whole fetch, response size limit (streamed), no cookies, no JavaScript, only text/html, text/plain,
  text/markdown and application/pdf are accepted.

All failures surface as 422 ``url-fetch-failed`` so the client can offer the pasted-text fallback.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import anyio
import httpx

from backlog_api.extraction import (
    PDF_MEDIA_TYPE,
    ExtractedText,
    ExtractionLimits,
    extract_pdf_async,
    extract_text_document,
    media_type_of,
    normalize_text,
)
from backlog_api.problems import ProblemError

MAX_URL_LENGTH = 2048
ACCEPT_HEADER = "text/html, text/plain, text/markdown, application/pdf;q=0.9, */*;q=0.1"
_HTML_TYPES = {"text/html", "application/xhtml+xml"}
_TEXT_TYPES = {"text/plain", "text/markdown", "text/x-markdown"}
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_DEFAULT_PORTS = {"https": 443, "http": 80}

Resolver = Callable[[str, int], Awaitable[list[str]]]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_SIX_TO_FOUR = ipaddress.ip_network("2002::/16")
_IPV4_COMPATIBLE = ipaddress.ip_network("::/96")  # deprecated ::a.b.c.d form


def fetch_failed(detail: str) -> ProblemError:
    return ProblemError(
        422,
        "url-fetch-failed",
        title="The URL could not be fetched",
        detail=f"{detail} You can paste the page text instead.",
    )


@dataclass(frozen=True, slots=True)
class FetchPolicy:
    allow_http: bool = False
    timeout_seconds: float = 10.0
    max_bytes: int = 2 * 1024 * 1024
    max_redirects: int = 3


@dataclass(frozen=True, slots=True)
class FetchedSource:
    extracted: ExtractedText
    title: str | None
    final_url: str


async def system_resolver(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def _embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address in _NAT64:
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    if address in _SIX_TO_FOUR:
        return ipaddress.IPv4Address((int(address) >> 80) & 0xFFFFFFFF)
    if address in _IPV4_COMPATIBLE:
        return ipaddress.IPv4Address(int(address))
    return None


def is_public_address(value: str) -> bool:
    try:
        address: IPAddress = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(address)
        if embedded is not None:
            return is_public_address(str(embedded))
    return address.is_global and not address.is_multicast


def validate_url(url: str, policy: FetchPolicy) -> httpx.URL:
    """Syntax and scheme checks (no DNS). Raises ``url-fetch-failed`` for URLs this server refuses to fetch."""
    if len(url) > MAX_URL_LENGTH:
        raise fetch_failed("The URL is too long.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise fetch_failed("The URL is not valid.") from None
    scheme = parts.scheme.lower()
    allowed = {"https", "http"} if policy.allow_http else {"https"}
    if scheme not in allowed:
        raise fetch_failed("Only https:// URLs can be fetched.")
    if not parts.hostname or parts.username or parts.password:
        raise fetch_failed("Enter an absolute URL without credentials.")
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        raise fetch_failed("Only the default port of the URL scheme can be fetched.")
    try:
        return httpx.URL(parts._replace(fragment="").geturl())
    except httpx.InvalidURL:
        raise fetch_failed("The URL is not valid.") from None


async def _vetted_address(host: str, resolver: Resolver, port: int) -> str:
    try:
        addresses = [host] if _is_ip_literal(host) else await resolver(host, port)
    except OSError:
        raise fetch_failed("The host name could not be resolved.") from None
    if not addresses:
        raise fetch_failed("The host name could not be resolved.")
    if not all(is_public_address(address) for address in addresses):
        raise fetch_failed("The URL points to a non-public address, which is not allowed.")
    return addresses[0]


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


def _pinned_request(client: httpx.AsyncClient, url: httpx.URL, address: str) -> httpx.Request:
    host = url.host
    return client.build_request(
        "GET",
        url.copy_with(host=address),
        headers={"Host": host, "Accept": ACCEPT_HEADER, "User-Agent": "backlog-source-fetcher/1.0"},
        extensions={"sni_hostname": host},
    )


async def _read_limited(response: httpx.Response, max_bytes: int) -> bytes:
    """Read the (decoded) body, so compressed responses cannot exceed the limit after decompression."""
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise fetch_failed("The page is larger than the allowed size.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > max_bytes:
            raise fetch_failed("The page is larger than the allowed size.")
        chunks.append(chunk)
    return b"".join(chunks)


async def _fetch_bytes(
    url: str, policy: FetchPolicy, resolver: Resolver, transport: httpx.AsyncBaseTransport | None
) -> tuple[bytes, str, str, str | None]:
    """Returns ``(body, media type, final url, charset)``."""
    current = validate_url(url, policy)
    async with httpx.AsyncClient(
        transport=transport, follow_redirects=False, trust_env=False, timeout=policy.timeout_seconds
    ) as client:
        for _ in range(policy.max_redirects + 1):
            port = current.port or _DEFAULT_PORTS[current.scheme]
            address = await _vetted_address(current.host, resolver, port)
            request = _pinned_request(client, current, address)
            try:
                response = await client.send(request, stream=True)
            except (httpx.HTTPError, httpx.InvalidURL):  # InvalidURL: a malformed redirect Location
                raise fetch_failed("The server could not be reached.") from None
            try:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise fetch_failed("The server sent an invalid redirect.")
                    current = validate_url(urljoin(str(current), location), policy)
                    continue
                if response.status_code != 200:
                    raise fetch_failed(f"The server answered with HTTP {response.status_code}.")
                content_type = response.headers.get("content-type", "")
                media_type = media_type_of(content_type)
                if media_type not in _HTML_TYPES | _TEXT_TYPES | {PDF_MEDIA_TYPE}:
                    raise fetch_failed("Only HTML, plain text, Markdown and PDF pages can be imported.")
                body = await _read_limited(response, policy.max_bytes)
                charset = re.search(r"charset=([\w\-]+)", content_type, re.IGNORECASE)
                return body, media_type, str(current), charset.group(1) if charset else None
            except httpx.HTTPError:
                raise fetch_failed("The response could not be read.") from None
            finally:
                await response.aclose()
    raise fetch_failed("The URL redirects too often.")


def _decode(body: bytes, charset: str | None) -> str:
    for encoding in (charset, "utf-8"):
        if not encoding:
            continue
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


async def fetch_source(
    url: str,
    policy: FetchPolicy,
    limits: ExtractionLimits,
    *,
    resolver: Resolver = system_resolver,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FetchedSource:
    """Fetch ``url`` under the SSRF policy and extract its text. Fetch problems raise ``url-fetch-failed`` (422)."""
    try:
        with anyio.fail_after(policy.timeout_seconds):
            body, media_type, final_url, charset = await _fetch_bytes(url, policy, resolver, transport)
    except TimeoutError:
        raise fetch_failed("The server took too long to answer.") from None
    if media_type == PDF_MEDIA_TYPE:
        if not body.startswith(b"%PDF-"):
            raise fetch_failed("The server did not return a valid PDF.")
        return FetchedSource(await extract_pdf_async(body, limits=limits), None, final_url)
    decoded = _decode(body, charset)
    if media_type in _HTML_TYPES:
        title, text = await anyio.to_thread.run_sync(html_to_text, decoded)
        extracted = extract_text_document(text, limits=limits, media_type="text/html")
        return FetchedSource(extracted, title, final_url)
    return FetchedSource(extract_text_document(decoded, limits=limits, media_type=media_type), None, final_url)


# --- HTML → readable text ---------------------------------------------------------------------------------------

_VOID = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split(),
)
_IGNORED = frozenset(
    "script style noscript template iframe object embed svg math head nav footer aside form select textarea button"
    " dialog".split(),
)
_BLOCK = frozenset(
    "address article blockquote br dd div dl dt fieldset figcaption figure h1 h2 h3 h4 h5 h6 header hr li main ol p pre"
    " section table tr ul".split(),
)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self._stack: list[tuple[str, bool]] = []  # (tag, hides content)
        self._open: Counter[str] = Counter()  # open tags by name, so a stray end tag is detected without a scan
        self._hidden = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        if tag in _VOID:
            if tag in _BLOCK and not self._hidden:
                self.parts.append("\n")
            return
        attr_names = dict(attrs)
        hides = tag in _IGNORED or "hidden" in attr_names or (attr_names.get("aria-hidden") or "").lower() == "true"
        self._stack.append((tag, hides))
        self._open[tag] += 1
        if hides:
            self._hidden += 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _VOID:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in _VOID or self._open[tag] <= 0:
            return
        while self._stack:
            open_tag, hides = self._stack.pop()
            self._open[open_tag] -= 1
            if hides:
                self._hidden -= 1
            if open_tag == tag:
                break
        if tag in _BLOCK and not self._hidden:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if not self._hidden:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str | None, str]:
    """Return ``(title, readable text)``: scripts, styles, navigation, forms and hidden elements are dropped."""
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    title = " ".join("".join(parser.title_parts).split()) or None
    return title, normalize_text("".join(parser.parts), collapse_spaces=True)
