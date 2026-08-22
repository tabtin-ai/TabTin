"""
测试 billed_llm_call 封装层、check_balance_before_request 和 safe_charge_usage。
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.services.billed_call import (
    InsufficientBalanceError,
    billed_llm_call,
    build_budget_error,
    build_precheck_error,
    check_balance_before_request,
    _estimate_wallet_freeze_credits,
    _maybe_notify_low_balance,
    mark_post_charge_insufficient_balance,
    safe_charge_usage,
    MIN_BALANCE_THRESHOLD,
)


class LowBalanceNotificationTests(SimpleTestCase):
    @patch(
        "apps.services.billing.services.low_balance_alert_service"
        ".LowBalanceAlertService.check_organization_and_notify",
    )
    def test_delegates_with_model_and_agent_conversation_source(self, notify_mock):
        """预检路径不自算可消耗点券，统一走 check_organization_and_notify。

        口径只留一份，才不会出现「预检算了定向点券、扣费后没算」这种分叉。
        """
        model = SimpleNamespace(id="model-1")

        _maybe_notify_low_balance("org-1", model_instance=model)

        notify_mock.assert_called_once_with(
            "org-1",
            model_instance=model,
            source="agent_conversation",
        )


class CheckBalanceBeforeRequestTests(SimpleTestCase):
    """check_balance_before_request 测试"""

    def test_returns_none_when_no_user_id(self):
        result = check_balance_before_request("", "ws_001")
        self.assertIsNone(result)

    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_allows_when_organization_wallet_sufficient(self, mock_ws_objs):
        ws_wallet = MagicMock()
        ws_wallet.get_available_credits_precise.return_value = Decimal("10.0000")
        mock_ws_objs.filter.return_value.first.return_value = ws_wallet

        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="paygo_only")
    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_blocks_low_balance_below_model_freeze_estimate(self, mock_ws_objs, _mock_mode):
        """#1063: 0.79 点不应只因大于 0.01 就放行高成本 Agent 请求。"""
        ws_wallet = MagicMock()
        ws_wallet.get_available_credits_precise.return_value = Decimal("0.7900")
        mock_ws_objs.filter.return_value.first.return_value = ws_wallet
        model = SimpleNamespace(
            input_price_per_1k="0.01",
            output_price_per_1k="0.01",
        )

        result = check_balance_before_request("user_001", "ws_001", model_instance=model)

        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])
        self.assertEqual(result["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS")

    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="paygo_only")
    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_post_charge_insufficient_does_not_block_cheaper_request_that_current_balance_covers(
        self, mock_ws_objs, _mock_mode,
    ):
        """历史高成本请求失败不能把仍有可消耗点券的组织暂停一小时。"""
        from django.core.cache import cache

        cache.clear()
        self.addCleanup(cache.clear)
        expensive_model = SimpleNamespace(
            model_name="expensive",
            input_price_per_1k="0.1",
            output_price_per_1k="0.1",
            provider=SimpleNamespace(provider_key="platform"),
        )
        mark_post_charge_insufficient_balance(
            "ws_001",
            required=Decimal("3.0000"),
            current=Decimal("0.7900"),
            model_instance=expensive_model,
        )

        ws_wallet = MagicMock()
        ws_wallet.get_available_credits_precise.return_value = Decimal("0.7900")
        mock_ws_objs.filter.return_value.first.return_value = ws_wallet

        cheap_model = SimpleNamespace(
            model_name="cheap",
            input_price_per_1k="0.001",
            output_price_per_1k="0.001",
            provider=SimpleNamespace(provider_key="platform"),
        )
        allowed = check_balance_before_request(
            "user_001", "ws_001", model_instance=cheap_model,
        )

        self.assertIsNone(allowed)
        self.assertIsNotNone(
            cache.get("billing:llm:post_charge_insufficient:ws_001"),
        )

    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="paygo_only")
    @patch(
        "apps.services.llm.services.billed_call._estimate_wallet_freeze_credits",
        return_value=Decimal("0.5000"),
    )
    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_post_charge_history_does_not_override_current_request_estimate(
        self, mock_ws_objs, _mock_estimate, _mock_mode,
    ):
        from django.core.cache import cache

        cache.clear()
        self.addCleanup(cache.clear)
        model = SimpleNamespace(
            model_name="expensive",
            input_price_per_1k="0.001",
            output_price_per_1k="0.001",
            provider=SimpleNamespace(provider_key="platform"),
        )
        mark_post_charge_insufficient_balance(
            "ws_001",
            required=Decimal("3.0000"),
            current=Decimal("0.7900"),
            model_instance=model,
        )
        ws_wallet = MagicMock()
        ws_wallet.get_available_credits_precise.return_value = Decimal("0.7900")
        mock_ws_objs.filter.return_value.first.return_value = ws_wallet

        allowed = check_balance_before_request(
            "user_001", "ws_001", model_instance=model,
        )

        self.assertIsNone(allowed)
        self.assertIsNotNone(
            cache.get("billing:llm:post_charge_insufficient:ws_001"),
        )

    @patch(
        "apps.services.llm.services.billed_call._estimate_wallet_freeze_credits",
        return_value=Decimal("1"),
    )
    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_blocks_when_only_user_wallet_sufficient_in_organization(self, *mocks):
        """BIL-16: 团队上下文中，仅个人钱包有余额不应放行"""
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])

    @patch(
        "apps.services.llm.services.billed_call._estimate_wallet_freeze_credits",
        return_value=Decimal("1"),
    )
    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_blocks_when_all_wallets_empty(self, *mocks):
        """BIL-16: 团队上下文中余额不足应返回团队专属错误码"""
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])
        self.assertEqual(result["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS")
        self.assertEqual(result["error_category"], "organization_insufficient_credits")

    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_allows_on_exception(self, mock_ws_objs):
        """异常时放行（不影响用户体验）"""
        mock_ws_objs.filter.side_effect = Exception("DB error")
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)


class CheckBalanceWorkspaceModeTests(SimpleTestCase):
    """测试 organization 模式下按 llm_billing_mode 分模式预检"""

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=True)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_only")
    def test_quota_only_allows_when_budget_remaining(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_only")
    def test_quota_only_blocks_when_no_budget(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=True)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._estimate_wallet_freeze_credits", return_value=Decimal("0.5000"))
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_quota_then_paygo_allows_when_wallet_has_balance(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=True)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_quota_then_paygo_allows_when_budget_remaining(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._estimate_freeze_credits", return_value=Decimal("0.5000"))
    @patch("apps.services.llm.services.billed_call._get_organization_quota_remaining_credits", return_value=Decimal("3.0000"))
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_quota_then_paygo_does_not_require_wallet_when_shared_quota_covers_estimate(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._estimate_freeze_credits", return_value=Decimal("2.0000"))
    @patch("apps.services.llm.services.billed_call._get_organization_quota_remaining_credits", return_value=Decimal("0.7500"))
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_estimates_only_wallet_shortfall_after_shared_quota(self, *mocks):
        required = _estimate_wallet_freeze_credits("ws_001")
        self.assertEqual(required, Decimal("1.2500"))

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._estimate_wallet_freeze_credits", return_value=Decimal("0.5000"))
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_quota_then_paygo_blocks_when_both_empty(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=True)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="paygo_only")
    def test_paygo_only_allows_when_wallet_has_balance(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNone(result)

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=False)
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="paygo_only")
    def test_paygo_only_blocks_when_wallet_empty(self, *mocks):
        result = check_balance_before_request("user_001", "ws_001")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])

    @patch("apps.services.llm.services.billed_call._has_wallet_balance", return_value=True)
    @patch("apps.services.llm.services.billed_call._has_organization_quota_remaining", return_value=False)
    @patch("apps.services.llm.services.billed_call._estimate_wallet_freeze_credits", return_value=Decimal("0.5000"))
    @patch("apps.services.llm.services.billed_call._get_llm_billing_mode", return_value="quota_then_paygo")
    def test_quota_then_paygo_no_user_wallet_fallback(self, mock_mode, mock_estimate, mock_quota, mock_wallet):
        """BIL-16: quota_then_paygo 预检仅查团队钱包，不读旧个人钱包"""
        check_balance_before_request("user_001", "ws_001")
        mock_wallet.assert_called_once_with(
            "user_001",
            "ws_001",
            model_instance=None,
            required_credits=Decimal("0.5000"),
        )

    def test_no_organization_blocks_with_missing_organization_id(self):
        """W0-fix:无 organization_id 时直接返回 blocked dict(error_category=missing_organization_id),
        让上游能在 view 层渲染中文气泡(原行为是返回 None 让扣费环节再拦,会导致用户体验滞后)。"""
        result = check_balance_before_request("user_001", "")
        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])
        self.assertEqual(result["error_category"], "missing_organization_id")
        self.assertEqual(result["error_code"], "MISSING_ORGANIZATION_ID")
        self.assertIn("组织", result["error"])


class BilledLlmCallTests(SimpleTestCase):
    """billed_llm_call 测试"""

    def _make_llm_service(self, chat_return=None):
        service = MagicMock()
        service.model = SimpleNamespace(
            provider=SimpleNamespace(provider_key="openai", name="OpenAI", organization_id="ws_001"),
            model_name="gpt-4o-mini",
            input_price_per_1k="0.0015",
            output_price_per_1k="0.0060",
        )
        service.chat.return_value = chat_return or {
            "success": True,
            "content": "Hello!",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
        return service

    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage", return_value=True)
    def test_successful_call_with_billing(self, mock_charge, mock_budget, mock_balance):
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
            source="test",
        )
        self.assertTrue(result["success"])
        self.assertIsNotNone(result["billing_result"])
        self.assertTrue(result["billing_result"]["charged"])
        mock_charge.assert_called_once()

    @patch("apps.services.llm.services.billed_call._settle_freeze_safely")
    @patch(
        "apps.users.wallet.services.credits_service.CreditsService.freeze_credits_for_llm",
        return_value=True,
    )
    @patch(
        "apps.services.llm.services.billed_call._estimate_wallet_freeze_credits",
        return_value=Decimal("0.9000"),
    )
    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage", return_value=True)
    def test_successful_call_passes_freeze_id_to_charge(
        self,
        mock_charge,
        _mock_budget,
        _mock_balance,
        _mock_estimate,
        mock_freeze,
        _mock_settle,
    ):
        service = self._make_llm_service()

        billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
            source="test",
            request_id="req-reserved",
        )

        freeze_id = mock_freeze.call_args.args[2]
        self.assertEqual(
            mock_charge.call_args.kwargs["billing_metadata"],
            {"freeze_id": freeze_id},
        )

    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage")
    def test_skip_billing(self, mock_charge, mock_budget, mock_balance):
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
            skip_billing=True,
        )
        self.assertTrue(result["success"])
        self.assertIsInstance(result["billing_result"], dict)
        self.assertFalse(result["billing_result"]["charged"])
        self.assertEqual(result["billing_result"]["reason"], "skip_billing")
        mock_charge.assert_not_called()

    @patch("apps.services.llm.services.billed_call.check_balance_before_request")
    @patch("apps.services.llm.services.billing.check_budget_before_request")
    def test_budget_exceeded_blocks(self, mock_budget, mock_balance):
        mock_budget.return_value = {"blocked": True, "reason": "budget_critical"}
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "BUDGET_EXCEEDED")
        service.chat.assert_not_called()

    @patch("apps.services.llm.services.billed_call.check_balance_before_request")
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    def test_insufficient_credits_blocks(self, mock_budget, mock_balance):
        mock_balance.return_value = {
            "blocked": True,
            "reason": "insufficient_credits",
            "error_code": "INSUFFICIENT_CREDITS",
        }
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "INSUFFICIENT_CREDITS")
        service.chat.assert_not_called()

    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage", side_effect=Exception("charge failed"))
    def test_charge_failure_blocks_result_delivery(self, mock_charge, mock_budget, mock_balance):
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "BILLING_CHARGE_FAILED")
        self.assertNotIn("content", result)
        self.assertFalse(result["billing_result"]["charged"])

    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage", return_value=None)
    def test_empty_charge_result_blocks_result_delivery(self, mock_charge, mock_budget, mock_balance):
        service = self._make_llm_service()
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "BILLING_CHARGE_FAILED")
        self.assertNotIn("content", result)

    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.check_budget_before_request", return_value=None)
    @patch("apps.services.llm.services.billing.charge_llm_usage")
    def test_failed_llm_call_no_billing(self, mock_charge, mock_budget, mock_balance):
        service = self._make_llm_service(chat_return={
            "success": False,
            "error": "model overloaded",
            "error_code": "PROVIDER_DOWN",
        })
        result = billed_llm_call(
            llm_service=service,
            messages=[{"role": "user", "content": "hi"}],
            user_id="user_001",
            organization_id="ws_001",
        )
        self.assertFalse(result["success"])
        self.assertIsInstance(result["billing_result"], dict)
        self.assertFalse(result["billing_result"]["charged"])
        self.assertEqual(result["billing_result"]["reason"], "llm_call_failed")
        mock_charge.assert_not_called()


class SafeChargeUsageTests(SimpleTestCase):
    """safe_charge_usage 测试"""

    def _make_llm_service(self):
        service = MagicMock()
        service.model = SimpleNamespace(
            provider=SimpleNamespace(provider_key="openai", name="OpenAI", organization_id="ws_001"),
            model_name="gpt-4o-mini",
            input_price_per_1k="0.0015",
            output_price_per_1k="0.0060",
        )
        return service

    def test_skips_when_user_id_empty(self):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result={"success": True, "usage": {"input_tokens": 10}},
            user_id="",
            source="test",
        )
        self.assertFalse(result)

    def test_skips_when_result_not_dict(self):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result="not a dict",
            user_id="user_001",
            source="test",
        )
        self.assertFalse(result)

    def test_skips_when_success_false(self):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result={"success": False, "error": "model overloaded"},
            user_id="user_001",
            source="test",
        )
        self.assertFalse(result)

    def test_skips_when_success_missing(self):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result={"content": "hello"},
            user_id="user_001",
            source="test",
        )
        self.assertFalse(result)

    @patch("apps.services.llm.services.billing.charge_llm_usage", return_value=True)
    def test_charges_on_success(self, mock_charge):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result={"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}},
            user_id="user_001",
            organization_id="ws_001",
            source="test_source",
            biz_id="biz_123",
        )
        self.assertTrue(result)
        mock_charge.assert_called_once()
        call_kwargs = mock_charge.call_args
        self.assertEqual(call_kwargs.kwargs["user_id"], "user_001")
        self.assertEqual(call_kwargs.kwargs["organization_id"], "ws_001")
        self.assertEqual(call_kwargs.kwargs["source"], "test_source")
        self.assertEqual(call_kwargs.kwargs["biz_id"], "biz_123")

    @patch("apps.services.llm.services.billing.charge_llm_usage", side_effect=Exception("DB error"))
    def test_charge_exception_returns_false(self, mock_charge):
        svc = self._make_llm_service()
        result = safe_charge_usage(
            llm_service=svc,
            result={"success": True, "usage": {"input_tokens": 10}},
            user_id="user_001",
            source="test",
        )
        self.assertFalse(result)


class InsufficientBalanceErrorTests(SimpleTestCase):
    def test_exception_properties(self):
        exc = InsufficientBalanceError("u1", "ws1", "余额不足")
        self.assertEqual(exc.user_id, "u1")
        self.assertEqual(exc.organization_id, "ws1")
        self.assertEqual(str(exc), "余额不足")


class BuildPrecheckErrorTests(SimpleTestCase):
    """build_precheck_error / build_budget_error 工厂函数测试"""

    def test_precheck_error_has_required_fields(self):
        err = build_precheck_error()
        self.assertFalse(err["success"])
        self.assertEqual(err["error_code"], "INSUFFICIENT_CREDITS")
        self.assertEqual(err["error_category"], "insufficient_credits")
        self.assertIn("余额不足", err["error"])

    def test_budget_error_has_required_fields(self):
        err = build_budget_error()
        self.assertFalse(err["success"])
        self.assertEqual(err["error_code"], "BUDGET_EXCEEDED")
        self.assertEqual(err["error_category"], "budget_exceeded")
        self.assertIn("budget_exceeded", err["error"])

    def test_budget_error_preserves_guard_membership_error(self):
        err = build_budget_error(billing_result={
            "blocked": True,
            "reason": "membership_expired",
            "detail": "组织会员已过期",
            "error_code": "MEMBERSHIP_EXPIRED",
            "error_category": "membership_expired",
        })
        self.assertFalse(err["success"])
        self.assertEqual(err["error_code"], "MEMBERSHIP_EXPIRED")
        self.assertEqual(err["error_category"], "membership_expired")
        self.assertIn("会员已过期", err["error"])

    def test_precheck_error_accepts_extra_fields(self):
        err = build_precheck_error(thread_id="t-123", request_id="r-456")
        self.assertEqual(err["thread_id"], "t-123")
        self.assertEqual(err["request_id"], "r-456")
        self.assertEqual(err["error_code"], "INSUFFICIENT_CREDITS")

    def test_budget_error_accepts_extra_fields(self):
        err = build_budget_error(final_answer="预算不足提示")
        self.assertEqual(err["final_answer"], "预算不足提示")
        self.assertEqual(err["error_code"], "BUDGET_EXCEEDED")

    def test_precheck_error_allows_custom_error_message(self):
        err = build_precheck_error(error="自定义错误")
        self.assertEqual(err["error"], "自定义错误")
        self.assertEqual(err["error_code"], "INSUFFICIENT_CREDITS")

    def test_precheck_error_protects_critical_fields(self):
        err = build_precheck_error(error_code="FAKE", error_category="fake", success=True)
        self.assertFalse(err["success"])
        self.assertEqual(err["error_code"], "INSUFFICIENT_CREDITS")
        self.assertEqual(err["error_category"], "insufficient_credits")

    def test_precheck_error_inherits_organization_error_code(self):
        """BIL-16: billing_result 携带团队错误码时应继承"""
        billing_result = {
            "blocked": True,
            "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
            "error_category": "organization_insufficient_credits",
            "error": "[organization_insufficient_credits] 团队钱包余额不足",
        }
        err = build_precheck_error(billing_result=billing_result)
        self.assertFalse(err["success"])
        self.assertEqual(err["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS")
        self.assertEqual(err["error_category"], "organization_insufficient_credits")
        self.assertIn("organization", err["error"])

    def test_precheck_error_lifts_topup_reason_from_billing_result(self):
        """quota_only：billing_result.topup_reason 提升到返回体顶层"""
        billing_result = {
            "blocked": True,
            "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
            "error_category": "organization_insufficient_credits",
            "error": "[organization_insufficient_credits] LLM 点券已用完",
            "topup_reason": "auto_topup_disabled",
        }
        err = build_precheck_error(billing_result=billing_result)
        self.assertEqual(err["topup_reason"], "auto_topup_disabled")
        self.assertEqual(err["error_category"], "organization_insufficient_credits")

    def test_precheck_error_explicit_topup_reason_wins_over_billing_result(self):
        billing_result = {
            "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
            "error_category": "organization_insufficient_credits",
            "topup_reason": "wallet_insufficient",
        }
        err = build_precheck_error(
            billing_result=billing_result,
            topup_reason="monthly_cap_reached",
        )
        self.assertEqual(err["topup_reason"], "monthly_cap_reached")

    def test_precheck_error_keeps_default_for_non_organization(self):
        """非团队错误码不受影响"""
        billing_result = {"blocked": True, "error_code": "INSUFFICIENT_CREDITS"}
        err = build_precheck_error(billing_result=billing_result)
        self.assertEqual(err["error_code"], "INSUFFICIENT_CREDITS")
        self.assertEqual(err["error_category"], "insufficient_credits")
        self.assertNotIn("topup_reason", err)
