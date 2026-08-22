"""Fork message id remap contract shared by cloud and local archives."""

import uuid

from django.test import SimpleTestCase

from apps.chat.conversation.services.fork_message_id_remap import (
    forked_message_id,
    remap_message_ids_in_value,
)


class ForkMessageIdRemapTests(SimpleTestCase):
    def test_matches_local_archive_uuid_v5_contract(self):
        target_session_id = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        source_message_id = uuid.UUID("11111111-1111-4111-8111-111111111111")

        expected = uuid.uuid5(
            target_session_id,
            f"{target_session_id}:{source_message_id}",
        )

        self.assertEqual(
            forked_message_id(target_session_id, source_message_id),
            expected,
        )

    def test_rewrites_exact_message_references_recursively(self):
        source_message_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
        target_message_id = uuid.UUID("22222222-2222-4222-8222-222222222222")
        unrelated_id = "33333333-3333-4333-8333-333333333333"

        value = {
            "message_id": str(source_message_id),
            "content": str(source_message_id),
            "metadata": {
                "parent_message_id": str(source_message_id),
                "unrelated_id": unrelated_id,
            },
        }

        self.assertEqual(
            remap_message_ids_in_value(
                value,
                {str(source_message_id): str(target_message_id)},
            ),
            {
                "message_id": str(target_message_id),
                "content": str(source_message_id),
                "metadata": {
                    "parent_message_id": str(target_message_id),
                    "unrelated_id": unrelated_id,
                },
            },
        )
