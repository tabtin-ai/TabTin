from __future__ import annotations

from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.services.search.services.base import (
    RuntimeSearchProviderConfig,
    SearchProviderError,
    SearchProviderOutcomeUnknown,
)
from apps.services.search.services.providers.qianfan import QianfanSearchProvider
from apps.services.search.services.types import SearchRequest


def _runtime_config(**overrides) -> RuntimeSearchProviderConfig:
    data = {
        "provider_type": "qianfan",
        "provider_key": "qianfan",
        "display_name": "千帆百度搜索",
        "base_url": "https://qianfan.baidubce.com/v2/ai_search/web_search",
        "api_key": "bce-v3/test-key",
        "api_key_source": "database",
        "request_timeout_sec": 15,
        "capabilities_config": {"summary": True},
        "extra_config": {"search_source": "baidu_search_v2"},
    }
    data.update(overrides)
    return RuntimeSearchProviderConfig(**data)


class QianfanSearchProviderTests(SimpleTestCase):
    def test_resolve_endpoint_variants(self):
        self.assertEqual(
            QianfanSearchProvider._resolve_endpoint(
                "https://qianfan.baidubce.com/v2/ai_search/web_search"
            ),
            "https://qianfan.baidubce.com/v2/ai_search/web_search",
        )
        self.assertEqual(
            QianfanSearchProvider._resolve_endpoint("https://qianfan.baidubce.com"),
            "https://qianfan.baidubce.com/v2/ai_search/web_search",
        )
        self.assertEqual(
            QianfanSearchProvider._resolve_endpoint("https://qianfan.baidubce.com/v2"),
            "https://qianfan.baidubce.com/v2/ai_search/web_search",
        )

    def test_truncate_query_respects_char_budget(self):
        # 汉字按 2 计：36 个汉字 = 72
        query = "测" * 40
        truncated = QianfanSearchProvider._truncate_query(query)
        self.assertEqual(len(truncated), 36)

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_search_maps_references(self, mock_post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "request_id": "req-qianfan-001",
            "references": [
                {
                    "id": 1,
                    "type": "web",
                    "title": "TabTin 完成融资",
                    "url": "https://example.com/news",
                    "website": "example.com",
                    "snippet": "摘要片段",
                    "content": "正文片段",
                    "date": "2026-07-27 00:00:00",
                    "icon": "https://example.com/icon.png",
                },
                {
                    "id": 2,
                    "type": "image",
                    "title": "配图",
                    "url": "https://example.com/page",
                    "image": {"url": "https://example.com/a.png", "width": "100", "height": "80"},
                },
            ],
        }
        mock_post.return_value = response

        provider = QianfanSearchProvider(_runtime_config())
        result = provider.search(
            SearchRequest(
                query="TabTin 融资",
                count=5,
                summary=True,
                freshness="oneWeek",
                include="example.com",
            )
        )

        self.assertEqual(result.provider_key, "qianfan")
        self.assertEqual(result.request_id, "req-qianfan-001")
        self.assertEqual(len(result.web_pages), 1)
        self.assertEqual(result.web_pages[0].name, "TabTin 完成融资")
        self.assertEqual(result.web_pages[0].summary, "摘要片段")
        self.assertEqual(len(result.images), 1)
        self.assertEqual(result.images[0].content_url, "https://example.com/a.png")

        _, kwargs = mock_post.call_args
        payload = kwargs["json"]
        self.assertEqual(payload["messages"][0]["content"], "TabTin 融资")
        self.assertEqual(payload["search_recency_filter"], "week")
        self.assertEqual(payload["resource_type_filter"][0]["top_k"], 5)
        self.assertEqual(payload["search_filter"]["match"]["site"], ["example.com"])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer bce-v3/test-key")

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_search_raises_on_business_error(self, mock_post):
        response = Mock()
        response.status_code = 200
        response.text = ""
        response.json.return_value = {
            "request_id": "req-err",
            "code": 216003,
            "message": "Authentication error",
        }
        mock_post.return_value = response

        provider = QianfanSearchProvider(_runtime_config())
        with self.assertRaises(SearchProviderError) as ctx:
            provider.search(SearchRequest(query="x", count=3, summary=False, freshness="noLimit"))
        self.assertEqual(ctx.exception.code, "qianfan_http_error")
        self.assertNotIsInstance(ctx.exception, SearchProviderOutcomeUnknown)

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_success_status_with_unparseable_body_is_outcome_unknown(self, mock_post):
        response = Mock()
        response.status_code = 200
        response.text = "truncated"
        response.json.side_effect = ValueError("truncated response")
        mock_post.return_value = response

        provider = QianfanSearchProvider(_runtime_config())
        with self.assertRaises(SearchProviderOutcomeUnknown) as ctx:
            provider.search(
                SearchRequest(
                    query="x",
                    count=3,
                    summary=False,
                    freshness="noLimit",
                )
            )

        self.assertEqual(ctx.exception.code, "qianfan_invalid_json")
