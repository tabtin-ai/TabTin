"""#7437：TabData trash 后活跃访问门禁 + ResourceBridge 同步失败时不得假成功。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone

from apps.tabdata.services.table_service import TableService


def _make_user(user_id: str = "11111111-1111-1111-1111-111111111111"):
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class TestGetTableRejectsTrashed(SimpleTestCase):
    """活跃 get_table 默认拒绝已进回收站的表；allow_trashed 可放行。"""

    def test_get_table_rejects_trashed_by_default(self):
        table_id = uuid4()
        table = SimpleNamespace(
            id=table_id,
            organization_id=uuid4(),
            trashed_at=timezone.now(),
            is_trashed=True,
        )
        svc = TableService(user=_make_user())

        with (
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch.object(svc, "check_table_permission", return_value=True),
        ):
            table_cls.objects.using.return_value.get.return_value = table
            with self.assertRaises(ValueError) as ctx:
                svc.get_table(table_id)

        msg = str(ctx.exception)
        self.assertTrue(
            "回收站" in msg or "trash" in msg.lower(),
            msg,
        )

    def test_get_table_allow_trashed_returns_table(self):
        table_id = uuid4()
        table = SimpleNamespace(
            id=table_id,
            organization_id=uuid4(),
            trashed_at=timezone.now(),
            is_trashed=True,
        )
        svc = TableService(user=_make_user())

        with (
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch.object(svc, "check_table_permission", return_value=True),
        ):
            table_cls.objects.using.return_value.get.return_value = table
            result = svc.get_table(table_id, allow_trashed=True)

        self.assertIs(result, table)


class TestTrashTableRequiresBridgeSync(SimpleTestCase):
    """trash_table 仅在 ResourceBridge.on_trash 成功时返回 True。"""

    def test_trash_table_rolls_back_when_bridge_fails(self):
        table_id = uuid4()
        mock_table = MagicMock()
        mock_table.is_system_table = False
        mock_table.id = table_id

        user = _make_user()
        svc = TableService(user=user)

        class _DoesNotExist(Exception):
            pass

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch(
                "apps.tabdata.services.schema_version_token.bump_table_schema_version_token"
            ),
            patch("apps.tabdata.services.table_service.ResourceBridge") as bridge_cls,
        ):
            table_cls.DoesNotExist = _DoesNotExist
            table_cls.objects.using.return_value.get.return_value = mock_table
            bridge_cls.on_trash.return_value = False

            with self.assertRaises(ValueError) as ctx:
                svc.trash_table(table_id)

        self.assertIn("同步", str(ctx.exception))
        mock_table.trash.assert_called_once()
        bridge_cls.on_trash.assert_called_once_with(mock_table, user=user)

    def test_trash_table_succeeds_when_bridge_ok(self):
        table_id = uuid4()
        mock_table = MagicMock()
        mock_table.is_system_table = False
        mock_table.id = table_id

        user = _make_user()
        svc = TableService(user=user)

        class _DoesNotExist(Exception):
            pass

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.table_service.Table") as table_cls,
            patch(
                "apps.tabdata.services.schema_version_token.bump_table_schema_version_token"
            ),
            patch("apps.tabdata.services.table_service.ResourceBridge") as bridge_cls,
        ):
            table_cls.DoesNotExist = _DoesNotExist
            table_cls.objects.using.return_value.get.return_value = mock_table
            bridge_cls.on_trash.return_value = True

            ok = svc.trash_table(table_id)

        self.assertTrue(ok)
        mock_table.trash.assert_called_once()
        bridge_cls.on_trash.assert_called_once_with(mock_table, user=user)
