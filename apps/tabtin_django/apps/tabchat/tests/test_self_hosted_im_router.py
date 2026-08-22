from django.test import SimpleTestCase

from apps.tabchat.api import legacy_message_router, router


class SelfHostedIMRouterTests(SimpleTestCase):
    def test_message_surface_uses_primary_im_router(self):
        self.assertIs(legacy_message_router, router)

        paths = set(legacy_message_router.path_operations)
        self.assertIn("/conversations/{conversation_id}/messages", paths)
        self.assertIn("/conversations/{conversation_id}/history-state", paths)
        self.assertIn("/search/grouped", paths)
