from django.apps import apps as django_apps
from django.test import SimpleTestCase

from tabtin.celery import get_beat_schedule


class CeleryBeatScheduleLoadingTests(SimpleTestCase):
    def test_get_beat_schedule_skips_uninstalled_apps(self):
        self.assertFalse(django_apps.is_installed("apps.orchestration"))
        self.assertFalse(django_apps.is_installed("apps.services.llm"))
        self.assertFalse(django_apps.is_installed("apps.channel_gateway"))

        schedule = get_beat_schedule()

        self.assertIn("billing-retry-organization-lifecycle-cleanups", schedule)
        self.assertIn("ws-trim-event-buffers", schedule)
        self.assertNotIn("cleanup-agent-traces", schedule)
        self.assertNotIn("recover-stale-subagents", schedule)
        self.assertNotIn("llm-provider-health-probe", schedule)
        self.assertNotIn("channel-gateway-deliver-outbox", schedule)
