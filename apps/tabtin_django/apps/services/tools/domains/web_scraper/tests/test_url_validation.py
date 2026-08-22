"""Strict scrape URL validation — reject illegal schemes/hosts/ports before request."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from apps.services.tools.domains.web_scraper.scraper_tools import (
    WebScraperScrapeUrlTool,
    _sanitize_url_for_observability,
    _validate_url,
)
from apps.services.tools.error_envelope import is_standard_tool_error


@pytest.mark.parametrize(
    "raw",
    [
        "ftp://example.com/x",
        "file:///etc/passwd",
        "javascript://example.com/x",
    ],
)
def test_validate_url_rejects_explicit_non_http_schemes(raw: str):
    with pytest.raises(ValueError, match="scheme"):
        _validate_url(raw)


def test_validate_url_rejects_missing_hostname_with_userinfo():
    with pytest.raises(ValueError):
        _validate_url("https://user:pw@/path")


def test_validate_url_rejects_userinfo_credentials():
    with pytest.raises(ValueError, match="credential|userinfo"):
        _validate_url("https://user:pw@example.com/x")


def test_validate_url_rejects_whitespace_in_hostname():
    with pytest.raises(ValueError):
        _validate_url("https://exam ple.com/x")


@pytest.mark.parametrize("raw", ["https://example.com:0/x", "https://example.com:99999/x"])
def test_validate_url_rejects_out_of_range_ports(raw: str):
    with pytest.raises(ValueError, match="[Pp]ort"):
        _validate_url(raw)


def test_validate_url_accepts_ipv6_literal():
    assert _validate_url("https://[2001:db8::1]/x") == "https://[2001:db8::1]/x"


def test_validate_url_accepts_explicit_valid_port():
    assert _validate_url("https://example.com:8443/x") == "https://example.com:8443/x"


def test_validate_url_prepends_https_only_when_scheme_missing():
    assert _validate_url("example.com/path") == "https://example.com/path"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("example.com:8443/path", "https://example.com:8443/path"),
        ("localhost:8000/path", "https://localhost:8000/path"),
        ("127.0.0.1:9000/path", "https://127.0.0.1:9000/path"),
        ("[2001:db8::1]:9443/path", "https://[2001:db8::1]:9443/path"),
    ],
)
def test_validate_url_treats_valid_host_port_as_scheme_less_authority(
    raw: str,
    expected: str,
):
    assert _validate_url(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "ssh:22",
        "custom:123/path",
        "foo:443",
    ],
)
def test_validate_url_rejects_single_label_scheme_port_ambiguity(raw: str):
    with pytest.raises(ValueError, match="scheme"):
        _validate_url(raw)


def test_validate_url_accepts_explicit_https_single_label_host_with_port():
    assert _validate_url("https://custom:123/path") == "https://custom:123/path"


def test_validate_url_rejects_malformed_ipv4_authority():
    with pytest.raises(ValueError, match="authority|host"):
        _validate_url("999.999.999.999:8443/path")


@pytest.mark.parametrize(
    "raw",
    [
        "ftp://example.com/x",
        "file:/etc/passwd",
        "javascript:alert(1)",
        "data:text/plain,hello",
    ],
)
def test_validate_url_rejects_explicit_scheme_forms(raw: str):
    with pytest.raises(ValueError, match="scheme"):
        _validate_url(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "https://example.com/a\x00b",
        "https://example.com/a\rb",
        "https://example.com/a\nb",
        "https://example.com/a\x7fb",
        " https://example.com/path",
        "https://example.com/path ",
        "https://example.com/a\tb",
    ],
)
def test_validate_url_rejects_control_characters_and_whitespace(raw: str):
    with pytest.raises(ValueError, match="character|whitespace"):
        _validate_url(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "https://example.com/a\x00b",
        "https://example.com/a\rb",
        "https://example.com/a\nb",
        "https://example.com/a\x7fb",
    ],
)
def test_sanitizer_never_emits_control_characters(raw: str):
    sanitized = _sanitize_url_for_observability(raw)
    assert sanitized == "[invalid-url]"
    assert not any(ord(ch) < 32 or ord(ch) == 127 for ch in sanitized)


def test_illegal_scheme_is_not_rewritten_or_requested():
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync"
    ) as fetch:
        payload = WebScraperScrapeUrlTool().run(url="ftp://example.com/x")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    fetch.assert_not_called()


@pytest.mark.parametrize(
    "raw",
    [
        "https://example.com/a\x00b",
        "https://example.com/a\r\nX-Injected: yes",
        "https://example.com/a\x7fb",
    ],
)
def test_invalid_url_characters_are_not_requested(raw: str):
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync"
    ) as fetch:
        payload = WebScraperScrapeUrlTool().run(url=raw)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    fetch.assert_not_called()


def test_out_of_range_port_is_not_requested():
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync"
    ) as fetch:
        payload = WebScraperScrapeUrlTool().run(url="https://example.com:99999/x")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    fetch.assert_not_called()
