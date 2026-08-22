"""个人回收站：每人只看自己删的；恢复校验组织级类型额度。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.db.models import Q
from django.test import SimpleTestCase

from apps.tabdata.models import Table
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.services.cloud_resource_acl import (
    check_restore_count_quota,
    is_personal_trash_operator,
    personal_trash_visibility_q,
)
from apps.tabtinspace.services.tabfiles_service import TabFilesService


class PersonalTrashHelperTests(SimpleTestCase):
    def test_is_personal_trash_operator_by_trashed_by(self) -> None:
        user = SimpleNamespace(id=uuid4())
        self.assertTrue(is_personal_trash_operator(user, trashed_by=user.id))
        self.assertFalse(is_personal_trash_operator(user, trashed_by=uuid4()))

    def test_is_personal_trash_operator_fallback_created_by(self) -> None:
        user = SimpleNamespace(id=uuid4())
        self.assertTrue(
            is_personal_trash_operator(user, trashed_by=None, created_by_id=user.id)
        )
        self.assertFalse(
            is_personal_trash_operator(user, trashed_by=None, created_by_id=uuid4())
        )

    def test_personal_trash_visibility_q_includes_trashed_by_and_legacy(self) -> None:
        user = SimpleNamespace(id=uuid4())
        q = personal_trash_visibility_q(user)
        text = str(q)
        self.assertIn("trashed_by", text)
        self.assertIn("created_by_id", text)

    def test_check_restore_count_quota_calls_quota_service(self) -> None:
        user = SimpleNamespace(id=uuid4())
        with patch(
            "apps.users.membership.services.quota_service.QuotaService"
        ) as quota_cls:
            check_restore_count_quota("tabdoc", uuid4(), user)
            quota_cls.return_value.check_quota.assert_called_once()
            kwargs = quota_cls.return_value.check_quota.call_args.kwargs
            self.assertEqual(kwargs["quota_type"], "max_documents")

        with patch(
            "apps.users.membership.services.quota_service.QuotaService"
        ) as quota_cls:
            check_restore_count_quota("tabfiles", uuid4(), user)
            quota_cls.return_value.check_quota.assert_not_called()


class ListPersonalTrashContractTests(SimpleTestCase):
    def test_list_filters_by_personal_visibility(self) -> None:
        from apps.tabtinspace.services.context_item_service import ContextItemService

        user = SimpleNamespace(id=uuid4())
        org_id = uuid4()
        svc = ContextItemService(user=user)
        fake_qs = MagicMock()
        fake_qs.filter.return_value = fake_qs
        fake_qs.select_related.return_value = fake_qs
        fake_qs.order_by.return_value = fake_qs
        fake_qs.count.return_value = 0
        fake_qs.__getitem__.return_value = []

        with (
            patch.object(svc, "check_organization_permission", return_value=True),
            patch(
                "apps.tabtinspace.services.context_item_service.ContextItem.objects.filter",
                return_value=fake_qs,
            ) as filter_mock,
            patch.object(svc, "_exclude_removed_module_types", side_effect=lambda qs: qs),
        ):
            items, total = svc.list_trashed_items_for_organization(org_id)

        self.assertEqual(items, [])
        self.assertEqual(total, 0)
        # 第二个位置参数或 kwargs 中应含个人可见性 Q
        args = filter_mock.call_args.args
        self.assertTrue(any(isinstance(a, Q) for a in args))
        joined = " ".join(str(a) for a in args)
        self.assertIn("trashed_by", joined)


class TablePersonalTrashContractTests(SimpleTestCase):
    def test_deleter_can_restore_when_acl_denies(self) -> None:
        table_id = uuid4()
        organization_id = uuid4()
        user = SimpleNamespace(id=uuid4(), is_authenticated=True, is_active=True)
        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.is_trashed = True
        mock_table.space_id = None
        mock_table.organization_id = organization_id
        mock_table.trashed_by = user.id
        mock_table.owner_id = uuid4()

        svc = TableService(user=user)

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "check_table_permission", return_value=False),
            patch(
                "apps.tabdata.services.table_service.assert_organization_resource_write_allowed_optional"
            ),
            patch(
                "apps.tabtinspace.services.cloud_resource_acl.check_restore_count_quota"
            ),
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch("apps.tabdata.services.table_service.ResourceBridge") as bridge_cls,
            patch(
                "apps.tabdata.services.schema_version_token.bump_table_schema_version_token"
            ),
            patch(
                "apps.tabdata.services.table_service.resolve_schema_partition_id",
                return_value="part",
            ),
            patch("apps.tabdata.services.table_service.TableField") as field_cls,
            patch.object(svc, "_native_ensure_table"),
        ):
            table_cls.objects.using.return_value.get.return_value = mock_table
            table_cls.DoesNotExist = Table.DoesNotExist
            field_cls.objects.using.return_value.filter.return_value = []
            result = svc.restore_table_from_trash(table_id)

        self.assertTrue(result)
        mock_table.restore_from_trash.assert_called_once()
        bridge_cls.on_restore.assert_called_once_with(mock_table, user=user)

    def test_other_user_cannot_restore(self) -> None:
        table_id = uuid4()
        user = SimpleNamespace(id=uuid4())
        mock_table = MagicMock()
        mock_table.is_trashed = True
        mock_table.trashed_by = uuid4()
        mock_table.owner_id = uuid4()
        mock_table.organization_id = uuid4()

        svc = TableService(user=user)
        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch("apps.tabdata.services.table_service.Table") as table_cls,
        ):
            table_cls.objects.using.return_value.get.return_value = mock_table
            table_cls.DoesNotExist = Table.DoesNotExist
            result = svc.restore_table_from_trash(table_id)

        self.assertFalse(result)


class TabFilesPersonalTrashContractTests(SimpleTestCase):
    def test_assert_allows_deleter(self) -> None:
        user = SimpleNamespace(id=uuid4())
        svc = TabFilesService(user=user)
        item = SimpleNamespace(
            id=uuid4(),
            trashed_by=user.id,
            created_by_id=uuid4(),
        )
        svc._assert_trashed_file_manageable(item)

    def test_assert_denies_non_deleter(self) -> None:
        from apps.tabtinspace.services.base import ServiceError

        user = SimpleNamespace(id=uuid4())
        svc = TabFilesService(user=user)
        item = SimpleNamespace(
            id=uuid4(),
            trashed_by=uuid4(),
            created_by_id=uuid4(),
        )
        with self.assertRaises(ServiceError):
            svc._assert_trashed_file_manageable(item)
