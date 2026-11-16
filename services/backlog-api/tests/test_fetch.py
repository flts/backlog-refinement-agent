"""URL fetching: SSRF guard, redirects, limits and HTML extraction (mocked resolver and transport)."""

from __future__ import annotations

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
