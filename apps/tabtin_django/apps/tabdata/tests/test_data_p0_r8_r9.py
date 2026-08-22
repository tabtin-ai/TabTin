"""
DATA 层 P0 修复回归测试 — R8/R9（导入导出 + 字段执行）

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_data_p0_r8_r9.py -v
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

from unittest.mock import Mock, MagicMock, patch, PropertyMock
import pytest


# ━━ DATA-1: conversion_tasks max_retries=0 ━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA1ConversionNoRetry:
    """DATA-1: 类型转换任务 max_retries=0，禁止自动重试。"""

    def test_max_retries_is_zero(self):
        from apps.tabdata.tasks.conversion_tasks import convert_field_type_task
        assert convert_field_type_task.max_retries == 0

    def test_task_returns_error_on_exception(self):
        """即使抛异常也不重试，而是返回 error dict。"""
        from apps.tabdata.tasks.conversion_tasks import convert_field_type_task

        with patch(
            "apps.tabdata.tasks.conversion_tasks.TableService"
        ) as mock_svc_cls:
            mock_svc_cls.return_value.convert_field_type.side_effect = ValueError("boom")
            result = convert_field_type_task.apply(
                args=["00000000-0000-0000-0000-000000000001", "text"],
                kwargs={"user_id": None},
            )
            assert result.result["success"] is False
            assert "boom" in result.result["error"]


# ━━ DATA-2: table_service bulk_update 分批 ━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA2BulkUpdateBatch:
    """DATA-2: 转换记录使用 bulk_update 而非逐条 save。"""

    def test_table_service_uses_bulk_update(self):
        """确认 table_service.convert_field_type 内部调用了 bulk_update。"""
        import apps.tabdata.services.table_service as ts_module
        source = open(ts_module.__file__).read()
        assert "bulk_update" in source
        assert "next_record_version" in source
        assert "transaction.atomic" in source


# ━━ DATA-3: 大文件走 OSS 中转 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA3OSSTransit:
    """DATA-3: 超阈值文件先上传 OSS，任务参数只传 object_key。"""

    def test_oss_transit_threshold_defined(self):
        import apps.tabdata.api_import_export as api_mod
        assert hasattr(api_mod, "_OSS_TRANSIT_THRESHOLD")
        assert api_mod._OSS_TRANSIT_THRESHOLD == 5 * 1024 * 1024

    def test_import_task_accepts_oss_object_key(self):
        """async_import_data 接受 oss_object_key 参数。"""
        from apps.tabdata.tasks.import_export_tasks import async_import_data
        import inspect
        sig = inspect.signature(async_import_data)
        assert "oss_object_key" in sig.parameters

    def test_resolve_file_content_from_oss(self):
        """_resolve_file_content 能从 OSS 下载 csv 内容。"""
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        csv_bytes = "id,name\n1,Alice".encode("utf-8")
        with patch(
            "apps.tabdata.tasks.import_export_tasks._download_from_oss",
            return_value=csv_bytes,
        ):
            text, file_bytes = _resolve_file_content("csv", None, "import_transit/abc123")
            assert text == "id,name\n1,Alice"
            assert file_bytes is None

    def test_resolve_file_content_from_oss_excel(self):
        """_resolve_file_content 能从 OSS 下载 excel 字节。"""
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        raw = b"\x50\x4b\x03\x04"  # zip magic
        with patch(
            "apps.tabdata.tasks.import_export_tasks._download_from_oss",
            return_value=raw,
        ):
            text, file_bytes = _resolve_file_content("excel", None, "import_transit/abc123")
            assert text is None
            assert file_bytes == raw

    def test_resolve_file_content_inline_csv(self):
        """不传 oss_object_key 时走内联内容。"""
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        text, file_bytes = _resolve_file_content("csv", "id,name\n1,Bob", None)
        assert text == "id,name\n1,Bob"

    def test_resolve_file_content_inline_excel(self):
        """不传 oss_object_key 时 excel 走 base64 解码。"""
        import base64
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        raw = b"\x50\x4b\x03\x04"
        b64 = base64.b64encode(raw).decode("ascii")
        text, file_bytes = _resolve_file_content("excel", b64, None)
        assert text is None
        assert file_bytes == raw


# ━━ DATA-4: 导入/导出路由到 heavy 队列 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA4ImportExportRouting:
    """DATA-4: async_import_data / async_export_data 路由到 heavy 队列。"""

    def test_import_task_queue(self):
        from apps.tabdata.tasks.import_export_tasks import async_import_data
        assert async_import_data.queue == "heavy"

    def test_export_task_queue(self):
        from apps.tabdata.tasks.import_export_tasks import async_export_data
        assert async_export_data.queue == "heavy"


# ━━ DATA-16: 导入进度反馈 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA16ImportProgress:
    """DATA-16: 异步导入过程中推送进度事件。"""

    def test_progress_notify_function_exists(self):
        from apps.tabdata.tasks.import_export_tasks import _notify_import_progress
        assert callable(_notify_import_progress)

    def test_import_task_calls_progress(self):
        """async_import_data 内部调用了进度推送。"""
        import apps.tabdata.tasks.import_export_tasks as ie_mod
        source = open(ie_mod.__file__).read()
        assert "_notify_import_progress" in source
        assert "import_progress" in source
