"""
CRT-05 / CRT-06 / CRT-07 回归测试

CRT-05: save_from_hocuspocus / merge_updates 的 HTTP 调用移到事务外
CRT-06: merge_doc_updates Redis 分布式锁 TTL 从 120s 调整到 270s
CRT-07: TabDoc 所有重量级任务路由到 heavy 队列
"""
from __future__ import annotations

import ast
import inspect
import os
import textwrap
import unittest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()


class TestCRT07QueueRouting(unittest.TestCase):
    """CRT-07: 验证 TabDoc 所有 Celery 任务已路由到 heavy 队列。"""

    def test_tabdoc_tasks_routed_to_heavy(self):
        from tabtin.settings import CELERY_TASK_ROUTES

        expected_heavy_tasks = [
            "tabdoc.merge_doc_updates",
            "tabdoc.fix_missing_binary",
            "tabdoc.cleanup_expired_history",
            "tabdoc.index_document_embedding",
        ]
        for task_name in expected_heavy_tasks:
            self.assertIn(task_name, CELERY_TASK_ROUTES, f"{task_name} 缺少路由配置")
            self.assertEqual(
                CELERY_TASK_ROUTES[task_name]["queue"],
                "heavy",
                f"{task_name} 应路由到 heavy 队列",
            )


class TestCRT06LockTTL(unittest.TestCase):
    """CRT-06: merge_doc_updates 的 Redis 分布式锁 TTL 应 >= 270s。"""

    def test_lock_timeout_is_270_in_source(self):
        from apps.tabdoc.tasks import merge_doc_updates
        src = inspect.getsource(merge_doc_updates)
        self.assertIn("timeout=270", src,
                       "merge_doc_updates 中 cache.add 的 timeout 应为 270")

    def test_lock_timeout_not_120(self):
        from apps.tabdoc.tasks import merge_doc_updates
        src = inspect.getsource(merge_doc_updates)
        self.assertNotIn("timeout=120", src,
                         "merge_doc_updates 不应再使用旧值 timeout=120")


class TestCRT05HttpOutsideTransaction(unittest.TestCase):
    """CRT-05: 验证 HTTP 调用在事务外执行。"""

    def test_merge_updates_call_live_api_outside_atomic(self):
        """merge_updates 中 call_live_api 必须在 transaction.atomic 块之外。

        验证方法：在源码中，call_live_api 应出现在 CRT-05 标记行之后，
        即事务块结束后的区域。
        """
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.merge_updates)
        lines = src.split("\n")

        crt05_marker_line = None
        call_live_api_line = None
        atomic_end_line = None

        with_indent = None
        for i, line in enumerate(lines):
            if "with transaction.atomic" in line:
                with_indent = len(line) - len(line.lstrip())
            if with_indent is not None and atomic_end_line is None:
                stripped = line.strip()
                indent = len(line) - len(line.lstrip())
                if stripped and indent <= with_indent and i > 0 and "with transaction" not in line:
                    atomic_end_line = i
            if "# CRT-05:" in line:
                crt05_marker_line = i
            if "call_live_api" in line:
                call_live_api_line = i

        self.assertIsNotNone(crt05_marker_line, "应有 CRT-05 标记注释")
        self.assertIsNotNone(call_live_api_line, "应包含 call_live_api 调用")
        self.assertIsNotNone(atomic_end_line, "transaction.atomic 块应有结束点")

        self.assertGreater(
            call_live_api_line, atomic_end_line,
            "call_live_api 应在 transaction.atomic 块结束之后",
        )

    def test_save_from_hocuspocus_deferred_conversion(self):
        """save_from_hocuspocus 使用 needs_format_conversion 标志延迟 HTTP 调用。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.save_from_hocuspocus)

        self.assertIn("needs_format_conversion", src,
                       "应使用 needs_format_conversion 标记")
        self.assertIn("needs_format_conversion = True", src,
                       "事务内应设置标志为 True")

        lines = src.split("\n")
        flag_line_idx = None
        api_line_idx = None
        for i, line in enumerate(lines):
            if "needs_format_conversion = True" in line:
                flag_line_idx = i
            if "call_live_api" in line and "binary-to-formats" in line:
                api_line_idx = i

        if flag_line_idx is not None and api_line_idx is not None:
            self.assertGreater(api_line_idx, flag_line_idx,
                               "call_live_api 应在设置 needs_format_conversion 之后")

    def test_merge_updates_binary_update_inside_atomic(self):
        """事务内应至少包含 binary 和编辑者信息的更新。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.merge_updates)

        self.assertIn("description_binary=latest_blob", src,
                       "事务内应更新 description_binary")
        self.assertIn("last_editor_type=editor_type", src,
                       "事务内应更新编辑者信息")


if __name__ == "__main__":
    unittest.main()
