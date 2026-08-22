from unittest.mock import patch

from django.test import SimpleTestCase

from tabtin.settings import _default_tracker_agent_queue


class TrackerAgentQueueSettingsTests(SimpleTestCase):
    def _resolve(self, **overrides: str) -> str:
        keys = {
            "TRACKER_AGENT_QUEUE": "",
            "TRACKER_AGENT_ISOLATE_LOCAL_QUEUE": "",
            "TABTIN_INFRA_MODE": "remote",
            "TABTIN_QUEUE_SUFFIX": "My Mac",
            "KUBERNETES_SERVICE_HOST": "",
        }
        keys.update(overrides)
        with patch.dict("os.environ", keys, clear=False):
            return _default_tracker_agent_queue()

    def test_remote_local_runtime_uses_host_specific_queue(self):
        self.assertEqual(
            self._resolve(),
            "tracker_agent_my_mac",
        )

    def test_remote_kubernetes_runtime_uses_shared_queue(self):
        self.assertEqual(
            self._resolve(KUBERNETES_SERVICE_HOST="10.0.0.1"),
            "tracker_agent",
        )

    def test_explicit_queue_still_wins(self):
        self.assertEqual(
            self._resolve(TRACKER_AGENT_QUEUE="tracker_agent_custom"),
            "tracker_agent_custom",
        )
