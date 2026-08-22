from django.test import SimpleTestCase

from apps.services.common.ws.gateway import _should_filter_user_scope_event


class UserScopeActionEventFilterTests(SimpleTestCase):
    def test_allows_approval_memo_refresh_notification(self):
        self.assertFalse(
            _should_filter_user_scope_event(
                "agent.action.approval_memo_updated",
            ),
        )

    def test_filters_device_execution_action(self):
        self.assertTrue(
            _should_filter_user_scope_event(
                "agent.action.device.execute",
            ),
        )
