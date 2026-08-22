from django.test import SimpleTestCase

from apps.services.common.ws.gateway import should_mark_device_offline_on_disconnect


class GatewayDisconnectOfflinePolicyTests(SimpleTestCase):
    def test_electron_disconnect_does_not_mark_device_offline(self):
        self.assertFalse(should_mark_device_offline_on_disconnect("electron"))

    def test_daemon_disconnect_still_marks_device_offline(self):
        self.assertTrue(should_mark_device_offline_on_disconnect("daemon"))

    def test_device_runtime_disconnect_still_marks_device_offline(self):
        self.assertTrue(should_mark_device_offline_on_disconnect("device_runtime"))
