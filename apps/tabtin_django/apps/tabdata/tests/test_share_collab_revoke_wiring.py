"""TabData 分享撤权 / 降级 → collab-live revoke 接线单测。

与 tabdoc/tests/test_share_collab_revoke_wiring.py 对称；不走 settings_share_test。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

import apps.tabdata.services.share_service as share_service


class TabDataShareCollabRevokeWiringTests(SimpleTestCase):
    def _perm(self, *, permission: str = "editor"):
        perm = MagicMock()
        perm.permission = permission
        perm.is_active = True
        return perm

    @patch("apps.tabdata.services.share_service._schedule_table_collab_revoke")
    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_remove_schedules_hard_revoke(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_meta,
        _mock_notify,
        mock_revoke,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock()
        table.id = "table-123"
        table.organization_id = None
        table.space_id = None
        mock_get_table.return_value = table
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm()

        with (
            patch(
                "apps.tabtinspace.services.cloud_resource_visibility_events."
                "notify_cloud_resource_access_revoked",
            ),
            patch(
                "apps.tabtinspace.services.cloud_resource_visibility_events."
                "notify_cloud_resource_access_changed",
            ) as mock_changed,
        ):
            share_service.remove_collaborator(
                table_id="table-123",
                user_id="user-456",
                operator=MagicMock(id="owner-1"),
            )

        mock_revoke.assert_called_once_with("table-123", "user-456", read_only=False)
        mock_changed.assert_not_called()

    @patch("apps.tabdata.services.share_service._serialize_collaborator", return_value={})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    def test_unchanged_permission_does_not_notify_resource_card(
        self,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_serialize,
    ):
        mock_get_table.return_value = MagicMock(id="table-123")
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="editor",
        )

        with patch(
            "apps.tabtinspace.services.cloud_resource_visibility_events."
            "notify_cloud_resource_access_changed",
        ) as mock_changed:
            share_service.update_collaborator_permission(
                table_id="table-123",
                user_id="user-456",
                permission="editor",
                operator=MagicMock(id="owner-1"),
            )

        mock_changed.assert_not_called()

    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._filter_organization_members", return_value={"user-456"})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_first_invite_does_not_emit_permission_change(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_members,
        _mock_meta,
        _mock_notify,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_table.return_value = MagicMock(
            id="table-123", organization_id="org-1", space_id="space-1",
        )
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = None

        with (
            patch(
                "apps.tabtinspace.services.cloud_resource_visibility_events."
                "notify_cloud_resource_access_granted",
            ) as mock_granted,
            patch(
                "apps.tabtinspace.services.cloud_resource_visibility_events."
                "notify_cloud_resource_access_changed",
            ) as mock_changed,
        ):
            share_service.invite_collaborators(
                table_id="table-123",
                user_ids=["user-456"],
                permission="viewer",
                inviter=MagicMock(id="owner-1"),
            )

        mock_granted.assert_called_once()
        mock_changed.assert_not_called()

    @patch("apps.tabdata.services.share_service._serialize_collaborator", return_value={})
    @patch("apps.tabdata.services.share_service._schedule_table_collab_revoke")
    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_downgrade_to_viewer_schedules_read_only(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_meta,
        _mock_notify,
        mock_revoke,
        _mock_serialize,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock()
        table.id = "table-123"
        mock_get_table.return_value = table
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="editor",
        )

        share_service.update_collaborator_permission(
            table_id="table-123",
            user_id="user-456",
            permission="viewer",
            operator=MagicMock(id="owner-1"),
        )

        mock_revoke.assert_called_once_with("table-123", "user-456", read_only=True)

    @patch("apps.tabdata.services.share_service._serialize_collaborator", return_value={})
    @patch("apps.tabdata.services.share_service._schedule_table_collab_revoke")
    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_permission_change_notifies_resource_card(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_meta,
        _mock_notify,
        _mock_revoke,
        _mock_serialize,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock(id="table-123", organization_id="org-1", space_id="space-1")
        mock_get_table.return_value = table
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="editor",
        )

        with patch(
            "apps.tabtinspace.services.cloud_resource_visibility_events."
            "notify_cloud_resource_access_changed",
        ) as mock_changed:
            share_service.update_collaborator_permission(
                table_id="table-123",
                user_id="user-456",
                permission="viewer",
                operator=MagicMock(id="owner-1"),
            )

        mock_changed.assert_called_once_with(
            resource_type="tabdata",
            resource_id="table-123",
            organization_id="org-1",
            user_ids=["user-456"],
            actor_user_id="owner-1",
            space_id="space-1",
            db_alias=share_service.TABDATA_DB,
        )

    @patch("apps.tabdata.services.share_service._serialize_collaborator", return_value={})
    @patch("apps.tabdata.services.share_service._schedule_table_collab_revoke")
    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_upgrade_does_not_schedule_revoke(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_meta,
        _mock_notify,
        mock_revoke,
        _mock_serialize,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock()
        table.id = "table-123"
        mock_get_table.return_value = table
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="viewer",
        )

        share_service.update_collaborator_permission(
            table_id="table-123",
            user_id="user-456",
            permission="editor",
            operator=MagicMock(id="owner-1"),
        )

        mock_revoke.assert_not_called()

    @patch("apps.tabdata.services.share_service._schedule_table_collab_revoke")
    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._filter_organization_members")
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_invite_downgrade_to_viewer_schedules_read_only(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        mock_members,
        _mock_meta,
        _mock_notify,
        mock_revoke,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock()
        table.id = "table-123"
        table.organization_id = "org-1"
        mock_get_table.return_value = table
        mock_members.return_value = {"user-456"}
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="editor",
        )

        share_service.invite_collaborators(
            table_id="table-123",
            user_ids=["user-456"],
            permission="viewer",
            inviter=MagicMock(id="owner-1"),
        )

        mock_revoke.assert_called_once_with("table-123", "user-456", read_only=True)

    @patch("apps.tabdata.services.share_service._schedule_notify")
    @patch("apps.tabdata.services.share_service._build_metadata", return_value={})
    @patch("apps.tabdata.services.share_service._filter_organization_members", return_value={"user-456"})
    @patch("apps.tabdata.services.share_service._get_table_owner_id", return_value="owner-1")
    @patch("apps.tabdata.services.share_service._get_table_for_management")
    @patch("apps.tabdata.services.share_service.TablePermission.objects")
    @patch("apps.tabdata.services.share_service.transaction.atomic")
    def test_repeat_invite_permission_change_notifies_resource_card(
        self,
        mock_atomic,
        mock_perm_objects,
        mock_get_table,
        _mock_owner,
        _mock_members,
        _mock_meta,
        _mock_notify,
    ):
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
        table = MagicMock(id="table-123", organization_id="org-1", space_id="space-1")
        mock_get_table.return_value = table
        mock_perm_objects.using.return_value.filter.return_value.first.return_value = self._perm(
            permission="viewer",
        )

        with patch(
            "apps.tabtinspace.services.cloud_resource_visibility_events."
            "notify_cloud_resource_access_changed",
        ) as mock_changed:
            share_service.invite_collaborators(
                table_id="table-123",
                user_ids=["user-456"],
                permission="editor",
                inviter=MagicMock(id="owner-1"),
            )

        mock_changed.assert_called_once_with(
            resource_type="tabdata",
            resource_id="table-123",
            organization_id="org-1",
            user_ids=["user-456"],
            actor_user_id="owner-1",
            space_id="space-1",
            db_alias=share_service.TABDATA_DB,
        )

    @patch("apps.tabdata.services.share_service.connections")
    def test_schedule_helper_enqueues_celery_on_commit(self, mock_connections):
        registered = []
        mock_connections.__getitem__.return_value.on_commit.side_effect = (
            lambda fn: registered.append(fn)
        )

        share_service._schedule_table_collab_revoke("table-123", "user-456", read_only=False)
        self.assertEqual(len(registered), 1)

        with patch(
            "apps.collab.tasks.async_revoke_document_collab_access.delay",
        ) as mock_delay:
            registered[0]()
            mock_delay.assert_called_once_with(
                "table:table-123", "user-456", read_only=False,
            )
