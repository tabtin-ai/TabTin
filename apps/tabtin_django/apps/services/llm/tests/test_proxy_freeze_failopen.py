"""E4：LLM proxy 冻结异常的「有上限 fail-open」回归。

冻结（freeze_credits_for_llm）抛非预期异常时，此前无条件放行（unbounded
fail-open）——计费 DB 持续异常即可被持续刷量。改为复用 L4 余额预检同款阈值：
- 未超阈值：有限放行（记一次 fail-open 累计）。
- 超阈值（连续次数或累计金额）：fail-closed，抛 ProxyError(503)。
"""

from __future__ import annotations

from contextlib import ExitStack
from decimal import Decimal
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.services.proxy_service import (
    ProxyContext,
    ProxyError,
    billing_precheck,
)


def _ctx() -> ProxyContext:
    ctx = ProxyContext()
    ctx.user_id = "user-e4"
    ctx.organization_id = "ws-e4"
    ctx.model_instance = object()
    return ctx


class ProxyFreezeFailOpenTests(SimpleTestCase):
    def _enter_common(self, stack: ExitStack) -> None:
        """预检前置层全部放行，仅留冻结环节做被测对象（冻结固定抛异常）。"""
        for patcher in (
            patch("apps.services.llm.services.billing._is_byok_provider", return_value=False),
            patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None),
            patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None),
            patch("apps.services.llm.services.billed_call._estimate_wallet_freeze_credits", return_value=Decimal("0.5")),
            patch(
                "apps.users.wallet.services.credits_service.CreditsService.freeze_credits_for_llm",
                side_effect=RuntimeError("billing DB down"),
            ),
        ):
            stack.enter_context(patcher)

    def test_freeze_exception_below_threshold_limited_passthrough(self):
        ctx = _ctx()
        with ExitStack() as stack:
            self._enter_common(stack)
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._record_precheck_failure", return_value=False))
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._is_failopen_amount_exceeded", return_value=False))
            mock_record = stack.enter_context(patch(
                "apps.services.llm.services.billed_call._record_failopen_amount"))

            billing_precheck(ctx)

        self.assertIsNone(ctx.freeze_id)
        mock_record.assert_called_once()

    def test_freeze_exception_over_count_threshold_failclosed(self):
        ctx = _ctx()
        with ExitStack() as stack:
            self._enter_common(stack)
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._record_precheck_failure", return_value=True))
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._is_failopen_amount_exceeded", return_value=False))

            with self.assertRaises(ProxyError) as raised:
                billing_precheck(ctx)

        self.assertEqual(raised.exception.status, 503)

    def test_freeze_exception_over_amount_cap_failclosed(self):
        ctx = _ctx()
        with ExitStack() as stack:
            self._enter_common(stack)
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._record_precheck_failure", return_value=False))
            stack.enter_context(patch(
                "apps.services.llm.services.billed_call._is_failopen_amount_exceeded", return_value=True))

            with self.assertRaises(ProxyError) as raised:
                billing_precheck(ctx)

        self.assertEqual(raised.exception.status, 503)


class ProxyFreezeAutoTopupFallbackTests(SimpleTestCase):
    """#4526：冻结返回 False（钱包不足以冻结本次预估）时，quota_only 下先自动
    补充一档再重试一次冻结；补充成功且重试冻结成功则放行，否则抛 freeze_failed。
    覆盖「预检通过后钱包被并发耗尽 / 实际预估高于预检口径」的竞态。
    """

    def _enter_precheck_passthrough(self, stack: ExitStack) -> None:
        for patcher in (
            patch("apps.services.llm.services.billing._is_byok_provider", return_value=False),
            patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None),
            patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None),
            patch(
                "apps.services.llm.services.billed_call._estimate_wallet_freeze_credits",
                return_value=Decimal("1.0"),
            ),
        ):
            stack.enter_context(patcher)

    def test_freeze_false_then_topup_and_retry_success(self):
        ctx = _ctx()
        ctx.request_id = "req-topup-ok"
        with ExitStack() as stack:
            self._enter_precheck_passthrough(stack)
            stack.enter_context(patch(
                "apps.users.wallet.services.credits_service.CreditsService.freeze_credits_for_llm",
                side_effect=[False, True],
            ))
            mock_topup = stack.enter_context(patch(
                "apps.services.billing.services.llm_topup_service.LlmQuotaTopupService.try_auto_topup",
                return_value={"topped_up": True, "reason": "topped_up"},
            ))

            billing_precheck(ctx)

        self.assertEqual(ctx.freeze_id, "freeze:proxy:req-topup-ok")
        _, kwargs = mock_topup.call_args
        self.assertEqual(kwargs.get("required_credits"), Decimal("1.0"))

    def test_freeze_false_and_topup_declined_raises(self):
        ctx = _ctx()
        ctx.request_id = "req-topup-no"
        with ExitStack() as stack:
            self._enter_precheck_passthrough(stack)
            stack.enter_context(patch(
                "apps.users.wallet.services.credits_service.CreditsService.freeze_credits_for_llm",
                return_value=False,
            ))
            stack.enter_context(patch(
                "apps.services.billing.services.llm_topup_service.LlmQuotaTopupService.try_auto_topup",
                return_value={"topped_up": False, "reason": "wallet_insufficient"},
            ))

            with self.assertRaises(ProxyError) as raised:
                billing_precheck(ctx)

        self.assertEqual(raised.exception.error_code, "freeze_failed")
