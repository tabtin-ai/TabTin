from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import SimpleTestCase, TestCase

from apps.services.notification.models import Notification
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization


class BillingWebSocketDisplayCompatibilityTests(SimpleTestCase):
    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch("apps.services.notification.services.account_notification_adapter.project_account_notification")
    def test_existing_payload_names_types_and_values_are_unchanged(
        self,
        project_notification,
        publish_ws,
    ):
        from apps.services.billing.ws_events import publish_billing_event
        from apps.services.notification.services.account_notification_adapter import ProjectionResult

        project_notification.return_value = ProjectionResult(
            authoritative=False,
            projected=False,
            recipient_count=1,
            source_event_id="source-1",
        )
        cases = {
            "balance_low": {
                "level": "warning",
                "current_balance": 12.5,
                "threshold": 20.0,
            },
            "credits_recharged": {"amount": "100.0000", "order_id": "order-1"},
            "invoice_collection_failed": {
                "invoice_id": "invoice-1",
                "invoice_no": "INV-202608-1",
                "attempt_count": 10,
                "last_error": "provider error",
                "last_error_code": "payment_declined",
                "total_amount": "30.00000000",
                "currency": "CREDITS",
            },
            "storage_warning": {
                "level": "warning",
                "usage_percent": 90,
                "used_bytes": 1024,
                "package_bytes": 2048,
            },
            "member_budget_exhausted": {
                "user_id": "user-1",
                "consumed": "100.0000",
                "limit": "100.0000",
                "budget_type": "monthly",
            },
        }

        for event_type, original_payload in cases.items():
            with self.subTest(event_type=event_type):
                publish_ws.reset_mock()
                payload_before = dict(original_payload)

                self.assertTrue(publish_billing_event("org-1", event_type, original_payload))

                envelope = publish_ws.call_args.args[1]
                self.assertEqual(
                    envelope["payload"],
                    {
                        "event_type": event_type,
                        "organization_id": "org-1",
                        **payload_before,
                    },
                )
                for field_name, expected_value in payload_before.items():
                    self.assertIs(type(envelope["payload"][field_name]), type(expected_value))
                self.assertEqual(original_payload, payload_before)


class AccountNotificationCanonicalProjectionPostgresTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        self.owner = self._create_user("负责人")
        self.member = self._create_user("小明")
        self.organization = Organization.objects.create(
            name="星云团队",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )

    @staticmethod
    def _create_user(nickname):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=nickname,
        )

    @patch(
        "apps.services.notification.services.notification_service.NotificationService._push_ws"
    )
    def test_representative_events_persist_canonical_snapshot_once_without_contract_drift(
        self,
        push_ws,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        cases = {
            "balance_low": (
                {"level": "warning", "current_balance": 12.5, "threshold": 20.0},
                self.owner,
                "点券余额不足",
                "当前可用12.5点券，已低于预警值20点券。",
                "account.balance_alert.v1",
            ),
            "billing_blocked": (
                {"block_type": "organization_billing_guard", "reason": "insufficient_balance"},
                self.owner,
                "「星云团队」的计费已被阻断",
                "因账户余额不足，需要付费的任务暂时无法继续执行。",
                "account.billing_blocked.v1",
            ),
            "credits_recharged": (
                {"order_id": "order-pg-1", "amount": "100.0000"},
                self.owner,
                "点券充值已到账",
                "本次到账 +100点券。",
                "account.credits_recharged.v1",
            ),
            "auto_renew_failed": (
                {"subscription_id": "sub-pg-1", "tier_name": "专业版", "reason": "payment_declined"},
                self.owner,
                "专业版自动续费失败",
                "失败原因：付款未通过。请更新付款方式后重新续费。",
                "account.auto_renew_failed.v1",
            ),
            "invoice_collection_failed": (
                {
                    "invoice_id": "invoice-pg-1",
                    "total_amount": "30.00000000",
                    "currency": "CREDITS",
                    "last_error_code": "payment_declined",
                },
                self.owner,
                "账单扣款失败",
                "应付金额为30点券。失败原因：付款未通过。",
                "account.invoice_collection_failed.v1",
            ),
            "storage_warning": (
                {"level": "warning", "used_bytes": 1024, "package_bytes": 2048},
                self.owner,
                "存储空间即将用满",
                "已使用1 KB/2 KB，请及时清理或扩充空间。",
                "account.storage_alert.v1",
            ),
            "member_budget_exhausted": (
                {"user_id": str(self.member.id), "budget_type": "monthly"},
                self.member,
                "小明的预算已用尽",
                "该成员后续需要付费的任务可能无法继续执行。",
                "account.member_budget_exhausted.v1",
            ),
        }

        for event_type, (payload, recipient, title, body, schema) in cases.items():
            with self.subTest(event_type=event_type):
                push_ws.reset_mock()
                before_count = Notification.objects.count()

                first = project_account_notification(str(self.organization.id), event_type, payload)
                second = project_account_notification(str(self.organization.id), event_type, payload)

                notifications = Notification.objects.filter(
                    user_id=str(recipient.id),
                    organization_id=str(self.organization.id),
                    type=f"account.{event_type}",
                )
                self.assertEqual(Notification.objects.count(), before_count + 1)
                self.assertEqual(notifications.count(), 1)
                notification = notifications.get()
                self.assertEqual(first, second)
                self.assertEqual(notification.title, title)
                self.assertEqual(notification.body, body)
                self.assertEqual(notification.metadata["display"]["schema"], schema)
                self.assertEqual(notification.category, "account")
                self.assertEqual(notification.channels_delivered, ["center"])
                self.assertEqual(notification.metadata["behavior"], "action_required" if event_type not in {"credits_recharged"} else "notification_only")
                self.assertEqual(
                    notification.metadata["navigate_to"],
                    {
                        "type": "settings",
                        "id": "usageBilling",
                        "organizationId": str(self.organization.id),
                    },
                )
                self.assertTrue(notification.dedupe_key)
                self.assertEqual(notification.source_event_id, first.source_event_id)
                push_ws.assert_called_once()
