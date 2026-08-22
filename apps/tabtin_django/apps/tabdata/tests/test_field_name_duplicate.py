"""字段同名校验：create/update 服务层友好报错。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.table_service import TableService


class EnsureUniqueActiveFieldNameTests(SimpleTestCase):
    def setUp(self):
        self.service = TableService(user=MagicMock())
        self.table_id = uuid4()

    @patch("apps.tabdata.services.table_service.TableField.objects")
    def test_create_duplicate_raises_friendly_error(self, mock_objects):
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.exists.return_value = True
        mock_objects.using.return_value = qs

        with self.assertRaises(ValueError) as ctx:
            self.service._ensure_unique_active_field_name(self.table_id, "状态")

        self.assertEqual(str(ctx.exception), '字段名称"状态"已存在，请输入其他字段名称')
        qs.filter.assert_called_once_with(
            table_id=self.table_id,
            name="状态",
            is_deleted=False,
        )
        qs.exclude.assert_not_called()

    @patch("apps.tabdata.services.table_service.TableField.objects")
    def test_edit_excludes_self(self, mock_objects):
        field_id = uuid4()
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.exclude.return_value = qs
        qs.exists.return_value = False
        mock_objects.using.return_value = qs

        self.service._ensure_unique_active_field_name(
            self.table_id,
            "状态",
            exclude_field_id=field_id,
        )

        qs.exclude.assert_called_once_with(id=field_id)
        qs.exists.assert_called_once()

    @patch("apps.tabdata.services.table_service.TableField.objects")
    def test_unique_name_passes(self, mock_objects):
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.exists.return_value = False
        mock_objects.using.return_value = qs

        self.service._ensure_unique_active_field_name(self.table_id, "优先级")
