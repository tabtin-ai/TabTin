"""web_scraper 失败路径迁移到标准 error envelope。"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from apps.services.tools.domains.web_scraper.scraper_tools import WebScraperScrapeUrlTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_scrape_url_playwright_rejected_uses_standard_envelope():
    payload = WebScraperScrapeUrlTool().run(
        url="https://example.com",
        engine="playwright",
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "host_unsupported"
    assert payload["retryable"] is False


def test_scrape_url_invalid_url_uses_standard_envelope():
    payload = WebScraperScrapeUrlTool().run(url="   ")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"


def test_scrape_url_network_failure_is_sanitized():
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync",
        side_effect=RuntimeError("https://user:secret@host/x"),
    ), patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.logger.warning"
    ) as log_warning:
        payload = WebScraperScrapeUrlTool().run(url="https://example.com")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "network_failed"
    assert "secret" not in payload["error"]
    assert "secret" not in repr(log_warning.call_args_list)


def test_scrape_url_ssrf_probe_is_non_retryable_policy_failure():
    target = (
        "http://127.0.0.1/private"
        "?token=query-secret&view=full#fragment-secret"
    )
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.logger.warning"
    ) as log_warning:
        payload = WebScraperScrapeUrlTool().run(url=target)

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "permission_denied"
    assert payload["retryable"] is False
    assert payload["url"] == "http://127.0.0.1/private"
    serialized = repr(payload) + repr(log_warning.call_args_list)
    for secret in ("query-secret", "fragment-secret"):
        assert secret not in serialized


def test_scrape_url_network_failure_redacts_sensitive_url_parts():
    target = (
        "https://example.com/path"
        "?page=2&api_key=query-secret&password=pass-secret"
        "&refresh_token=refresh-secret&client_secret=client-secret#fragment-secret"
    )
    with patch(
        "apps.services.common.url_security.ssrf_safe_request_async",
        new=AsyncMock(side_effect=ConnectionError("network down")),
    ), patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.logger.warning"
    ) as log_warning:
        payload = WebScraperScrapeUrlTool().run(url=target)

    assert payload["error_kind"] == "network_failed"
    assert payload["retryable"] is True
    assert payload["url"] == "https://example.com/path"
    serialized = repr(payload) + repr(log_warning.call_args_list)
    for secret in (
        "query-secret",
        "pass-secret",
        "refresh-secret",
        "client-secret",
        "fragment-secret",
    ):
        assert secret not in serialized


def test_scrape_url_rejects_userinfo_before_request():
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync"
    ) as fetch:
        payload = WebScraperScrapeUrlTool().run(
            url="https://user:supersecret@example.com/path"
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert "supersecret" not in repr(payload)
    fetch.assert_not_called()


def test_scrape_success_redacts_all_query_keys_from_payload_and_logs():
    request_url = (
        "https://example.com:8443/start"
        "?session_id=session-secret&foo=foo-secret#request-fragment"
    )
    final_url = (
        "https://redirect-user:redirect-secret@redirect.example:9443/final/path"
        "?code=code-secret&jwt=jwt-secret&sid=sid-secret&foo=final-secret"
        "#redirect-fragment"
    )
    page_data = {
        "html": "<html><title>Safe page</title><body>ok</body></html>",
        "title": "Safe page",
        "status_code": 200,
        "url": final_url,
        "engine": "httpx",
    }
    with patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.async_to_sync",
        return_value=lambda *args, **kwargs: page_data,
    ), patch(
        "apps.services.tools.domains.web_scraper.scraper_tools.logger.info"
    ) as log_info:
        payload = WebScraperScrapeUrlTool().run(
            url=request_url,
            output_mode="json",
        )

    assert payload["success"] is True
    expected = "https://redirect.example:9443/final/path"
    assert payload["url"] == expected
    assert payload["content"]["url"] == expected
    serialized = repr(payload) + repr(log_info.call_args_list)
    for secret in (
        "session-secret",
        "foo-secret",
        "request-fragment",
        "redirect-secret",
        "code-secret",
        "jwt-secret",
        "sid-secret",
        "final-secret",
        "redirect-fragment",
    ):
        assert secret not in serialized
