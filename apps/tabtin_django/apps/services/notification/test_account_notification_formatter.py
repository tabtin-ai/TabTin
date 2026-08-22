from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import MagicMock

from django.test import SimpleTestCase


class AccountNotificationFormatterTests(SimpleTestCase):
    def _prepare(self, event_type, payload, **context_values):
        from apps.services.notification.services.account_notification_formatter import (
            prepare_account_notification_display,
        )
        from apps.services.notification.services.account_notification_payloads import (
            AccountDisplayContext,
        )

        context = AccountDisplayContext(
            organization_name=context_values.get("organization_name", "测试组织"),
            member_name=context_values.get("member_name", "小明"),
        )
        return prepare_account_notification_display(event_type, payload, context)

    def test_supported_events_render_exact_canonical_copy(self):
        cases = [
            (
                "balance_low",
                {"level": "warning", "current_balance": 12.5, "threshold": 20.0},
                "点券余额不足",
                "当前可用12.5点券，已低于预警值20点券。",
                "account.balance_alert.v1",
            ),
            (
                "balance_low",
                {"level": "critical", "current_balance": "5.0000", "threshold": "10"},
                "点券余额严重不足",
                "当前可用5点券，继续消耗可能导致付费任务停止。",
                "account.balance_alert.v1",
            ),
            (
                "billing_blocked",
                {"reason": "insufficient_balance"},
                "「测试组织」的计费已被阻断",
                "因账户余额不足，需要付费的任务暂时无法继续执行。",
                "account.billing_blocked.v1",
            ),
            (
                "degradation_alert",
                {"meter_key": "llm.billing"},
                "计费服务出现异常",
                "AI 模型调用暂时受到影响，系统正在处理中。",
                "account.degradation_alert.v1",
            ),
            (
                "credits_recharged",
                {"amount": "100.0000"},
                "点券充值已到账",
                "本次到账 +100点券。",
                "account.credits_recharged.v1",
            ),
            (
                "cash_recharged",
                {"amount_cny": "100.00"},
                "现金充值已到账",
                "本次到账 +100.00 元。",
                "account.cash_recharged.v1",
            ),
            (
                "membership_expired",
                {"old_tier_name": "专业版", "new_tier_name": "免费版"},
                "专业版已到期",
                "当前已切换为免费版，部分会员权益已停止。",
                "account.membership_expired.v1",
            ),
            (
                "auto_renew_failed",
                {"tier_name": "专业版", "reason": "payment_declined"},
                "专业版自动续费失败",
                "失败原因：付款未通过。请更新付款方式后重新续费。",
                "account.auto_renew_failed.v1",
            ),
            (
                "membership_downgraded_overlimit",
                {"exceeded_items": [{"resource": "tables", "current": 12, "limit": 10}]},
                "会员降级后存在资源超限",
                "表格已使用12，当前上限为10。",
                "account.membership_downgraded_overlimit.v1",
            ),
            (
                "invoice_collection_failed",
                {
                    "total_amount": "30.0000",
                    "currency": "CREDITS",
                    "last_error_code": "payment_declined",
                    "attempt_count": 3,
                },
                "账单扣款失败",
                "应付金额为30点券。失败原因：付款未通过。",
                "account.invoice_collection_failed.v1",
            ),
            (
                "platform_refund_failed",
                {"amount": "100.00", "currency": "CNY", "reason": "provider_unavailable"},
                "退款处理失败",
                "100.00 元退款未完成。失败原因：支付服务暂时不可用。",
                "account.platform_refund_failed.v1",
            ),
            (
                "storage_warning",
                {"used_bytes": 1073741824, "package_bytes": 2147483648},
                "存储空间即将用满",
                "已使用1 GB/2 GB，请及时清理或扩充空间。",
                "account.storage_alert.v1",
            ),
            (
                "storage_critical",
                {"used_bytes": 1073741824, "package_bytes": 2147483648},
                "存储空间严重不足",
                "已使用1 GB/2 GB，上传和创建资源可能受到限制。",
                "account.storage_alert.v1",
            ),
            (
                "storage_auto_renew_failed",
                {"package_name": "扩容包", "reason": "timeout"},
                "扩容包自动续费失败",
                "失败原因：处理超时，请稍后重试。请更新付款方式后重新续费。",
                "account.storage_auto_renew_failed.v1",
            ),
            (
                "member_budget_warning",
                {"consumed": "80", "limit": "100"},
                "小明的预算即将用尽",
                "已使用80点券/100点券，剩余20点券。",
                "account.member_budget_warning.v1",
            ),
            (
                "member_budget_exhausted",
                {"consumed": "100", "limit": "100"},
                "小明的预算已用尽",
                "该成员后续需要付费的任务可能无法继续执行。",
                "account.member_budget_exhausted.v1",
            ),
        ]

        for event_type, payload, title, body, schema in cases:
            with self.subTest(event_type=event_type, level=payload.get("level")):
                prepared = self._prepare(event_type, payload)
                self.assertIsNotNone(prepared)
                self.assertEqual(prepared.title, title)
                self.assertEqual(prepared.body, body)
                self.assertEqual(prepared.display["schema"], schema)

    def test_human_visible_decimals_trim_only_insignificant_zeroes(self):
        cases = [
            (
                "credits_recharged",
                {"amount": "100.0000"},
                "本次到账 +100点券。",
                "amount",
                "100.0000",
            ),
            (
                "balance_low",
                {"level": "warning", "current_balance": "12.5000", "threshold": "20.0000"},
                "当前可用12.5点券，已低于预警值20点券。",
                "current_balance",
                "12.5000",
            ),
            (
                "invoice_collection_failed",
                {"total_amount": "30.00000000", "currency": "CREDITS"},
                "应付金额为30点券。失败原因：暂时无法完成处理。",
                "total_amount",
                "30.00000000",
            ),
            (
                "invoice_collection_failed",
                {"total_amount": "30.12000000", "currency": "CREDITS"},
                "应付金额为30.12点券。失败原因：暂时无法完成处理。",
                "total_amount",
                "30.12000000",
            ),
            (
                "invoice_collection_failed",
                {"total_amount": "0.01000000", "currency": "CREDITS"},
                "应付金额为0.01点券。失败原因：暂时无法完成处理。",
                "total_amount",
                "0.01000000",
            ),
        ]

        for event_type, payload, expected_body, display_key, stored_amount in cases:
            with self.subTest(event_type=event_type, payload=payload):
                prepared = self._prepare(event_type, payload)
                self.assertEqual(prepared.body, expected_body)
                self.assertEqual(prepared.display[display_key], stored_amount)

    def test_missing_or_invalid_required_numbers_keep_current_runtime_copy(self):
        cases = [
            ("balance_low", {"level": "warning", "threshold": "20"}),
            ("credits_recharged", {}),
            ("cash_recharged", {"amount_cny": None}),
            ("membership_downgraded_overlimit", {"exceeded_items": []}),
            ("invoice_collection_failed", {"total_amount": "not-a-number", "currency": "CREDITS"}),
            ("invoice_collection_failed", {"total_amount": "1", "currency": "USD"}),
            ("platform_refund_failed", {"amount": object(), "currency": "CNY"}),
            ("storage_warning", {"used_bytes": None, "package_bytes": 10}),
            ("storage_critical", {"used_bytes": 5, "package_bytes": "invalid"}),
            ("storage_package_expiring", {"package_name": "扩容包", "end_at": "invalid"}),
            ("member_budget_warning", {"consumed": "invalid", "limit": "100"}),
        ]

        for event_type, payload in cases:
            with self.subTest(event_type=event_type):
                self.assertIsNone(self._prepare(event_type, payload))

    def test_event_specific_fallbacks_never_expose_identifiers_or_raw_values(self):
        uuid_value = "123e4567-e89b-12d3-a456-426614174000"
        cases = [
            (
                "billing_blocked",
                {"reason": "Traceback database error request-id=secret"},
                {"organization_name": uuid_value},
                "「该组织」的计费已被阻断",
                "因暂时无法完成处理，需要付费的任务暂时无法继续执行。",
            ),
            (
                "degradation_alert",
                {"meter_key": "private.service", "error": "Traceback"},
                {},
                "计费服务出现异常",
                "部分计费能力暂时受到影响，系统正在处理中。",
            ),
            (
                "auto_renew_failed",
                {"tier_name": uuid_value, "error": "provider request ID abc"},
                {},
                "会员方案自动续费失败",
                "失败原因：暂时无法完成处理。请更新付款方式后重新续费。",
            ),
            (
                "storage_auto_renew_failed",
                {"package_name": uuid_value, "reason": None},
                {},
                "存储包自动续费失败",
                "失败原因：暂时无法完成处理。请更新付款方式后重新续费。",
            ),
            (
                "member_budget_exhausted",
                {"consumed": "100", "limit": "100", "user_id": uuid_value},
                {"member_name": uuid_value},
                "你的预算已用尽",
                "该成员后续需要付费的任务可能无法继续执行。",
            ),
        ]

        forbidden = [uuid_value, "Traceback", "database error", "request-id", "private.service", "None"]
        for event_type, payload, context, title, body in cases:
            with self.subTest(event_type=event_type):
                prepared = self._prepare(event_type, payload, **context)
                self.assertEqual(prepared.title, title)
                self.assertEqual(prepared.body, body)
                rendered = f"{prepared.title}\n{prepared.body}\n{prepared.display}"
                for raw_value in forbidden:
                    self.assertNotIn(raw_value, rendered)

    def test_metadata_display_keeps_typed_historical_values(self):
        prepared = self._prepare(
            "member_budget_warning",
            {"consumed": "80.2500", "limit": "100.0000", "usage_percent": 80.25},
        )

        self.assertEqual(
            prepared.display,
            {
                "schema": "account.member_budget_warning.v1",
                "member_name": "小明",
                "consumed": "80.2500",
                "limit": "100.0000",
                "remaining": "19.7500",
            },
        )

    def test_deferred_events_cannot_enter_canonical_formatter(self):
        deferred = {
            "membership_expiring": {"amount": "1", "currency": "CNY"},
            "refund_partial_failure": {"amount": "1", "currency": "CNY"},
            "invoice_collection_succeeded": {"amount": "1", "currency": "CNY"},
            "invoice_refunded": {"amount": "1", "currency": "CNY"},
            "platform_refund_completed": {"amount": "1", "currency": "CNY"},
            "storage_package_expiring": {
                "package_name": "扩容包",
                "end_at": "2026-08-24T09:00:00+08:00",
                "reduced_capacity_bytes": 10737418240,
            },
        }

        for event_type, payload in deferred.items():
            with self.subTest(event_type=event_type):
                self.assertIsNone(self._prepare(event_type, payload))


class AccountNotificationSafeReasonTests(SimpleTestCase):
    def test_safe_reason_allowlist_has_exact_user_copy(self):
        from apps.services.notification.services.account_notification_safe_reason import (
            resolve_safe_reason,
        )

        expected = {
            "insufficient_balance": "账户余额不足",
            "payment_method_unavailable": "付款方式不可用",
            "payment_declined": "付款未通过",
            "provider_unavailable": "支付服务暂时不可用",
            "timeout": "处理超时，请稍后重试",
            "account_restricted": "账户状态限制了本次处理",
            "unknown": "暂时无法完成处理",
        }
        for code, text in expected.items():
            with self.subTest(code=code):
                self.assertEqual(resolve_safe_reason(code), text)

    def test_unknown_or_non_string_reason_never_leaks(self):
        from apps.services.notification.services.account_notification_safe_reason import (
            resolve_safe_reason,
        )

        for raw in (None, object(), "Traceback: provider request ID secret", "database error"):
            with self.subTest(raw=raw):
                self.assertEqual(resolve_safe_reason(raw), "暂时无法完成处理")


class AccountNotificationAdapterDisplayTests(SimpleTestCase):
    def _project(self, event_type, payload, *, organization_name="测试组织", member_name="小明"):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )
        from apps.services.notification.services.account_notification_payloads import (
            AccountDisplayContext,
        )

        context = AccountDisplayContext(
            organization_name=organization_name,
            member_name=member_name,
        )
        with (
            patch(
                "apps.services.notification.services.account_notification_adapter._recipient_ids",
                return_value={"recipient-1"},
            ),
            patch(
                "apps.services.notification.services.account_notification_adapter._display_context",
                return_value=context,
            ),
            patch(
                "apps.services.notification.services.account_notification_adapter.NotificationService.notify"
            ) as notify,
        ):
            result = project_account_notification("org-1", event_type, payload)
        return result, notify.call_args.kwargs

    def test_projection_persists_canonical_copy_and_display_without_contract_drift(self):
        cases = [
            (
                "balance_low",
                {"level": "warning", "current_balance": 12.5, "threshold": 20.0},
                "点券余额不足",
                "当前可用12.5点券，已低于预警值20点券。",
            ),
            (
                "billing_blocked",
                {"block_type": "organization_billing_guard", "reason": "insufficient_balance"},
                "「测试组织」的计费已被阻断",
                "因账户余额不足，需要付费的任务暂时无法继续执行。",
            ),
            (
                "credits_recharged",
                {"order_id": "order-1", "amount": "100.0000"},
                "点券充值已到账",
                "本次到账 +100点券。",
            ),
            (
                "invoice_collection_failed",
                {
                    "invoice_id": "invoice-1",
                    "total_amount": "30.0000",
                    "currency": "CREDITS",
                    "last_error_code": "payment_declined",
                },
                "账单扣款失败",
                "应付金额为30点券。失败原因：付款未通过。",
            ),
            (
                "storage_warning",
                {"level": "warning", "used_bytes": 1024, "package_bytes": 2048},
                "存储空间即将用满",
                "已使用1 KB/2 KB，请及时清理或扩充空间。",
            ),
            (
                "member_budget_exhausted",
                {"user_id": "recipient-1", "budget_type": "monthly"},
                "小明的预算已用尽",
                "该成员后续需要付费的任务可能无法继续执行。",
            ),
        ]

        for event_type, payload, title, body in cases:
            with self.subTest(event_type=event_type):
                result, notification = self._project(event_type, payload)
                metadata = notification["metadata"]
                self.assertEqual(notification["title"], title)
                self.assertEqual(notification["body"], body)
                self.assertTrue(metadata["display"]["schema"].startswith("account."))
                self.assertEqual(metadata["category"], "account")
                self.assertEqual(notification["organization_id"], "org-1")
                self.assertTrue(metadata["dedupe_key"].startswith(f"account:org-1:{event_type}:"))
                self.assertEqual(metadata["channels"], ["center"])
                self.assertEqual(
                    metadata.get("navigate_to"),
                    {"type": "settings", "id": "usageBilling", "organizationId": "org-1"},
                )
                self.assertEqual(result.recipient_count, 1)

    def test_deferred_events_keep_exact_pr1a_runtime_copy_without_display(self):
        from apps.services.notification.services.account_notification_adapter import EVENT_PRESENTATION

        deferred = {
            "membership_expiring": {"tier_name": "专业版", "days_left": 7},
            "refund_partial_failure": {"expected": "100", "currency": "CNY"},
            "invoice_collection_succeeded": {"invoice_no": "INV-202608-1"},
            "invoice_refunded": {"invoice_no": "INV-202608-2"},
            "platform_refund_completed": {"invoice_no": "INV-202608-3"},
            "storage_package_expiring": {
                "package_name": "扩容包",
                "subscription_id": "subscription-1",
                "end_at": "2026-08-24T09:00:00+08:00",
                "reduced_capacity_bytes": 10737418240,
            },
        }
        for event_type, payload in deferred.items():
            with self.subTest(event_type=event_type):
                _result, notification = self._project(event_type, payload)
                old_title, old_body, _behavior = EVENT_PRESENTATION[event_type]
                self.assertEqual(notification["title"], old_title)
                self.assertEqual(notification["body"], old_body)
                self.assertNotIn("display", notification["metadata"])

    def test_missing_required_display_fact_keeps_safe_pr1a_runtime_copy(self):
        _result, notification = self._project("credits_recharged", {"order_id": "order-1"})

        self.assertEqual(notification["title"], "点券充值已到账")
        self.assertEqual(notification["body"], "本次充值已确认到账。")
        self.assertNotIn("display", notification["metadata"])


class AccountNotificationProducerSnapshotTests(SimpleTestCase):
    def test_collection_failure_adds_existing_invoice_amount_and_currency(self):
        from apps.services.billing.services.collection_service import BillingCollectionService

        invoice = SimpleNamespace(
            id="invoice-1",
            invoice_no="INV-202608-1",
            organization_id="org-1",
            total_amount=Decimal("30.00000000"),
            currency="CREDITS",
            metadata={"collection": {"attempt_count": BillingCollectionService.MAX_COLLECTION_ATTEMPTS - 1}},
            collection_attempt_count=BillingCollectionService.MAX_COLLECTION_ATTEMPTS - 1,
            status="open",
            save=MagicMock(),
        )
        failed_invoices = MagicMock()
        failed_invoices.count.return_value = 1

        with (
            patch(
                "apps.services.billing.services.collection_service.transaction.on_commit",
                side_effect=lambda callback: callback(),
            ),
            patch(
                "apps.services.billing.services.collection_service.BillingInvoice.objects.filter",
                return_value=failed_invoices,
            ),
            patch("apps.services.billing.services.collection_service.publish_billing_event") as publish,
            patch("apps.services.billing.tasks._dispatch_billing_alert"),
        ):
            BillingCollectionService._mark_collection_failed(
                invoice,
                payer_user_id="payer-1",
                error_message="raw provider error",
                error_code="payment_declined",
            )

        payload = publish.call_args.args[2]
        self.assertEqual(
            payload,
            {
                "invoice_id": "invoice-1",
                "invoice_no": "INV-202608-1",
                "attempt_count": BillingCollectionService.MAX_COLLECTION_ATTEMPTS,
                "last_error": "raw provider error",
                "last_error_code": "payment_declined",
                "total_amount": "30.00000000",
                "currency": "CREDITS",
            },
        )

    def test_platform_refund_failure_adds_existing_refund_amount_and_currency(self):
        from apps.services.billing.services.refund_service import BillingRefundService

        record = SimpleNamespace(
            id="refund-1",
            invoice_id="invoice-1",
            refund_no="REF-1",
            refund_amount=Decimal("100.00"),
            refund_status="refunding",
            failure_reason="",
            save=MagicMock(),
        )
        invoice = SimpleNamespace(organization_id="org-1")
        invoice_query = MagicMock()
        invoice_query.first.return_value = invoice

        with (
            patch("apps.services.payment.models.RefundRecord.objects.get", return_value=record),
            patch("apps.services.billing.models.BillingInvoice.objects.filter", return_value=invoice_query),
            patch("apps.services.billing.ws_events.publish_billing_event") as publish,
        ):
            BillingRefundService.complete_platform_refund(
                "refund-1",
                success=False,
                failure_reason="raw provider error",
            )

        payload = publish.call_args.args[2]
        self.assertEqual(
            payload,
            {
                "invoice_id": "invoice-1",
                "refund_record_id": "refund-1",
                "refund_no": "REF-1",
                "failure_reason": "raw provider error",
                "amount": "100.00",
                "currency": "CNY",
            },
        )
