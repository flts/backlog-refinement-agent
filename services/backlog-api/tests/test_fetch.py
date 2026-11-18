"""URL fetching: SSRF guard, redirects, limits and HTML extraction (mocked resolver and transport)."""

from __future__ import annotations

import gzip
from collections.abc import AsyncIterator

import httpx
import pytest

from backlog_api.extraction import ExtractionLimits
from backlog_api.fetch import FetchPolicy, fetch_source, html_to_text, is_public_address
from backlog_api.problems import ProblemError

LIMITS = ExtractionLimits(max_bytes=10_000_000, max_pages=200, max_text_chars=1_000_000)
POLICY = FetchPolicy(timeout_seconds=5, max_bytes=2048, max_redirects=3)
PUBLIC_IP = "93.184.216.34"


def resolver_for(mapping: dict[str, list[str]]):
    async def resolve(host: str, port: int) -> list[str]:
        if host not in mapping:
            raise OSError("unknown host")
        return mapping[host]

    return resolve


def html_response(body: str, content_type: str = "text/html; charset=utf-8") -> httpx.Response:
    return httpx.Response(200, content=body.encode(), headers={"content-type": content_type})


async def failure(url: str, **kwargs) -> ProblemError:
    with pytest.raises(ProblemError) as info:
        await fetch_source(url, kwargs.pop("policy", POLICY), LIMITS, **kwargs)
    assert info.value.status == 422
    assert info.value.slug == "url-fetch-failed"
    return info.value


@pytest.mark.parametrize(
    ("address", "public"),
    [
        (PUBLIC_IP, True),
        ("8.8.8.8", True),
        ("2606:4700:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),  # noqa: S104
        ("224.0.0.1", False),
        ("240.0.0.1", False),
        ("192.0.2.1", False),
        ("::1", False),
        ("::", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("fd12:3456::1", False),
        ("ff02::1", False),
        ("::ffff:127.0.0.1", False),
        ("::ffff:10.0.0.1", False),
        ("64:ff9b::7f00:1", False),
        ("2002:7f00:0001::", False),
        ("not-an-ip", False),
    ],
)
def test_is_public_address(address: str, public: bool) -> None:
    assert is_public_address(address) is public


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",  # http not allowed
        "ftp://example.com/",
        "file:///etc/passwd",
        "https://user:pass@example.com/",
        "https://example.com:8443/",
        "https:///nohost",
        "not a url",
    ],
)
async def test_rejects_bad_urls_without_network(url: str) -> None:
    def no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not connect")

    await failure(url, resolver=resolver_for({}), transport=httpx.MockTransport(no_network))


@pytest.mark.parametrize(
    ("url", "resolved"),
    [
        ("https://localhost/", ["127.0.0.1"]),
        ("https://internal.example/", ["10.0.0.5"]),
        ("https://metadata.example/", ["169.254.169.254"]),
        ("https://v6.example/", ["::1"]),
        ("https://mixed.example/", [PUBLIC_IP, "192.168.0.10"]),
        ("https://127.0.0.1/", []),
        ("https://[::1]/", []),
        ("https://169.254.169.254/latest/meta-data/", []),
        ("https://10.0.0.1/", []),
        ("https://unknown.example/", []),
    ],
)
async def test_blocks_private_destinations(url: str, resolved: list[str]) -> None:
    def no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not connect")

    host = httpx.URL(url).host
    await failure(
        url, resolver=resolver_for({host: resolved} if resolved else {}), transport=httpx.MockTransport(no_network)
    )


async def test_redirect_to_private_address_is_blocked() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://evil.example/"})

    resolver = resolver_for({"good.example": [PUBLIC_IP], "evil.example": ["10.0.0.1"]})
    await failure("https://good.example/", resolver=resolver, transport=httpx.MockTransport(handler))
    assert seen == [f"https://{PUBLIC_IP}/"]


async def test_redirect_to_http_or_literal_private_ip_is_blocked() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest"})

    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    await failure("https://good.example/", resolver=resolver, transport=httpx.MockTransport(handler))


async def test_too_many_redirects() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(302, headers={"location": "https://good.example/next"})

    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    error = await failure("https://good.example/", resolver=resolver, transport=httpx.MockTransport(handler))
    assert "redirects" in (error.detail or "")
    assert calls == POLICY.max_redirects + 1


async def test_follows_valid_redirect_and_pins_connection() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/start":
            return httpx.Response(301, headers={"location": "/final"})
        return html_response("<html><head><title>Hi</title></head><body><p>Hello world</p></body></html>")

    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    fetched = await fetch_source(
        "https://good.example/start", POLICY, LIMITS, resolver=resolver, transport=httpx.MockTransport(handler)
    )
    assert fetched.extracted.text == "Hello world"
    assert fetched.title == "Hi"
    assert fetched.final_url == "https://good.example/final"
    assert [r.url.host for r in requests] == [PUBLIC_IP, PUBLIC_IP]
    assert all(r.headers["host"] == "good.example" for r in requests)
    assert all(r.extensions["sni_hostname"] == "good.example" for r in requests)


async def test_http_is_allowed_only_when_policy_says_so() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return html_response("<p>plain</p>")

    resolver = resolver_for({"dev.example": [PUBLIC_IP]})
    transport = httpx.MockTransport(handler)
    await failure("http://dev.example/", resolver=resolver, transport=transport)
    policy = FetchPolicy(allow_http=True, timeout_seconds=5, max_bytes=2048)
    fetched = await fetch_source("http://dev.example/", policy, LIMITS, resolver=resolver, transport=transport)
    assert fetched.extracted.text == "plain"


async def test_response_too_large_and_wrong_type_and_status() -> None:
    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    big = httpx.MockTransport(lambda request: html_response("x" * 5000, "text/plain"))
    assert "larger" in (await failure("https://good.example/", resolver=resolver, transport=big)).detail  # type: ignore[operator]
    image = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"GIF89a", headers={"content-type": "image/gif"})
    )
    await failure("https://good.example/", resolver=resolver, transport=image)
    missing = httpx.MockTransport(lambda request: httpx.Response(404))
    assert "404" in (await failure("https://good.example/", resolver=resolver, transport=missing)).detail  # type: ignore[operator]


async def test_connection_error_and_timeout() -> None:
    resolver = resolver_for({"good.example": [PUBLIC_IP]})

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    await failure("https://good.example/", resolver=resolver, transport=httpx.MockTransport(refuse))


async def test_plain_text_and_markdown_pass_through() -> None:
    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    transport = httpx.MockTransport(lambda request: html_response("# Title\r\n\r\nbody", "text/markdown"))
    fetched = await fetch_source(
        "https://good.example/readme.md", POLICY, LIMITS, resolver=resolver, transport=transport
    )
    assert fetched.extracted.text == "# Title\n\nbody"
    assert fetched.extracted.media_type == "text/markdown"


def test_html_to_text_drops_scripts_navigation_and_hidden() -> None:
    title, text = html_to_text(
        "<html><head><title> Page  title </title><style>p{}</style></head><body>"
        "<nav><a>Menu</a></nav><script>alert(1)</script><h1>Heading</h1><p>One <b>two</b></p>"
        "<div hidden>secret</div><ul><li>a</li><li>b</li></ul><footer>foot</footer></body></html>"
    )
    assert title == "Page title"
    assert "alert" not in text
    assert "Menu" not in text
    assert "secret" not in text
    assert "foot" not in text
    assert text == "Heading\n\nOne two\n\na\n\nb"


# --- additional SSRF edge cases (api-tests) --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "location",
    [
        "file:///etc/passwd",
        "ftp://good.example/file",
        "javascript:alert(1)",
        "data:text/html,<p>x</p>",
        "gopher://good.example/",
        "https://user:pw@good.example/",
        "https://good.example:8443/",
        "//evil.example/",  # protocol-relative, resolves to a private address
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:7f00:1]/",
    ],
)
async def test_redirects_to_unsafe_locations_are_refused_without_a_second_request(location: str) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": location})

    resolver = resolver_for({"good.example": [PUBLIC_IP], "evil.example": ["10.0.0.1"]})
    await failure("https://good.example/", resolver=resolver, transport=httpx.MockTransport(handler))
    assert len(requests) == 1


@pytest.mark.parametrize(
    "host",
    [
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:169.254.169.254]",
        "[::ffff:a00:1]",
        "[64:ff9b::7f00:1]",
        "[2002:7f00:1::]",
        "[0:0:0:0:0:ffff:127.0.0.1]",
        "[::127.0.0.1]",
        "[::]",
        "[::1]",
    ],
)
async def test_ipv6_literals_embedding_private_ipv4_addresses_are_blocked(host: str) -> None:
    def no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not connect")

    await failure(f"https://{host}/", resolver=resolver_for({}), transport=httpx.MockTransport(no_network))


@pytest.mark.parametrize("host", ["2130706433", "0x7f000001", "017700000001", "127.1", "0177.0.0.1", "0"])
async def test_numeric_ip_notations_for_loopback_are_never_fetched(host: str) -> None:
    """The system resolver turns these into 127.0.0.1 (or fails); either way no request may be sent."""

    def no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not connect")

    await failure(f"https://{host}/", transport=httpx.MockTransport(no_network))


async def test_dns_rebinding_between_resolution_and_connection_is_prevented_by_pinning() -> None:
    """The first answer is public, any later one is the metadata service: the connection uses the first answer."""
    lookups: list[str] = []
    requests: list[httpx.Request] = []

    async def rebinding_resolver(host: str, port: int) -> list[str]:
        lookups.append(host)
        return [PUBLIC_IP] if len(lookups) == 1 else ["169.254.169.254"]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return html_response("<p>fine</p>")

    fetched = await fetch_source(
        "https://rebind.example/", POLICY, LIMITS, resolver=rebinding_resolver, transport=httpx.MockTransport(handler)
    )
    assert fetched.extracted.text == "fine"
    assert lookups == ["rebind.example"]  # resolved once; the vetted address is what gets connected to
    assert [r.url.host for r in requests] == [PUBLIC_IP]
    assert requests[0].headers["host"] == "rebind.example"
    assert requests[0].extensions["sni_hostname"] == "rebind.example"


async def test_every_redirect_hop_is_resolved_and_vetted_separately() -> None:
    answers = {"a.example": [PUBLIC_IP], "b.example": ["10.0.0.9"]}
    lookups: list[str] = []
    requests: list[httpx.Request] = []

    async def resolver(host: str, port: int) -> list[str]:
        lookups.append(host)
        return answers[host]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": "https://b.example/"})

    await failure("https://a.example/", resolver=resolver, transport=httpx.MockTransport(handler))
    assert lookups == ["a.example", "b.example"]
    assert [r.url.host for r in requests] == [PUBLIC_IP]  # the private hop was never connected to


async def test_all_resolved_addresses_must_be_public() -> None:
    def no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not connect")

    resolver = resolver_for({"mixed.example": ["::ffff:10.0.0.1", PUBLIC_IP]})
    await failure("https://mixed.example/", resolver=resolver, transport=httpx.MockTransport(no_network))


def _gzip_response(payload: bytes, content_type: str = "text/plain") -> httpx.Response:
    return httpx.Response(
        200, content=gzip.compress(payload), headers={"content-type": content_type, "content-encoding": "gzip"}
    )


async def test_oversized_decoded_gzip_body_is_rejected_even_when_the_compressed_body_is_small() -> None:
    policy = FetchPolicy(timeout_seconds=5, max_bytes=20_000)
    bomb = gzip.compress(b"a" * 5_000_000)
    assert len(bomb) < policy.max_bytes
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, content=bomb, headers={"content-type": "text/plain", "content-encoding": "gzip"}
        )
    )
    error = await failure(
        "https://good.example/",
        policy=policy,
        resolver=resolver_for({"good.example": [PUBLIC_IP]}),
        transport=transport,
    )
    assert "larger" in (error.detail or "")


async def test_gzip_body_within_the_limit_is_decoded() -> None:
    transport = httpx.MockTransport(lambda request: _gzip_response(b"hello " * 100))
    fetched = await fetch_source(
        "https://good.example/",
        POLICY,
        LIMITS,
        resolver=resolver_for({"good.example": [PUBLIC_IP]}),
        transport=transport,
    )
    assert fetched.extracted.text.startswith("hello hello")


async def test_a_body_without_content_length_is_cut_off_at_the_limit() -> None:
    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(100):
            yield b"x" * 100

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=chunks(), headers={"content-type": "text/plain"})
    )
    error = await failure(
        "https://good.example/", resolver=resolver_for({"good.example": [PUBLIC_IP]}), transport=transport
    )
    assert "larger" in (error.detail or "")


async def test_a_lying_content_length_cannot_smuggle_a_larger_body() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, content=b"y" * 5000, headers={"content-type": "text/plain", "content-length": "10"}
        )
    )
    # httpx rejects the inconsistent response itself or the size guard catches it: it is never accepted.
    await failure("https://good.example/", resolver=resolver_for({"good.example": [PUBLIC_IP]}), transport=transport)


async def test_extracted_text_over_the_limit_is_rejected_after_fetching() -> None:
    small = ExtractionLimits(max_bytes=10_000_000, max_pages=200, max_text_chars=1000)
    transport = httpx.MockTransport(lambda request: html_response("word " * 300, "text/plain"))
    with pytest.raises(ProblemError) as info:
        await fetch_source(
            "https://good.example/",
            POLICY,
            small,
            resolver=resolver_for({"good.example": [PUBLIC_IP]}),
            transport=transport,
        )
    assert (info.value.status, info.value.slug) == (413, "source-too-large")


async def test_a_pdf_that_is_not_a_pdf_and_a_page_without_text_are_refused() -> None:
    resolver = resolver_for({"good.example": [PUBLIC_IP]})
    fake_pdf = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"<html>", headers={"content-type": "application/pdf"})
    )
    await failure("https://good.example/", resolver=resolver, transport=fake_pdf)
    empty = httpx.MockTransport(lambda request: html_response("<html><script>x()</script></html>"))
    with pytest.raises(ProblemError) as info:
        await fetch_source("https://good.example/", POLICY, LIMITS, resolver=resolver, transport=empty)
    assert info.value.slug == "no-text"
