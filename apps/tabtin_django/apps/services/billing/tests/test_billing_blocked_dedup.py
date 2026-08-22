"""#4526 优化：billing_blocked WS 去重 + 入口预检透传 model_instance。

覆盖：
- publish_billing_blocked_deduped 两道闸：按 (org, request_id) 去重（同一次 LLM
  请求内外层重复触发只广播一条）+ 按 org 节流（窗口内同一组织跨请求只广播一条，
  合并回合多次调用 / 连续多条消息的 toast 风暴），不同 org 互不影响。
- billing_precheck 的 L4 余额检查把 model_instance 透传到
  check_balance_before_request，使入口预检也用「本次预估」口径。
"""

from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase

from apps.services.billing.services.billing_precheck import _check_balance
from apps.services.billing.ws_events import publish_billing_blocked_deduped


class BillingBlockedDedupTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_same_request_id_published_once(self, mock_pub):
        # 结算失败在内层(gateway)/外层(charge catch)可能各触发一次，reason 不同，
        # 但同一 request_id 只应广播一条。
        ok1 = publish_billing_blocked_deduped(
            "org_1", "BILLING_WALLET_INSUFFICIENT", request_id="req_1",
        )
        ok2 = publish_billing_blocked_deduped(
            "org_1", "organization_insufficient_credits", request_id="req_1",
        )
        self.assertTrue(ok1)
        self.assertFalse(ok2)
        self.assertEqual(mock_pub.call_count, 1)
        payload = mock_pub.call_args.args[2]
        self.assertEqual(
            payload["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS",
        )
        self.assertEqual(
            payload["block_type"], "request_insufficient_credits",
        )

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_guard_block_has_distinct_structured_reason(self, mock_pub):
        publish_billing_blocked_deduped(
            "org_guard", "billing_guard_anomaly", request_id="req_guard",
        )

        payload = mock_pub.call_args.args[2]
        self.assertEqual(payload["error_code"], "BILLING_BLOCKED")
        self.assertEqual(payload["block_type"], "organization_billing_guard")

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_extra_cannot_override_structured_block_identity(self, mock_pub):
        publish_billing_blocked_deduped(
            "org_safe",
            "organization_insufficient_credits",
            request_id="req_safe",
            extra={
                "error_code": "BILLING_BLOCKED",
                "block_type": "organization_billing_guard",
                "required_credits": "3.0",
            },
        )
        payload = mock_pub.call_args.args[2]
        self.assertEqual(payload["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS")
        self.assertEqual(payload["block_type"], "request_insufficient_credits")
        self.assertEqual(payload["required_credits"], "3.0")

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_different_request_ids_same_org_throttled(self, mock_pub):
        # 一个回合的多次 LLM 调用 / 用户连续多条消息 → request_id 各不相同，
        # 但同一 org 在节流窗口内只广播一条，避免 billing_blocked toast 刷屏。
        publish_billing_blocked_deduped("org_1", "x", request_id="req_1")
        publish_billing_blocked_deduped("org_1", "x", request_id="req_2")
        publish_billing_blocked_deduped("org_1", "x", request_id="req_3")
        self.assertEqual(mock_pub.call_count, 1)

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_different_orgs_each_published(self, mock_pub):
        # 节流是按 org 的：不同组织互不影响，各自广播一条。
        publish_billing_blocked_deduped("org_1", "x", request_id="req_1")
        publish_billing_blocked_deduped("org_2", "x", request_id="req_1")
        self.assertEqual(mock_pub.call_count, 2)

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_missing_request_id_org_throttled(self, mock_pub):
        # request_id 为空时跳过同请求去重，但仍受 org 级节流约束 → 同 org 只一条。
        publish_billing_blocked_deduped("org_1", "x")
        publish_billing_blocked_deduped("org_1", "x")
        self.assertEqual(mock_pub.call_count, 1)

    @patch("apps.services.billing.ws_events.publish_billing_event", return_value=True)
    def test_publishes_again_after_org_window_reset(self, mock_pub):
        # 节流窗口过期后（此处以清 org key 模拟）应重新广播，保证用户长时间后
        # 再次触发阻断仍能收到提醒。
        publish_billing_blocked_deduped("org_1", "x", request_id="req_1")
        cache.delete("billing:blocked:org:org_1")
        publish_billing_blocked_deduped("org_1", "x", request_id="req_2")
        self.assertEqual(mock_pub.call_count, 2)


class CheckBalanceForwardsModelInstanceTests(SimpleTestCase):
    def test_check_balance_forwards_model_instance(self):
        sentinel = object()
        with patch(
            "apps.services.llm.services.billed_call.check_balance_before_request",
            return_value=None,
        ) as mock_check:
            _check_balance("org_1", "user_1", "chat_send", model_instance=sentinel)
        mock_check.assert_called_once_with(
            "user_1", "org_1", model_instance=sentinel,
        )

    def test_check_balance_default_model_instance_is_none(self):
        with patch(
            "apps.services.llm.services.billed_call.check_balance_before_request",
            return_value=None,
        ) as mock_check:
            _check_balance("org_1", "user_1", "chat_send")
        mock_check.assert_called_once_with(
            "user_1", "org_1", model_instance=None,
        )
