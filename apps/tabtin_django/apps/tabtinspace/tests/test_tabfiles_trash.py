"""TabFiles 云盘裸文件回收站：trash / restore / permanent + TrashCleaner。"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.models import (
    ContextItem,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.tabfiles_service import TabFilesService
from apps.tabtinspace.services.trash_cleaner import TrashCleaner


User = get_user_model()


class TabFilesTrashServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.db_manager("default").create_user(
            username=f"tabfiles_trash_{uuid4().hex[:8]}",
            email=f"tabfiles-trash-{uuid4().hex[:8]}@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="TabFiles Trash Org",
            owner_id=self.user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        wd = f"/tmp/tabfiles-trash-{uuid4().hex[:8]}"
        self.space = Workspace.objects.create(
            organization=self.organization,
            created_by=self.user,
            name="Trash Workspace",
            working_dir=wd,
            normalized_working_dir=wd,
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.space,
            user=self.user,
            defaults={"role": "owner"},
        )
        self.file_record_id = uuid4()
        self.item = ContextItem.objects.create(
            workspace=self.space,
            item_type="tabfiles",
            title="notes.pdf",
            status="active",
            resource_id=str(self.file_record_id),
            metadata={"file_name": "notes.pdf", "mime_type": "application/pdf"},
            created_by=self.user,
            updated_by=self.user,
        )
        self.service = TabFilesService(user=self.user)

    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    def test_trash_file_sets_trashed_fields(self, mock_deactivate):
        item = self.service.trash_file(self.space.id, self.file_record_id)

        item.refresh_from_db()
        self.assertEqual(item.status, "trashed")
        self.assertIsNotNone(item.trashed_at)
        self.assertEqual(str(item.trashed_by), str(self.user.id))
        self.assertTrue(item.is_archived)
        self.assertEqual(item.previous_status, "active")
        mock_deactivate.assert_called_once()

    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_reactivate")
    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    @patch("apps.tabtinspace.services.tabfiles_service.FileRecord")
    def test_restore_file_clears_trash_and_returns_to_active(
        self,
        mock_file_record,
        _mock_deactivate,
        mock_reactivate,
    ):
        mock_file_record.objects.filter.return_value.exists.return_value = True
        self.service.trash_file(self.space.id, self.file_record_id)

        item = self.service.restore_file_from_trash(self.space.id, self.file_record_id)

        item.refresh_from_db()
        self.assertEqual(item.status, "active")
        self.assertIsNone(item.trashed_at)
        self.assertIsNone(item.trashed_by)
        self.assertFalse(item.is_archived)
        mock_reactivate.assert_called_once()

    @patch("apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage")
    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    def test_permanent_delete_removes_context_item(
        self,
        _mock_schedule,
        mock_deactivate,
    ):
        self.service.trash_file(self.space.id, self.file_record_id)
        item_id = self.item.id

        self.service.permanent_delete_file(self.space.id, self.file_record_id)

        self.assertFalse(ContextItem.objects.filter(id=item_id).exists())
        mock_deactivate.assert_called_once()
        kwargs = mock_deactivate.call_args.kwargs
        self.assertEqual(kwargs["module"], "tabfiles")
        self.assertEqual(kwargs["context_filter"]["context_id"], str(item_id))

    def test_trash_requires_editor(self):
        viewer = User.objects.db_manager("default").create_user(
            username=f"tabfiles_viewer_{uuid4().hex[:8]}",
            email=f"tabfiles-viewer-{uuid4().hex[:8]}@test.com",
            password="testpass123",
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.space,
            user=viewer,
            defaults={"role": "viewer"},
        )
        svc = TabFilesService(user=viewer)
        svc.check_space_permission = MagicMock(return_value=False)

        with self.assertRaises(ServiceError) as ctx:
            svc.trash_file(self.space.id, self.file_record_id)
        self.assertEqual(ctx.exception.status, 403)

    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    def test_trash_cleaner_deletes_trashed_tabfiles(self, _mock_schedule):
        self.service.trash_file(self.space.id, self.file_record_id)
        item_id = self.item.id

        with patch(
            "apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage",
        ) as mock_deactivate:
            TrashCleaner.permanent_delete_trashed_items(
                ContextItem.objects.filter(id=item_id),
                user=self.user,
            )

        self.assertFalse(ContextItem.objects.filter(id=item_id).exists())
        mock_deactivate.assert_called_once()

    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    def test_trash_cleaner_include_dead_letters_deletes_stuck_tabfiles(
        self, _mock_schedule,
    ):
        """用户主动清空时 include_dead_letters=True，死信条目也应被清掉。"""
        self.service.trash_file(self.space.id, self.file_record_id)
        item_id = self.item.id
        ContextItem.objects.filter(id=item_id).update(cleanup_fail_count=5)

        with patch(
            "apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage",
        ):
            TrashCleaner.permanent_delete_trashed_items(
                ContextItem.objects.filter(id=item_id),
                user=self.user,
            )
            self.assertTrue(ContextItem.objects.filter(id=item_id).exists())

            TrashCleaner.permanent_delete_trashed_items(
                ContextItem.objects.filter(id=item_id),
                user=self.user,
                include_dead_letters=True,
            )

        self.assertFalse(ContextItem.objects.filter(id=item_id).exists())

    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_reactivate")
    @patch("apps.tabtinspace.services.tabfiles_service.TabFilesService._schedule_file_usage_deactivate")
    @patch("apps.tabtinspace.services.tabfiles_service.FileRecord")
    def test_org_admin_can_restore_without_space_membership(
        self,
        mock_file_record,
        _mock_deactivate,
        _mock_reactivate,
    ):
        """组织回收站入口：org admin 即使不是 Space 成员也可还原。"""
        mock_file_record.objects.filter.return_value.exists.return_value = True
        self.service.trash_file(self.space.id, self.file_record_id)

        admin = User.objects.db_manager("default").create_user(
            username=f"tabfiles_admin_{uuid4().hex[:8]}",
            email=f"tabfiles-admin-{uuid4().hex[:8]}@test.com",
            password="testpass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=admin,
            role="admin",
        )
        admin_svc = TabFilesService(user=admin)

        item = admin_svc.restore_file_from_trash(self.space.id, self.file_record_id)
        item.refresh_from_db()
        self.assertEqual(item.status, "active")
        self.assertIsNone(item.trashed_at)


class TabFilesTrashRouterTests(TestCase):
    def _request(self):
        return SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

    @patch("apps.tabtinspace.routers.tabfiles._push_context_item_ws")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_trash_route_pushes_trashed_event(self, mock_service_cls, mock_push):
        from apps.tabtinspace.routers.tabfiles import trash_file

        item = SimpleNamespace(
            id=uuid4(),
            item_type="tabfiles",
            resource_id=str(uuid4()),
            space_id=uuid4(),
            title="a.pdf",
            metadata={},
            status="trashed",
            preview="",
            is_pinned=False,
            pinned_at=None,
            collection_id=None,
        )
        mock_service = MagicMock()
        mock_service.trash_file.return_value = item
        mock_service_cls.return_value = mock_service

        space_id = uuid4()
        file_id = uuid4()
        response = trash_file(self._request(), space_id, file_id)

        self.assertTrue(response["success"])
        mock_service.trash_file.assert_called_once_with(space_id, file_id)
        mock_push.assert_called_once()
        self.assertEqual(mock_push.call_args.args[1], "resource_trashed")
