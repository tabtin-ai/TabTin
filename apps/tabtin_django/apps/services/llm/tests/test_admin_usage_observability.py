"""LLM Admin 用量统计回归测试。"""

from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.services.llm.api_admin_observability import admin_usage_breakdown
from apps.services.llm.models import LLMUsageFact


class AdminUsageBreakdownTests(TestCase):
    def _usage_fact(
        self,
        *,
        request_id: str,
        scene_key: str,
        cost_status: str,
        total_cost: str,
        status: str = "completed",
        input_tokens: int = 100,
        output_tokens: int = 50,
    ) -> LLMUsageFact:
        return LLMUsageFact.objects.create(
            request_id=request_id,
            scene_key=scene_key,
            capability_domain="chat",
            effective_provider_scope="global",
            cost_status=cost_status,
            status=status,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            total_cost=Decimal(total_cost),
            latency_ms=120,
            occurred_at=timezone.now(),
        )

    def test_breakdown_cost_status_subtotals_do_not_shadow_total_cost_field(self):
        """同一 annotate 内主合计与条件合计不能因 total_cost 别名冲突而 500。"""
        self._usage_fact(
            request_id="usage-breakdown-platform",
            scene_key="_main_chat",
            cost_status="platform_paid",
            total_cost="1.250000",
        )
        self._usage_fact(
            request_id="usage-breakdown-byok",
            scene_key="_main_chat",
            cost_status="byok_self_paid",
            total_cost="2.000000",
        )
        self._usage_fact(
            request_id="usage-breakdown-na",
            scene_key="_main_chat",
            cost_status="n_a",
            total_cost="0.000000",
            status="failed",
            input_tokens=0,
            output_tokens=0,
        )
        self._usage_fact(
            request_id="usage-breakdown-lower-cost",
            scene_key="_summary_judge",
            cost_status="platform_paid",
            total_cost="0.500000",
        )

        response = admin_usage_breakdown(None, dimension="scene_key", scope="all", limit=30)

        self.assertIsInstance(response, dict)
        self.assertTrue(response["success"])
        items = response["data"]["items"]
        self.assertEqual(len(items), 2)
        item = items[0]
        self.assertEqual(item["dimension_key"], "_main_chat")
        self.assertEqual(item["total_requests"], 3)
        self.assertEqual(item["completed_requests"], 2)
        self.assertEqual(item["failed_requests"], 1)
        self.assertEqual(item["total_cost"], 3.25)
        self.assertEqual(item["cost_status_breakdown"]["platform_paid"], {
            "count": 1,
            "total_cost": 1.25,
        })
        self.assertEqual(item["cost_status_breakdown"]["byok_self_paid"], {
            "count": 1,
            "total_cost": 2.0,
        })
        self.assertEqual(item["cost_status_breakdown"]["n_a"], {
            "count": 1,
            "total_cost": 0.0,
        })
        self.assertEqual(items[1]["dimension_key"], "_summary_judge")
        self.assertEqual(items[1]["total_cost"], 0.5)
