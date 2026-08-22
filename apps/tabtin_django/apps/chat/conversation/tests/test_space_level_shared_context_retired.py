import inspect

from django.test import SimpleTestCase


class ChatSharedContextRetiredTests(SimpleTestCase):
    def test_shared_context_helpers_are_not_exported(self):
        from apps.chat.conversation.api import _common

        self.assertFalse(hasattr(_common, "_find_shared_context_share"))
        self.assertFalse(hasattr(_common, "_get_shared_owner_user_id"))

    def test_session_and_checkpoint_paths_do_not_reference_spaceshare_shared_context(self):
        from apps.chat.conversation.api import rollback, session

        sources = (
            inspect.getsource(session.create_session),
            inspect.getsource(session.list_sessions),
            inspect.getsource(rollback.update_message_checkpoint),
        )

        for source in sources:
            self.assertNotIn("_find_shared_context_share", source)
            self.assertNotIn("_get_shared_owner_user_id", source)
            self.assertNotIn("SpaceShare", source)
