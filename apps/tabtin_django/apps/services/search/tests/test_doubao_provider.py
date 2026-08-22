from __future__ import annotations

from unittest.mock import Mock, patch

import requests
from django.test import SimpleTestCase

from apps.services.search.services.base import (
    RuntimeSearchProviderConfig,
    SearchProviderError,
    SearchProviderOutcomeUnknown,
)
from apps.services.search.services.providers.doubao import DoubaoSearchProvider
from apps.services.search.services.types import SearchRequest


def _runtime_config(**overrides) -> RuntimeSearchProviderConfig:
    data = {
        "provider_type": "doubao",
        "provider_key": "doubao",
        "display_name": "豆包搜索 Custom 版",
        "base_url": "https://open.feedcoopapi.com/search_api/web_search",
        "api_key": "test-doubao-key",
        "api_key_source": "env:DOUBAO_SEARCH_API_KEY",
        "request_timeout_sec": 15,
        "capabilities_config": {"summary": True, "freshness": True, "image": False},
        "extra_config": {
            "variant": "custom",
            "need_content": False,
            "need_url": True,
            "auth_info_level": 0,
            "query_rewrite": False,
            "content_formats": "markdown",
            "max_content_chars": 20,
        },
    }
    data.update(overrides)
    return RuntimeSearchProviderConfig(**data)


def _request(**overrides) -> SearchRequest:
    data = {
        "query": "OpenAI 最新模型发布情况",
        "count": 10,
        "summary": True,
        "freshness": "oneMonth",
        "include": "",
        "exclude": "",
    }
    data.update(overrides)
    return SearchRequest(**data)


def _response(payload: dict, status_code: int = 200) -> Mock:
    response = Mock()
    response.status_code = status_code
    response.text = ""
    response.json.return_value = payload
    return response


class DoubaoSearchProviderTests(SimpleTestCase):
    def test_resolve_endpoint_variants(self):
        self.assertEqual(
            DoubaoSearchProvider._resolve_endpoint(
                "https://open.feedcoopapi.com/search_api/web_search"
            ),
            "https://open.feedcoopapi.com/search_api/web_search",
        )
        self.assertEqual(
            DoubaoSearchProvider._resolve_endpoint("https://open.feedcoopapi.com/search_api"),
            "https://open.feedcoopapi.com/search_api/web_search",
        )
        self.assertEqual(
            DoubaoSearchProvider._resolve_endpoint("https://open.feedcoopapi.com"),
            "https://open.feedcoopapi.com/search_api/web_search",
        )

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_default_custom_request_payload(self, mock_post):
        mock_post.return_value = _response({"ResponseMetadata": {"RequestId": "req"}, "Result": {}})

        DoubaoSearchProvider(_runtime_config()).search(_request(count=0, freshness="noLimit"))

        _, kwargs = mock_post.call_args
        payload = kwargs["json"]
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-doubao-key")
        self.assertEqual(payload["Query"], "OpenAI 最新模型发布情况")
        self.assertEqual(payload["SearchType"], "web")
        self.assertEqual(payload["Count"], 10)
        self.assertEqual(
            payload["Filter"],
            {"NeedContent": False, "NeedUrl": True, "NeedSummary": True, "AuthInfoLevel": 0},
        )
        self.assertEqual(payload["QueryControl"], {"QueryRewrite": False})
        self.assertEqual(payload["ContentFormats"], "markdown")
        self.assertNotIn("TimeRange", payload)
        for invalid_field in (
            "DocCount",
            "NeedBody",
            "NeedScore",
            "DomainWhiteList",
            "DomainBlackList",
            "Category",
        ):
            self.assertNotIn(invalid_field, payload)

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_custom_request_options(self, mock_post):
        mock_post.return_value = _response({"ResponseMetadata": {"RequestId": "req"}, "Result": {}})
        provider = DoubaoSearchProvider(
            _runtime_config(
                extra_config={
                    "need_content": True,
                    "need_url": True,
                    "authoritative_only": True,
                    "query_rewrite": True,
                    "content_formats": "text",
                    "industry": "finance",
                }
            )
        )

        provider.search(
            _request(
                count=99,
                freshness="2026-07-01..2026-08-01",
                include="https://aliyun.com/docs, kubernetes.io/path | aliyun.com",
                exclude="https://spam.example/a; bad.example:443, third.example, fourth.example, fifth.example, sixth.example",
            )
        )

        payload = mock_post.call_args.kwargs["json"]
        self.assertEqual(payload["Count"], 50)
        self.assertEqual(payload["Filter"]["NeedContent"], True)
        self.assertEqual(payload["Filter"]["NeedUrl"], True)
        self.assertEqual(payload["Filter"]["AuthInfoLevel"], 1)
        self.assertEqual(payload["Filter"]["Sites"], "aliyun.com|kubernetes.io")
        self.assertEqual(
            payload["Filter"]["BlockHosts"],
            "spam.example|bad.example|third.example|fourth.example|fifth.example",
        )
        self.assertEqual(payload["TimeRange"], "2026-07-01..2026-08-01")
        self.assertEqual(payload["QueryControl"]["QueryRewrite"], True)
        self.assertEqual(payload["ContentFormats"], "text")
        self.assertEqual(payload["Industry"], "finance")

    def test_time_range_mapping(self):
        cases = {
            "day": "OneDay",
            "1d": "OneDay",
            "oneDay": "OneDay",
            "week": "OneWeek",
            "1w": "OneWeek",
            "oneWeek": "OneWeek",
            "month": "OneMonth",
            "1m": "OneMonth",
            "oneMonth": "OneMonth",
            "year": "OneYear",
            "1y": "OneYear",
            "oneYear": "OneYear",
            "noLimit": "",
            "1h": "",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(DoubaoSearchProvider._time_range(raw), expected)

    def test_invalid_inputs_raise_before_provider_call(self):
        provider = DoubaoSearchProvider(_runtime_config())
        with self.assertRaises(SearchProviderError) as query_ctx:
            provider.search(_request(query="   "))
        self.assertEqual(query_ctx.exception.code, "doubao_query_required")

        with self.assertRaises(SearchProviderError) as date_ctx:
            provider.search(_request(freshness="2026-08-01..2026-07-01"))
        self.assertEqual(date_ctx.exception.code, "doubao_time_range_invalid")

        with self.assertRaises(SearchProviderError) as industry_ctx:
            DoubaoSearchProvider(_runtime_config(extra_config={"industry": "tech"})).search(_request())
        self.assertEqual(industry_ctx.exception.code, "doubao_industry_unsupported")

        with self.assertRaises(SearchProviderError) as type_ctx:
            DoubaoSearchProvider(_runtime_config(extra_config={"search_type": "image"})).search(_request())
        self.assertEqual(type_ctx.exception.code, "doubao_search_type_unsupported")

    def test_truncate_query_respects_custom_limit(self):
        query = "测" * 120
        self.assertEqual(len(DoubaoSearchProvider._normalize_query(query)), 100)

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_search_maps_custom_response(self, mock_post):
        mock_post.return_value = _response(
            {
                "ResponseMetadata": {"RequestId": "doubao-req-001"},
                "Result": {
                    "ResultCount": 3,
                    "TimeCost": 123,
                    "LogId": "doubao-log-001",
                    "SearchContext": {"OriginQuery": "OpenAI 模型"},
                    "WebResults": [
                        {
                            "Id": "doc-1",
                            "SortId": 2,
                            "Title": "OpenAI 发布新模型",
                            "SiteName": "example.com",
                            "Url": "https://example.com/openai",
                            "Snippet": "短摘要",
                            "Summary": "更适合模型引用的长摘要",
                            "Content": "完整正文不会进入 snippet",
                            "PublishTime": "2025-05-30T19:35:24+08:00",
                            "LogoUrl": "https://example.com/logo.png",
                            "RankScore": 0.92,
                            "AuthInfoDes": "权威媒体",
                            "AuthInfoLevel": 1,
                            "ContentFormats": "markdown",
                        },
                        {
                            "Id": "doc-2",
                            "Title": "只有正文",
                            "Url": "https://example.com/content",
                            "Content": "这是一段非常长的正文内容，需要截断后才能进入模型上下文。",
                        },
                        {
                            "Id": "doc-3",
                            "Title": "缺少 URL",
                            "Summary": "不可引用结果应跳过",
                        },
                    ],
                },
            }
        )

        result = DoubaoSearchProvider(_runtime_config()).search(_request(query="OpenAI 模型"))

        self.assertEqual(result.provider_key, "doubao")
        self.assertEqual(result.request_id, "doubao-req-001")
        self.assertEqual(result.provider_log_id, "doubao-log-001")
        self.assertEqual(result.latency_ms, 123)
        self.assertEqual(result.total_estimated_matches, 3)
        self.assertEqual(len(result.web_pages), 2)
        self.assertEqual(result.web_pages[0].summary, "更适合模型引用的长摘要")
        self.assertEqual(result.web_pages[0].snippet, "短摘要")
        self.assertEqual(result.web_pages[0].site_icon, "https://example.com/logo.png")
        self.assertEqual(result.web_pages[1].summary, "这是一段非常长的正文内容，需要截断后才能")
        self.assertEqual(result.raw["_tabtin"]["provider_variant"], "custom")
        self.assertEqual(result.raw["_tabtin"]["origin_query"], "OpenAI 模型")
        meta = result.raw["_tabtin"]["web_results"][0]
        self.assertEqual(meta["provider_result_id"], "doc-1")
        self.assertEqual(meta["rank"], 2)
        self.assertEqual(meta["relevance_score"], 0.92)
        self.assertEqual(meta["authority_label"], "权威媒体")
        self.assertEqual(meta["authority_level"], 1)
        self.assertEqual(meta["content_format"], "markdown")

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_search_handles_empty_or_null_result(self, mock_post):
        for payload in (
            {"ResponseMetadata": {"RequestId": "req-null"}, "Result": None},
            {"ResponseMetadata": {"RequestId": "req-empty"}, "Result": {"WebResults": []}},
        ):
            with self.subTest(payload=payload):
                mock_post.return_value = _response(payload)
                result = DoubaoSearchProvider(_runtime_config()).search(_request())
                self.assertEqual(result.web_pages, [])

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_non_retryable_business_errors(self, mock_post):
        for upstream_code in ("10400", "10403", "10412"):
            with self.subTest(upstream_code=upstream_code):
                mock_post.return_value = _response(
                    {
                        "ResponseMetadata": {
                            "RequestId": "doubao-req-err",
                            "Error": {"Code": upstream_code, "Message": "blocked"},
                        }
                    }
                )
                with self.assertRaises(SearchProviderError) as ctx:
                    DoubaoSearchProvider(_runtime_config()).search(_request())
                self.assertEqual(ctx.exception.code, "doubao_business_error")
                self.assertFalse(ctx.exception.details["retryable"])
                self.assertNotIn("test-doubao-key", str(ctx.exception))

    @patch("apps.services.search.services.providers.doubao.time.sleep")
    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_retryable_business_error_retries_when_enabled(self, mock_post, mock_sleep):
        mock_post.side_effect = [
            _response(
                {
                    "ResponseMetadata": {
                        "RequestId": "doubao-req-err",
                        "Error": {"Code": "700429", "Message": "rate limited"},
                    }
                }
            ),
            _response({"ResponseMetadata": {"RequestId": "req-ok"}, "Result": {}}),
        ]

        provider = DoubaoSearchProvider(
            _runtime_config(extra_config={"max_retries": 1, "retry_backoff_ms": 1})
        )
        result = provider.search(_request())

        self.assertEqual(result.request_id, "req-ok")
        self.assertEqual(mock_post.call_count, 2)
        mock_sleep.assert_called_once()

    @patch("apps.services.search.services.providers.doubao.time.sleep")
    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_retryable_http_and_timeout_errors(self, mock_post, mock_sleep):
        mock_post.side_effect = [
            requests.ReadTimeout("timeout"),
            _response({"ResponseMetadata": {"RequestId": "req-ok"}, "Result": {}}),
        ]
        provider = DoubaoSearchProvider(
            _runtime_config(extra_config={"max_retries": 1, "retry_backoff_ms": 1})
        )

        result = provider.search(_request())

        self.assertEqual(result.request_id, "req-ok")
        self.assertEqual(mock_post.call_count, 2)
        mock_sleep.assert_called_once()

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_retryable_http_error_marks_details(self, mock_post):
        for status_code in (429, 500):
            with self.subTest(status_code=status_code):
                mock_post.return_value = _response(
                    {"ResponseMetadata": {"RequestId": f"req-{status_code}"}},
                    status_code=status_code,
                )

                with self.assertRaises(SearchProviderError) as ctx:
                    DoubaoSearchProvider(_runtime_config()).search(_request())

                self.assertEqual(ctx.exception.code, "doubao_http_error")
                self.assertTrue(ctx.exception.details["retryable"])

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_retryable_inner_error_marks_details(self, mock_post):
        mock_post.return_value = _response(
            {
                "ResponseMetadata": {
                    "RequestId": "req-10500",
                    "Error": {"Code": "10500", "Message": "inner error"},
                }
            }
        )

        with self.assertRaises(SearchProviderError) as ctx:
            DoubaoSearchProvider(_runtime_config()).search(_request())

        self.assertEqual(ctx.exception.code, "doubao_business_error")
        self.assertTrue(ctx.exception.details["retryable"])

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_connection_error_is_retryable_without_leaking_key(self, mock_post):
        mock_post.side_effect = requests.ConnectionError("network down")

        with self.assertRaises(SearchProviderError) as ctx:
            DoubaoSearchProvider(_runtime_config()).search(_request())

        self.assertEqual(ctx.exception.code, "doubao_request_failed")
        self.assertIsInstance(ctx.exception, SearchProviderOutcomeUnknown)
        self.assertTrue(ctx.exception.details["retryable"])
        self.assertNotIn("test-doubao-key", str(ctx.exception))

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_success_status_with_unparseable_body_is_outcome_unknown(self, mock_post):
        response = _response({}, status_code=200)
        response.text = "truncated"
        response.json.side_effect = ValueError("truncated response")
        mock_post.return_value = response

        with self.assertRaises(SearchProviderOutcomeUnknown) as ctx:
            DoubaoSearchProvider(_runtime_config()).search(_request())

        self.assertEqual(ctx.exception.code, "doubao_invalid_json")
