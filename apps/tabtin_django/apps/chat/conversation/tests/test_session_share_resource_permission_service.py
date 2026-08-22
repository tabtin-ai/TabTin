from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.chat.conversation.services import (
    session_share_resource_permission_service as permission_service,
)


class IncrementalSessionShareResourceGrantTests(SimpleTestCase):
    def test_placeholder_resource_ids_are_ignored(self):
        valid_id = "02eda024-5f11-4d4a-85c2-9a1b3c5d7e90"

        pointers = permission_service._resource_pointers_from_blocks([
            {
                "type": "text",
                "text": (
                    "tabtin://resource/table/%3Ctable_id%3E "
                    f"tabtin://resource/document/{valid_id}"
                ),
            },
        ])

        self.assertEqual(pointers, [("document", valid_id)])

    def test_new_assistant_resource_uses_latest_active_share_per_grantee(self):
        latest_first = SimpleNamespace(
            owner_user_id="owner-1",
            grantee_user_id="grantee-1",
            status="active",
        )
        older_first = SimpleNamespace(
            owner_user_id="owner-1",
            grantee_user_id="grantee-1",
            status="active",
        )
        latest_second = SimpleNamespace(
            owner_user_id="owner-1",
            grantee_user_id="grantee-2",
            status="active",
        )
        shares = Mock()
        shares.select_for_update.return_value = shares
        shares.exclude.return_value = shares
        shares.order_by.return_value = [latest_first, older_first, latest_second]
        message = SimpleNamespace(
            role="assistant",
            content_blocks_json=[{"kind": "resource_ref"}],
            session=SimpleNamespace(shares=shares),
        )
        owner = SimpleNamespace(id="owner-1")

        with (
            patch.object(permission_service.transaction, "atomic", return_value=nullcontext()),
            patch.object(
                permission_service,
                "_resource_pointers_from_blocks",
                return_value=[("table", "table-1")],
            ),
            patch.object(
                permission_service,
                "_load_share_owners",
                return_value={"owner-1": owner},
            ),
            patch.object(
                permission_service,
                "_sync_resource_pointers_for_share",
            ) as sync_pointers,
        ):
            permission_service.sync_active_session_share_resource_grants_for_message(
                message=message,
            )

        shares.select_for_update.assert_called_once_with()
        shares.exclude.assert_called_once_with(status="pending")
        shares.order_by.assert_called_once_with(
            "grantee_user_id",
            "-created_at",
            "-id",
        )
        self.assertEqual(sync_pointers.call_count, 2)
        sync_pointers.assert_any_call(
            share=latest_first,
            owner_user=owner,
            resource_pointers=[("table", "table-1")],
        )
        sync_pointers.assert_any_call(
            share=latest_second,
            owner_user=owner,
            resource_pointers=[("table", "table-1")],
        )

    def test_latest_revoked_share_blocks_older_active_share(self):
        latest = SimpleNamespace(
            owner_user_id="owner-1",
            grantee_user_id="grantee-1",
            status="revoked",
        )
        older = SimpleNamespace(
            owner_user_id="owner-1",
            grantee_user_id="grantee-1",
            status="active",
        )
        shares = Mock()
        shares.select_for_update.return_value = shares
        shares.exclude.return_value = shares
        shares.order_by.return_value = [latest, older]
        message = SimpleNamespace(
            role="assistant",
            content_blocks_json=[{"kind": "resource_ref"}],
            session=SimpleNamespace(shares=shares),
        )

        with (
            patch.object(permission_service.transaction, "atomic", return_value=nullcontext()),
            patch.object(
                permission_service,
                "_resource_pointers_from_blocks",
                return_value=[("table", "table-1")],
            ),
            patch.object(
                permission_service,
                "_sync_resource_pointers_for_share",
            ) as sync_pointers,
        ):
            permission_service.sync_active_session_share_resource_grants_for_message(
                message=message,
            )

        sync_pointers.assert_not_called()

    def test_user_message_and_message_without_resources_do_not_sync(self):
        shares = Mock()
        session = SimpleNamespace(shares=shares)

        permission_service.sync_active_session_share_resource_grants_for_message(
            message=SimpleNamespace(
                role="user",
                content_blocks_json=[{"kind": "resource_ref"}],
                session=session,
            ),
        )

        with patch.object(
            permission_service,
            "_resource_pointers_from_blocks",
            return_value=[],
        ):
            permission_service.sync_active_session_share_resource_grants_for_message(
                message=SimpleNamespace(
                    role="assistant",
                    content_blocks_json=[],
                    session=session,
                ),
            )

        shares.select_for_update.assert_not_called()
