from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.tabdata.models import TableField
from apps.tabdata.services.import_service import ImportService
from apps.tabdata.services.record_service import RecordService


class _FieldQuerySetStub(list):
    def exists(self):
        return bool(self)

    def exclude(self, **kwargs):
        items = [
            item for item in self
            if not any(getattr(item, key, None) == value for key, value in kwargs.items())
        ]
        return _FieldQuerySetStub(items)

    def order_by(self, *args, **kwargs):
        return self


def _make_field(
    name: str,
    field_type: str,
    *,
    is_hidden: bool = False,
):
    field = TableField(
        id=uuid.uuid4(),
        name=name,
        field_type=field_type,
        config={},
        validation_rules={},
    )
    field.is_hidden = is_hidden
    return field


class RecordServiceSystemManagedFieldTests(SimpleTestCase):
    def test_format_record_data_ignores_system_managed_inputs(self):
        service = RecordService(user=None)
        text_field = _make_field("名称", "text")
        created_time_field = _make_field("创建时间", "created_time")
        fields = [text_field, created_time_field]

        blocked_keys = service._find_system_managed_input_keys(
            {"名称": "Alice", "创建时间": "2026-08-20T00:00:00Z"},
            fields,
        )
        formatted = service._format_record_data(
            {"名称": "Alice", "创建时间": "2026-08-20T00:00:00Z"},
            fields=fields,
            skip_system_managed_inputs=True,
        )

        self.assertEqual(set(blocked_keys), {"创建时间"})
        # _format_record_data 以 field.id.hex（无连字符）为 key 输出。
        self.assertEqual(formatted[text_field.id.hex], "Alice")
        self.assertNotIn(created_time_field.id.hex, formatted)

    def test_bulk_update_strip_preserves_business_field(self):
        """编辑对话框回填后整条回传时，混入的（未改）系统字段被剔除而非整条拒绝。

        这是 bulk_update_records 治本逻辑的契约：发现系统托管 key 时静默 strip、保留
        业务字段继续提交——避免「用户改的值没更新到表格」（系统字段连坐丢弃业务改动）。
        """
        service = RecordService(user=None)
        text_field = _make_field("名称", "text")
        created_time_field = _make_field("创建时间", "created_time")
        fields = [text_field, created_time_field]

        raw_data = {"名称": "新名字", "创建时间": "2026-08-20T00:00:00Z"}

        # bulk_update 现在的处理：strip 掉 blocked key 后继续，而非 append 错误并 continue。
        blocked_keys = service._find_system_managed_input_keys(raw_data, fields)
        self.assertEqual(set(blocked_keys), {"创建时间"})

        blocked_set = set(blocked_keys)
        stripped = {k: v for k, v in raw_data.items() if str(k) not in blocked_set}
        self.assertEqual(stripped, {"名称": "新名字"})

        formatted = service._format_record_data(
            stripped, fields=fields, skip_system_managed_inputs=True,
        )
        # 业务字段保留下来，patch 非空 → 该条记录会被真正更新。
        self.assertEqual(formatted[text_field.id.hex], "新名字")
        self.assertNotIn(created_time_field.id.hex, formatted)


class ImportServiceSystemManagedFieldTests(SimpleTestCase):
    def test_validate_import_data_basic_text_columns(self):
        service = ImportService(user=None)
        fields = _FieldQuerySetStub(
            [
                _make_field("名称", "text"),
            ]
        )

        with patch("apps.tabdata.services.import_service.TableField.objects.using") as mock_using:
            mock_using.return_value.filter.return_value = fields
            is_valid, error, field_map = service.validate_import_data(
                uuid.uuid4(),
                ["名称"],
                [["Alice"]],
            )

        self.assertTrue(is_valid)
        self.assertIsNone(error)
        self.assertEqual(list(field_map.keys()), ["名称"])
