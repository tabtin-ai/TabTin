from unittest.mock import patch

from django.test import SimpleTestCase


class BillingNotificationProjectionTests(SimpleTestCase):
    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch(
        "apps.services.notification.services.account_notification_adapter.project_account_notification"
    )
    def test_fully_projected_event_adds_authoritative_presentation_marker(
        self,
        mock_project,
        mock_publish,
    ):
        from apps.services.billing.ws_events import publish_billing_event
        from apps.services.notification.services.account_notification_adapter import ProjectionResult

        mock_project.return_value = ProjectionResult(
            authoritative=True,
            projected=True,
            recipient_count=2,
            source_event_id="account:org-1:credits_recharged:order-1",
        )

        self.assertTrue(
            publish_billing_event("org-1", "credits_recharged", {"order_id": "order-1"})
        )

        topic, envelope = mock_publish.call_args.args
        self.assertEqual(topic, "billing.events.org-1")
        self.assertEqual(
            envelope["presentation"],
            {
                "owner": "notification_projection",
                "authoritative": True,
                "projected": True,
                "source_event_id": "account:org-1:credits_recharged:order-1",
                "recipient_count": 2,
            },
        )
        self.assertEqual(envelope["type"], "billing.credits_recharged")
        self.assertEqual(
            envelope["payload"],
            {
                "event_type": "credits_recharged",
                "organization_id": "org-1",
                "order_id": "order-1",
            },
        )

    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch(
        "apps.services.notification.services.account_notification_adapter.project_account_notification"
    )
    def test_zero_recipient_projection_omits_marker_but_still_sends_ws(
        self,
        mock_project,
        mock_publish,
    ):
        from apps.services.billing.ws_events import publish_billing_event
        from apps.services.notification.services.account_notification_adapter import ProjectionResult

        mock_project.return_value = ProjectionResult(
            authoritative=True,
            projected=False,
            recipient_count=0,
            source_event_id="account:org-1:storage_warning:warning:2026-08-17",
        )

        self.assertTrue(publish_billing_event("org-1", "storage_warning", {"level": "warning"}))

        envelope = mock_publish.call_args.args[1]
        self.assertNotIn("presentation", envelope)
        self.assertEqual(envelope["type"], "billing.storage_warning")

    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch(
        "apps.services.notification.services.account_notification_adapter.project_account_notification",
        side_effect=RuntimeError("projection failed"),
    )
    def test_projection_failure_omits_marker_but_still_sends_ws(
        self,
        _mock_project,
        mock_publish,
    ):
        from apps.services.billing.ws_events import publish_billing_event

        self.assertTrue(
            publish_billing_event(
                "org-1",
                "platform_refund_failed",
                {"refund_record_id": "refund-1"},
            )
        )

        envelope = mock_publish.call_args.args[1]
        self.assertNotIn("presentation", envelope)
        self.assertEqual(envelope["type"], "billing.platform_refund_failed")
