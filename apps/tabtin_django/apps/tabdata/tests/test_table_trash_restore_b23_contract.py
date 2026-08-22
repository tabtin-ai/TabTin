"""TabData table trash restore B23 契约（TDA-23）

``POST /api/tabdata/tables/{table_id}/restore-from-trash`` 在 Table 仅有
``organization_id`` 软引用、无 ``organization`` ORM 关系时，不得再抛
``AttributeError: 'Table' object has no attribute 'organization'``。
"""
from __future__ import annotations

import inspect
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.table_service import TableService


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class _TabDataTableTrashApiBase(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._auth_patcher.stop()
        super().tearDownClass()

    def _post(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.post(url, data="{}", content_type="application/json", **headers)


class TestRestoreTableFromTrashServiceContract(SimpleTestCase):
    """TDA-23: restore_table_from_trash 使用 organization_id 配额上下文，不访问 table.organization。"""

    def test_restore_source_must_not_access_table_organization_relation(self):
        src = inspect.getsource(TableService.restore_table_from_trash)
        self.assertIsNone(
            re.search(r"table\.organization(?!_)", src),
            "restore_table_from_trash 不得访问 Table.organization ORM 关系",
        )

    def test_restore_succeeds_when_table_has_organization_id_only(self):
        table_id = uuid4()
        organization_id = uuid4()
        user = _make_user_namespace()
        mock_table = MagicMock()
        mock_table.is_trashed = True
        # org-only 表无 space_id，避免 restore 路径走进 host lock（与  云资产一致）
        mock_table.space_id = None
        mock_table.organization_id = organization_id
        mock_table.trashed_by = user.id
        mock_table.owner_id = user.id

        svc = TableService(user=user)

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch(
                "apps.tabdata.services.table_service.assert_organization_resource_write_allowed_optional"
            ),
            patch(
                "apps.tabtinspace.services.cloud_resource_acl.check_restore_count_quota"
            ) as count_quota,
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch("apps.tabdata.services.table_service.ResourceBridge") as bridge_cls,
            patch(
                "apps.tabdata.services.schema_version_token.bump_table_schema_version_token"
            ) as bump_token,
            patch(
                "apps.tabdata.services.table_service.resolve_schema_partition_id",
                return_value="part",
            ),
            patch("apps.tabdata.services.table_service.TableField") as field_cls,
            patch.object(svc, "_native_ensure_table"),
        ):
            from apps.tabdata.models import Table as TableModel

            table_cls.objects.using.return_value.get.return_value = mock_table
            table_cls.DoesNotExist = TableModel.DoesNotExist
            field_cls.objects.using.return_value.filter.return_value = []

            result = svc.restore_table_from_trash(table_id)

        self.assertTrue(result)
        mock_table.restore_from_trash.assert_called_once()
        bridge_cls.check_restore_quota.assert_called_once_with(mock_table)
        bridge_cls.on_restore.assert_called_once_with(mock_table, user=user)
        bump_token.assert_called_once()
        count_quota.assert_called_once_with("tabdata", organization_id, user)


class TestRestoreFromTrashApiContract(_TabDataTableTrashApiBase):
    """TDA-23: API 层 restore-from-trash 路由正常委托 TableService。"""

    def test_restore_from_trash_returns_200_when_service_succeeds(self):
        table_id = uuid4()
        with patch("apps.tabdata.api_table.TableService") as svc_cls:
            svc = MagicMock()
            svc.restore_table_from_trash.return_value = True
            svc_cls.return_value = svc

            response = self._post(f"/api/tabdata/tables/{table_id}/restore-from-trash")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body.get("success"))
        svc.restore_table_from_trash.assert_called_once_with(table_id)
