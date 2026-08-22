"""低余额预警：日扫含余额=0、发信失败不假成功、Owner 收件信息。"""

from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase, override_settings


class LowBalanceAlertServiceSendMailTests(SimpleTestCase):
    @patch("django.core.mail.send_mail", return_value=1)
    @patch("apps.tabtinspace.models.Organization.objects")
    @patch("apps.users.auth.models.User.objects")
    @patch("apps.tabtinspace.models.OrganizationMember.objects")
    def test_send_mail_success_returns_true(
        self, member_qs, user_qs, org_qs, send_mail_mock,
    ):
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
            LowBalanceThresholds,
        )

        member = MagicMock(user_id="u1")
        member_qs.filter.return_value.order_by.return_value.first.return_value = member
        user = MagicMock(email="owner@example.com", display_name="Owner")
        user_qs.filter.return_value.first.return_value = user
        org_qs.filter.return_value.first.return_value = MagicMock(name="Acme")

        thresholds = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        ok = LowBalanceAlertService.send_low_balance_email(
            "org-1", Decimal("0"), "critical", thresholds,
        )
        self.assertTrue(ok)
        send_mail_mock.assert_called_once()
        self.assertFalse(send_mail_mock.call_args.kwargs.get("fail_silently", True))

    @patch("django.core.mail.send_mail", side_effect=Exception("smtp down"))
    @patch("apps.tabtinspace.models.Organization.objects")
    @patch("apps.users.auth.models.User.objects")
    @patch("apps.tabtinspace.models.OrganizationMember.objects")
    def test_send_mail_failure_returns_false(
        self, member_qs, user_qs, org_qs, _send_mail_mock,
    ):
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
            LowBalanceThresholds,
        )

        member = MagicMock(user_id="u1")
        member_qs.filter.return_value.order_by.return_value.first.return_value = member
        user = MagicMock(email="owner@example.com", display_name="Owner")
        user_qs.filter.return_value.first.return_value = user
        org_qs.filter.return_value.first.return_value = MagicMock(name="Acme")

        thresholds = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        ok = LowBalanceAlertService.send_low_balance_email(
            "org-1", Decimal("0"), "critical", thresholds,
        )
        self.assertFalse(ok)

    @patch("django.core.mail.send_mail", return_value=0)
    @patch("apps.tabtinspace.models.Organization.objects")
    @patch("apps.users.auth.models.User.objects")
    @patch("apps.tabtinspace.models.OrganizationMember.objects")
    def test_send_mail_zero_sent_returns_false(
        self, member_qs, user_qs, org_qs, _send_mail_mock,
    ):
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
            LowBalanceThresholds,
        )

        member = MagicMock(user_id="u1")
        member_qs.filter.return_value.order_by.return_value.first.return_value = member
        user = MagicMock(email="owner@example.com", display_name="Owner")
        user_qs.filter.return_value.first.return_value = user
        org_qs.filter.return_value.first.return_value = MagicMock(name="Acme")

        thresholds = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        ok = LowBalanceAlertService.send_low_balance_email(
            "org-1", Decimal("0"), "warning", thresholds,
        )
        self.assertFalse(ok)


class CheckAndNotifyDualOutputTests(SimpleTestCase):
    """check_and_notify：读配置分级 + 分级去重 + 双出口（移动端 WS + Owner 铃铛）。"""

    def _run(
        self,
        balance,
        *,
        warning="50",
        critical="10",
        dedup_hit=False,
        owner="owner-1",
        source=None,
    ):
        from apps.services.billing.services import low_balance_alert_service as mod

        thresholds = mod.LowBalanceThresholds(
            warning_credits=Decimal(warning),
            critical_credits=Decimal(critical),
            email_enabled=True,
        )
        ws_mock = MagicMock()
        notify_mock = MagicMock()
        with patch.object(mod, "cache") as cache_mock, \
             patch.object(mod.LowBalanceAlertService, "get_thresholds", return_value=thresholds), \
             patch.object(
                 mod.LowBalanceAlertService, "resolve_owner_contact",
                 return_value={"owner_user_id": owner},
             ), \
             patch(
                 "apps.services.billing.ws_events.publish_billing_event", ws_mock,
             ), \
             patch(
                 "apps.services.notification.services.notification_service.NotificationService.notify",
                 notify_mock,
             ):
            cache_mock.get.return_value = True if dedup_hit else None
            level = mod.LowBalanceAlertService.check_and_notify(
                "org-1",
                Decimal(str(balance)),
                source=source,
            )
        return level, ws_mock, notify_mock

    def test_above_warning_no_output(self):
        level, ws_mock, notify_mock = self._run("80")
        self.assertIsNone(level)
        ws_mock.assert_not_called()
        notify_mock.assert_not_called()

    def test_warning_level_delegates_persistence_to_billing_event_adapter(self):
        level, ws_mock, notify_mock = self._run("30")
        self.assertEqual(level, "warning")
        # 移动端 WS 出口
        ws_mock.assert_called_once()
        ws_args = ws_mock.call_args
        self.assertEqual(ws_args.args[1], "balance_low")
        self.assertEqual(ws_args.args[2]["level"], "warning")
        # 铃铛由 publish_billing_event 内的账户适配器统一投影，不在检测服务双写。
        notify_mock.assert_not_called()

    def test_agent_conversation_source_is_published_in_event_payload(self):
        level, ws_mock, _notify_mock = self._run(
            "30",
            source="agent_conversation",
        )

        self.assertEqual(level, "warning")
        self.assertEqual(
            ws_mock.call_args.args[2]["source"],
            "agent_conversation",
        )

    def test_critical_level_fires_critical_business_fact(self):
        level, ws_mock, notify_mock = self._run("5")
        self.assertEqual(level, "critical")
        ws_mock.assert_called_once()
        self.assertEqual(ws_mock.call_args.args[2]["level"], "critical")
        notify_mock.assert_not_called()

    def test_dedup_hit_suppresses_both_outputs(self):
        level, ws_mock, notify_mock = self._run("5", dedup_hit=True)
        self.assertEqual(level, "critical")
        ws_mock.assert_not_called()
        notify_mock.assert_not_called()

    def test_missing_owner_still_sends_ws(self):
        level, ws_mock, notify_mock = self._run("30", owner=None)
        self.assertEqual(level, "warning")
        ws_mock.assert_called_once()
        notify_mock.assert_not_called()


class ResolveIfHealthyTests(SimpleTestCase):
    """充值后余额健康则消警。"""

    def test_resolves_when_balance_above_warning(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        thresholds = mod.LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        with patch.object(mod, "cache") as cache_mock, \
             patch.object(
                 mod.LowBalanceAlertService,
                 "resolve_alertable_credits",
                 return_value=Decimal("120"),
             ), \
             patch.object(
                 mod.LowBalanceAlertService,
                 "get_thresholds",
                 return_value=thresholds,
             ), \
             patch(
                 "apps.services.notification.services.notification_service"
                 ".NotificationService.mark_balance_low_read_for_organization",
                 return_value=2,
             ) as mark_mock:
            marked = mod.LowBalanceAlertService.resolve_if_healthy("org-1")

        self.assertEqual(marked, 2)
        cache_mock.delete.assert_any_call("billing:low_bal:warning:org-1")
        cache_mock.delete.assert_any_call("billing:low_bal:critical:org-1")
        mark_mock.assert_called_once_with("org-1")

    def test_keeps_alert_when_still_below_warning(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        thresholds = mod.LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        with patch.object(mod, "cache") as cache_mock, \
             patch.object(
                 mod.LowBalanceAlertService,
                 "resolve_alertable_credits",
                 return_value=Decimal("30"),
             ), \
             patch.object(
                 mod.LowBalanceAlertService,
                 "get_thresholds",
                 return_value=thresholds,
             ), \
             patch(
                 "apps.services.notification.services.notification_service"
                 ".NotificationService.mark_balance_low_read_for_organization",
             ) as mark_mock:
            marked = mod.LowBalanceAlertService.resolve_if_healthy("org-1")

        self.assertEqual(marked, 0)
        cache_mock.delete.assert_not_called()
        mark_mock.assert_not_called()


class RecheckAfterThresholdChangeTests(SimpleTestCase):
    """阈值变更后清去重并按可消耗点券补检（写铃铛）。"""

    def test_clears_dedup_and_notifies_when_below_warning(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        with patch.object(mod, "cache") as cache_mock, \
             patch.object(
                 mod.LowBalanceAlertService,
                 "resolve_alertable_credits",
                 return_value=Decimal("681.4"),
             ), \
             patch.object(
                 mod.LowBalanceAlertService,
                 "check_and_notify",
                 return_value="warning",
             ) as check_mock:
            level = mod.LowBalanceAlertService.recheck_after_threshold_change("org-1")

        self.assertEqual(level, "warning")
        cache_mock.delete.assert_any_call("billing:low_bal:warning:org-1")
        cache_mock.delete.assert_any_call("billing:low_bal:critical:org-1")
        # 阈值补检不是 Agent 对话，不带 source：Electron 只写铃铛不弹 toast
        check_mock.assert_called_once_with("org-1", Decimal("681.4"), source=None)

    def test_no_wallet_skips_check(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        with patch.object(mod, "cache"), \
             patch.object(
                 mod.LowBalanceAlertService,
                 "resolve_alertable_credits",
                 return_value=None,
             ), \
             patch.object(mod.LowBalanceAlertService, "check_and_notify") as check_mock:
            level = mod.LowBalanceAlertService.recheck_after_threshold_change("org-1")

        self.assertIsNone(level)
        check_mock.assert_not_called()

    def test_resolve_alertable_credits_sums_wallet_and_monthly(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        wallet = MagicMock()
        wallet.get_available_credits_precise.return_value = Decimal("0")
        with patch("apps.users.wallet.models.OrganizationWallet.objects") as wallet_qs, \
             patch(
                 "apps.services.billing.services.llm_budget_service"
                 ".OrganizationLlmBudgetService.get_remaining_quota_credits",
                 return_value=Decimal("100"),
             ):
            wallet_qs.filter.return_value.first.return_value = wallet
            total = mod.LowBalanceAlertService.resolve_alertable_credits("org-1")

        self.assertEqual(total, Decimal("100"))

    def test_did_credit_thresholds_change_ignores_email_and_same_values(self):
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
            LowBalanceThresholds,
        )

        base = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=False,
        )
        same_credits_email_on = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
            email_enabled=True,
        )
        warning_changed = LowBalanceThresholds(
            warning_credits=Decimal("80"),
            critical_credits=Decimal("10"),
            email_enabled=False,
        )
        critical_changed = LowBalanceThresholds(
            warning_credits=Decimal("50"),
            critical_credits=Decimal("5"),
            email_enabled=False,
        )

        self.assertFalse(
            LowBalanceAlertService.did_credit_thresholds_change(base, base),
        )
        self.assertFalse(
            LowBalanceAlertService.did_credit_thresholds_change(
                base,
                same_credits_email_on,
            ),
        )
        self.assertTrue(
            LowBalanceAlertService.did_credit_thresholds_change(base, warning_changed),
        )
        self.assertTrue(
            LowBalanceAlertService.did_credit_thresholds_change(base, critical_changed),
        )

    def test_same_value_save_skips_recheck_path(self):
        """模拟 API：同值 PUT 不调用 recheck（避免绕过 12/24h 去重）。"""
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
            LowBalanceThresholds,
        )

        before = LowBalanceThresholds(
            warning_credits=Decimal("500"),
            critical_credits=Decimal("100"),
            email_enabled=False,
        )
        after = LowBalanceThresholds(
            warning_credits=Decimal("500"),
            critical_credits=Decimal("100"),
            email_enabled=True,
        )
        with patch.object(
            LowBalanceAlertService,
            "recheck_after_threshold_change",
        ) as recheck_mock:
            if LowBalanceAlertService.did_credit_thresholds_change(before, after):
                LowBalanceAlertService.recheck_after_threshold_change("org-1")
        recheck_mock.assert_not_called()

        after_warning = LowBalanceThresholds(
            warning_credits=Decimal("600"),
            critical_credits=Decimal("100"),
            email_enabled=True,
        )
        with patch.object(
            LowBalanceAlertService,
            "recheck_after_threshold_change",
            return_value="warning",
        ) as recheck_mock:
            if LowBalanceAlertService.did_credit_thresholds_change(before, after_warning):
                LowBalanceAlertService.recheck_after_threshold_change("org-1")
        recheck_mock.assert_called_once_with("org-1")


class AgentConversationAlertPathTests(SimpleTestCase):
    """Agent 对话扣费后这条真实链路：算上定向点券，并标记 source。

    回归 ：修之前 charge_llm_usage 走 check_organization_and_notify 时
    既不传 source（Electron 过滤后永不弹 toast），也不算定向点券
    （组织有定向额度仍被判低余额）。
    """

    def _resolve(self, *, model_instance, provider_credits=Decimal("0")):
        from apps.services.billing.services import low_balance_alert_service as mod

        wallet = MagicMock()
        wallet.get_available_credits_precise.return_value = Decimal("0")
        resolve_mock = MagicMock(return_value=provider_credits)
        with patch("apps.users.wallet.models.OrganizationWallet.objects") as wallet_qs, \
             patch(
                 "apps.services.billing.services.llm_budget_service"
                 ".OrganizationLlmBudgetService.get_remaining_quota_credits",
                 return_value=Decimal("30"),
             ), \
             patch(
                 "apps.services.billing.services.provider_credit_service"
                 ".resolve_model_provider_credits",
                 resolve_mock,
             ):
            wallet_qs.filter.return_value.first.return_value = wallet
            total = mod.LowBalanceAlertService.resolve_alertable_credits(
                "org-1",
                model_instance=model_instance,
            )
        return total, resolve_mock

    def test_model_provider_credits_counted_when_model_known(self):
        model = object()
        total, resolve_mock = self._resolve(
            model_instance=model,
            provider_credits=Decimal("500"),
        )

        self.assertEqual(total, Decimal("530"))
        resolve_mock.assert_called_once_with("org-1", model)

    def test_org_level_scan_without_model_skips_provider_credits(self):
        """定向点券按模型隔离，组织级巡检不知道用哪个模型就不能计入。"""
        total, resolve_mock = self._resolve(
            model_instance=None,
            provider_credits=Decimal("500"),
        )

        self.assertEqual(total, Decimal("30"))
        resolve_mock.assert_not_called()

    def test_provider_credit_lookup_failure_degrades_to_zero(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        wallet = MagicMock()
        wallet.get_available_credits_precise.return_value = Decimal("0")
        with patch("apps.users.wallet.models.OrganizationWallet.objects") as wallet_qs, \
             patch(
                 "apps.services.billing.services.llm_budget_service"
                 ".OrganizationLlmBudgetService.get_remaining_quota_credits",
                 return_value=Decimal("30"),
             ), \
             patch(
                 "apps.services.billing.services.provider_credit_service"
                 ".resolve_model_provider_credits",
                 side_effect=Exception("provider credit down"),
             ):
            wallet_qs.filter.return_value.first.return_value = wallet
            total = mod.LowBalanceAlertService.resolve_alertable_credits(
                "org-1",
                model_instance=object(),
            )

        self.assertEqual(total, Decimal("30"))

    def test_check_organization_and_notify_forwards_model_and_source(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        model = object()
        with patch.object(
            mod.LowBalanceAlertService,
            "resolve_alertable_credits",
            return_value=Decimal("42"),
        ) as resolve_mock, \
             patch.object(
                 mod.LowBalanceAlertService,
                 "check_and_notify",
                 return_value="warning",
             ) as check_mock:
            level = mod.LowBalanceAlertService.check_organization_and_notify(
                "org-1",
                model_instance=model,
                source="agent_conversation",
            )

        self.assertEqual(level, "warning")
        resolve_mock.assert_called_once_with("org-1", model_instance=model)
        check_mock.assert_called_once_with(
            "org-1",
            Decimal("42"),
            source="agent_conversation",
        )

    def test_charge_llm_usage_marks_agent_conversation_source(self):
        """扣费后钩子必须带模型 + source，否则 Electron 永远收不到可弹的事件。"""
        import inspect

        from apps.services.llm.services import billing as billing_mod

        src = inspect.getsource(billing_mod.charge_llm_usage)
        self.assertIn("check_organization_and_notify(", src)
        self.assertIn('source="agent_conversation"', src)
        self.assertIn("model_instance=model_instance", src)


class GetThresholdsResolutionTests(SimpleTestCase):
    """阈值读取：绝对值优先 → 老 pct 懒兼容换算 → 默认 50/10。"""

    def _get(self, metadata_cfg, monthly_credits=Decimal("0")):
        from apps.services.billing.services import low_balance_alert_service as mod

        policy = MagicMock(metadata={"low_balance_alert": metadata_cfg} if metadata_cfg is not None else {})
        with patch.object(mod, "cache") as cache_mock, \
             patch("apps.services.billing.models.OrganizationBillingPolicy.objects") as policy_qs, \
             patch.object(
                 mod.LowBalanceAlertService, "_resolve_monthly_credits",
                 return_value=monthly_credits,
             ):
            cache_mock.get.return_value = None
            policy_qs.filter.return_value.only.return_value.first.return_value = (
                policy if metadata_cfg is not None else None
            )
            return mod.LowBalanceAlertService.get_thresholds("org-1")

    def test_defaults_when_no_config(self):
        t = self._get(None)
        self.assertEqual(t.warning_credits, Decimal("50"))
        self.assertEqual(t.critical_credits, Decimal("10"))
        self.assertTrue(t.email_enabled)

    def test_absolute_credits_config_wins(self):
        t = self._get({
            "warning_credits": "300", "critical_credits": "30",
            # 残留老 key 也不该干扰绝对值
            "warning_pct": "20", "critical_pct": "5",
            "email_enabled": False,
        })
        self.assertEqual(t.warning_credits, Decimal("300"))
        self.assertEqual(t.critical_credits, Decimal("30"))
        self.assertFalse(t.email_enabled)

    def test_legacy_pct_lazily_converted(self):
        t = self._get(
            {"warning_pct": "20", "critical_pct": "5"},
            monthly_credits=Decimal("1000"),
        )
        self.assertEqual(t.warning_credits, Decimal("200.00"))
        self.assertEqual(t.critical_credits, Decimal("50.00"))

    def test_legacy_pct_without_quota_falls_back_to_defaults(self):
        t = self._get({"warning_pct": "20", "critical_pct": "5"})
        self.assertEqual(t.warning_credits, Decimal("50"))
        self.assertEqual(t.critical_credits, Decimal("10"))


class SetThresholdsPersistenceTests(SimpleTestCase):
    """保存绝对值时应写新 key 并清理历史百分比 key。"""

    def test_set_writes_credits_and_pops_legacy_pct(self):
        from apps.services.billing.services import low_balance_alert_service as mod

        policy = MagicMock(metadata={
            "low_balance_alert": {"warning_pct": "20", "critical_pct": "5", "email_enabled": True},
        })
        with patch("django.db.transaction.atomic", MagicMock()), \
             patch("apps.services.billing.models.OrganizationBillingPolicy.objects") as policy_qs, \
             patch.object(mod, "cache"), \
             patch.object(mod.LowBalanceAlertService, "get_thresholds") as get_mock:
            policy_qs.select_for_update.return_value.filter.return_value.first.return_value = policy

            mod.LowBalanceAlertService.set_thresholds(
                "org-1",
                warning_credits=Decimal("300"),
                critical_credits=Decimal("30"),
            )

        cfg = policy.metadata["low_balance_alert"]
        self.assertEqual(cfg["warning_credits"], "300")
        self.assertEqual(cfg["critical_credits"], "30")
        self.assertNotIn("warning_pct", cfg)
        self.assertNotIn("critical_pct", cfg)
        self.assertTrue(cfg["email_enabled"])
        get_mock.assert_called_once_with("org-1")


class ResolveOwnerContactFieldTests(SimpleTestCase):
    def test_owner_query_orders_by_joined_at_not_created_at(self):
        """OrganizationMember 只有 joined_at；用 created_at 会 FieldError 导致邮件全灭。"""
        import inspect
        from apps.services.billing.services import low_balance_alert_service as mod

        src = inspect.getsource(mod.LowBalanceAlertService.resolve_owner_contact)
        src2 = inspect.getsource(mod.LowBalanceAlertService.send_low_balance_email)
        self.assertIn('order_by("joined_at")', src)
        self.assertIn('order_by("joined_at")', src2)
        self.assertNotIn('order_by("created_at")', src)
        self.assertNotIn('order_by("created_at")', src2)

    @patch("apps.services.billing.tasks.cache")
    @patch("apps.services.billing.tasks._try_acquire_lock", return_value=True)
    @patch("apps.services.billing.tasks._release_lock")
    @patch("apps.services.billing.services.low_balance_alert_service.LowBalanceAlertService")
    @patch("apps.users.wallet.models.OrganizationWallet.objects")
    def test_scan_includes_zero_balance_wallets(
        self, wallet_qs, alert_svc, _release, _lock, cache_mock,
    ):
        from apps.services.billing.tasks import daily_low_balance_email_alert

        # filter().values_list(...)[:5000] → list(...)
        values_qs = MagicMock()
        values_qs.__getitem__ = MagicMock(return_value=[("org-zero", Decimal("0"))])
        wallet_qs.filter.return_value.values_list.return_value = values_qs

        thresholds = MagicMock(
            email_enabled=True,
            warning_credits=Decimal("50"),
            critical_credits=Decimal("10"),
        )
        alert_svc.get_thresholds.return_value = thresholds
        # 日扫改为可消耗点券口径；零钱包且无月度剩余仍应 critical
        alert_svc.resolve_alertable_credits.return_value = Decimal("0")
        alert_svc.send_low_balance_email.return_value = True
        cache_mock.get.return_value = None

        result = daily_low_balance_email_alert.run()

        wallet_qs.filter.assert_called()
        filter_kwargs = wallet_qs.filter.call_args.kwargs
        self.assertIn("credits_precise__gte", filter_kwargs)
        self.assertEqual(filter_kwargs["credits_precise__gte"], Decimal("0"))
        self.assertNotIn("credits_precise__gt", filter_kwargs)
        alert_svc.resolve_alertable_credits.assert_called_once_with("org-zero")
        self.assertEqual(result["critical"], 1)
        self.assertEqual(result["emailed"], 1)
        alert_svc.send_low_balance_email.assert_called_once()
