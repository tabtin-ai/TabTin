from __future__ import annotations

from decimal import Decimal
from unittest.mock import Mock, patch

from django.test import TestCase, override_settings

from apps.services.billing.models import (
    BillingUsageEvent,
    MeterPricing,
    OrganizationBillingPolicy,
)
from apps.services.billing.services.pricing_service import MeterPricingService
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.search.constants import SEARCH_BILLING_METER_KEY
from apps.services.search.models import SearchGlobalConfig, SearchProvider
from apps.services.search.services.base import SearchProviderError
from apps.services.search.services.search_service import SearchService
from apps.users.wallet.models import OrganizationWallet


@override_settings(
    BILLING_LEGACY_NON_LLM_USAGE_CHARGE_ENABLED=True,
    DOUBAO_SEARCH_API_KEY="sk-test-doubao",
)
class SearchServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        MeterPricingService.invalidate_cache()
        self.organization_id = org_id_for("ws_search_001")
        self.no_balance_organization_id = org_id_for("ws_search_no_balance")
        self.provider, _ = SearchProvider.objects.update_or_create(
            provider_key="bocha",
            defaults={
                "provider_type": "bocha",
                "display_name": "博查搜索",
                "base_url": "https://api.bocha.cn/v1/web-search",
                "api_key": "sk-test-bocha",
                "api_key_env_name": "BOCHA_API_KEY",
                "request_timeout_sec": 15,
                "is_active": True,
                "priority": 100,
                "capabilities_config": {"summary": True},
                "extra_config": {},
            },
        )
        self.qianfan_provider, _ = SearchProvider.objects.update_or_create(
            provider_key="qianfan",
            defaults={
                "provider_type": "qianfan",
                "display_name": "千帆百度搜索",
                "base_url": "https://qianfan.baidubce.com/v2/ai_search/web_search",
                "api_key": "sk-test-qianfan",
                "api_key_env_name": "QIANFAN_API_KEY",
                "request_timeout_sec": 15,
                "is_active": True,
                "priority": 90,
                "capabilities_config": {"summary": True},
                "extra_config": {"search_source": "baidu_search_v2"},
            },
        )
        self.doubao_provider, _ = SearchProvider.objects.update_or_create(
            provider_key="doubao",
            defaults={
                "provider_type": "doubao",
                "display_name": "豆包搜索 Custom 版",
                "base_url": "https://open.feedcoopapi.com/search_api/web_search",
                "api_key": "sk-test-doubao",
                "api_key_env_name": "DOUBAO_SEARCH_API_KEY",
                "request_timeout_sec": 15,
                "is_active": True,
                "priority": 80,
                "capabilities_config": {"summary": True, "freshness": True, "image": False},
                "extra_config": {"variant": "custom", "content_formats": "markdown"},
            },
        )
        SearchGlobalConfig.objects.all().delete()
        SearchGlobalConfig.objects.create(
            default_provider_key="bocha",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )
        MeterPricing.objects.create(
            meter_key=SEARCH_BILLING_METER_KEY,
            scope="global",
            organization_id=None,
            provider_key="bocha",
            model_name="",
            unit="request",
            unit_price=Decimal("0.2500"),
            currency="CREDITS",
            precision=4,
            is_active=True,
            priority=100,
        )
        MeterPricing.objects.create(
            meter_key=SEARCH_BILLING_METER_KEY,
            scope="global",
            organization_id=None,
            provider_key="qianfan",
            model_name="",
            unit="request",
            unit_price=Decimal("0.3000"),
            currency="CREDITS",
            precision=4,
            is_active=True,
            priority=100,
        )
        MeterPricing.objects.create(
            meter_key=SEARCH_BILLING_METER_KEY,
            scope="global",
            organization_id=None,
            provider_key="doubao",
            model_name="",
            unit="request",
            unit_price=Decimal("0.3500"),
            currency="CREDITS",
            precision=4,
            is_active=True,
            priority=100,
        )
        # E1：付费搜索调用前需通过五层预检，故测试 organization 需有可用余额。
        OrganizationBillingPolicy.objects.create(
            organization_id=self.organization_id,
            llm_billing_mode="quota_then_paygo",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=100,
            credits_precise=Decimal("100.0000"),
        )

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_search_records_billing_event(self, mock_post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 200,
            "log_id": "bocha-log-001",
            "data": {
                "queryContext": {"originalQuery": "Django 5.2 release notes"},
                "webPages": {
                    "totalEstimatedMatches": 12,
                    "value": [
                        {
                            "name": "Django 5.2 release notes",
                            "url": "https://docs.djangoproject.com/en/5.2/releases/5.2/",
                            "displayUrl": "https://docs.djangoproject.com/en/5.2/releases/5.2/",
                            "snippet": "Release notes for Django 5.2.",
                            "summary": "Django 5.2 is the latest feature release.",
                            "siteName": "docs.djangoproject.com",
                            "datePublished": "2026-02-01T00:00:00+08:00",
                        }
                    ],
                },
                "images": {"value": []},
                "videos": None,
            },
        }
        mock_post.return_value = response

        result = SearchService.search(
            "Django 5.2 release notes",
            organization_id=self.organization_id,
            user_id="user_search_001",
            thread_id="thread_search_001",
            biz_type="orchestration.web_search",
        )

        self.assertEqual(result.provider_key, "bocha")
        self.assertEqual(len(result.web_pages), 1)
        self.assertIsNotNone(result.billing_result)
        self.assertTrue(result.billing_result["charged"])

        event = BillingUsageEvent.objects.get(biz_id=result.request_id)
        self.assertEqual(str(event.organization_id), self.organization_id)
        self.assertEqual(event.user_id, "user_search_001")
        self.assertEqual(event.meter_key, SEARCH_BILLING_METER_KEY)
        self.assertEqual(event.provider_key, "bocha")
        self.assertEqual(event.amount, Decimal("0.2500"))
        self.assertEqual(event.quantity, Decimal("1"))
        self.assertEqual(event.metadata["thread_id"], "thread_search_001")
        self.assertEqual(event.metadata["provider_log_id"], "bocha-log-001")

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_qianfan_search_records_billing_event(self, mock_post):
        SearchGlobalConfig.objects.update(default_provider_key="qianfan")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "request_id": "qianfan-req-001",
            "references": [
                {
                    "type": "web",
                    "title": "上海天气",
                    "url": "https://weather.example.com/shanghai",
                    "website": "weather.example.com",
                    "snippet": "上海今日高温并有分散雷阵雨。",
                    "date": "2026-07-31 00:00:00",
                }
            ],
        }
        mock_post.return_value = response

        result = SearchService.search(
            "上海今天的天气",
            organization_id=self.organization_id,
            user_id="user_search_001",
            thread_id="thread_search_qianfan",
            biz_type="orchestration.web_search",
        )

        self.assertEqual(result.provider_key, "qianfan")
        self.assertEqual(len(result.web_pages), 1)
        self.assertIsNotNone(result.billing_result)
        self.assertTrue(result.billing_result["charged"])

        event = BillingUsageEvent.objects.get(biz_id="qianfan-req-001")
        self.assertEqual(str(event.organization_id), self.organization_id)
        self.assertEqual(event.user_id, "user_search_001")
        self.assertEqual(event.meter_key, SEARCH_BILLING_METER_KEY)
        self.assertEqual(event.provider_key, "qianfan")
        self.assertEqual(event.amount, Decimal("0.3000"))
        self.assertEqual(event.quantity, Decimal("1"))
        self.assertEqual(event.metadata["thread_id"], "thread_search_qianfan")
        self.assertEqual(event.metadata["provider_log_id"], "qianfan-req-001")

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_doubao_search_records_billing_event(self, mock_post):
        SearchGlobalConfig.objects.update(default_provider_key="doubao")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "ResponseMetadata": {"RequestId": "doubao-req-001"},
            "Result": {
                "ResultCount": 1,
                "LogId": "doubao-log-001",
                "WebResults": [
                    {
                        "Title": "上海天气",
                        "Url": "https://weather.example.com/shanghai",
                        "Summary": "上海今日多云转雷阵雨。",
                        "PublishTime": "2026-08-01",
                        "SiteName": "weather.example.com",
                    }
                ],
            },
        }
        mock_post.return_value = response

        result = SearchService.search(
            "上海今天的天气",
            organization_id=self.organization_id,
            user_id="user_search_001",
            thread_id="thread_search_doubao",
            biz_type="orchestration.web_search",
        )

        self.assertEqual(result.provider_key, "doubao")
        self.assertEqual(len(result.web_pages), 1)
        self.assertIsNotNone(result.billing_result)
        self.assertTrue(result.billing_result["charged"])

        event = BillingUsageEvent.objects.get(biz_id="doubao-req-001")
        self.assertEqual(str(event.organization_id), self.organization_id)
        self.assertEqual(event.user_id, "user_search_001")
        self.assertEqual(event.meter_key, SEARCH_BILLING_METER_KEY)
        self.assertEqual(event.provider_key, "doubao")
        self.assertEqual(event.amount, Decimal("0.3500"))
        self.assertEqual(event.quantity, Decimal("1"))
        self.assertEqual(event.metadata["thread_id"], "thread_search_doubao")
        self.assertEqual(event.metadata["provider_log_id"], "doubao-log-001")

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_doubao_is_not_selected_unless_configured_as_default(self, mock_post):
        SearchProvider.objects.filter(provider_key="doubao").update(is_active=False, priority=1000)
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 200,
            "log_id": "bocha-log-default",
            "data": {
                "webPages": {
                    "totalEstimatedMatches": 1,
                    "value": [
                        {
                            "name": "默认仍走 Bocha",
                            "url": "https://example.com/bocha",
                            "snippet": "默认 provider 未切换。",
                        }
                    ],
                },
                "images": {"value": []},
                "videos": None,
            },
        }
        mock_post.return_value = response

        result = SearchService.search("默认 provider", charge_billing=False)

        self.assertEqual(result.provider_key, "bocha")
        self.assertEqual(len(result.web_pages), 1)

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_format_for_llm_contains_sources(self, mock_post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 200,
            "log_id": "bocha-log-002",
            "data": {
                "webPages": {
                    "totalEstimatedMatches": 3,
                    "value": [
                        {
                            "name": "TabTin Blog",
                            "url": "https://www.example.com/blog",
                            "displayUrl": "https://www.example.com/blog",
                            "snippet": "Latest updates from TabTin.",
                            "siteName": "example.com",
                            "datePublished": "2026-03-01T00:00:00+08:00",
                        }
                    ],
                },
                "images": {"value": []},
                "videos": None,
            },
        }
        mock_post.return_value = response

        result = SearchService.search("TabTin 最新动态", charge_billing=False)
        formatted = SearchService.format_for_llm(result)

        self.assertIn("搜索结果", formatted)
        self.assertIn("TabTin Blog", formatted)
        self.assertIn("example.com", formatted)

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_insufficient_balance_blocks_before_provider_call(self, mock_post):
        """E1反向：余额不足时应在调 provider 前拦截，不产生外部调用。"""
        with self.assertRaises(SearchProviderError) as ctx:
            SearchService.search(
                "Django 5.2 release notes",
                organization_id=self.no_balance_organization_id,
                user_id="user_search_002",
                biz_type="orchestration.web_search",
            )

        self.assertEqual(ctx.exception.code, "search_billing_insufficient_balance")
        mock_post.assert_not_called()
        self.assertFalse(
            BillingUsageEvent.objects.filter(organization_id=self.no_balance_organization_id).exists()
        )

    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_doubao_insufficient_balance_blocks_before_provider_call(self, mock_post):
        SearchGlobalConfig.objects.update(default_provider_key="doubao")

        with self.assertRaises(SearchProviderError) as ctx:
            SearchService.search(
                "上海今天的天气",
                organization_id=self.no_balance_organization_id,
                user_id="user_search_005",
                biz_type="orchestration.web_search",
            )

        self.assertEqual(ctx.exception.code, "search_billing_insufficient_balance")
        mock_post.assert_not_called()
        self.assertFalse(
            BillingUsageEvent.objects.filter(organization_id=self.no_balance_organization_id).exists()
        )

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_qianfan_insufficient_balance_blocks_before_provider_call(self, mock_post):
        SearchGlobalConfig.objects.update(default_provider_key="qianfan")

        with self.assertRaises(SearchProviderError) as ctx:
            SearchService.search(
                "上海今天的天气",
                organization_id=self.no_balance_organization_id,
                user_id="user_search_004",
                biz_type="orchestration.web_search",
            )

        self.assertEqual(ctx.exception.code, "search_billing_insufficient_balance")
        mock_post.assert_not_called()
        self.assertFalse(
            BillingUsageEvent.objects.filter(organization_id=self.no_balance_organization_id).exists()
        )

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_missing_organization_blocks_paid_search(self, mock_post):
        """E1反向：无可计费 organization 时付费搜索 fail-closed，不调 provider。"""
        with self.assertRaises(SearchProviderError) as ctx:
            SearchService.search(
                "Django 5.2 release notes",
                organization_id=None,
                user_id="user_search_003",
                biz_type="orchestration.web_search",
            )

        self.assertEqual(ctx.exception.code, "search_billing_organization_required")
        mock_post.assert_not_called()
