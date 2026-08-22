"""
CRT-01 / CRT-02 回归测试

CRT-01: PPTX 导入异步化 — 验证任务定义、缓存常量、临时文件清理
CRT-02: TabSlide 任务队列路由 — 验证所有重量级任务路由到 heavy 队列
"""
from __future__ import annotations

import inspect
import os
import tempfile
import unittest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()


class TestCRT02QueueRouting(unittest.TestCase):
    """CRT-02: 验证 TabSlide 所有 Celery 任务已路由到 heavy 队列。"""

    def test_tabslide_tasks_routed_to_heavy(self):
        from tabtin.settings import (
            CELERY_TASK_QUEUES,
            CELERY_TASK_ROUTES,
            PPTX_IMPORT_OSS_QUEUE,
        )
        from tabtin.runtime.registry import (
            QUEUE_REGISTRY,
            TASK_REGISTRY,
            WORKER_REGISTRY,
        )

        expected_heavy_tasks = [
            "tabslide.pregenerate_pptx",
            "tabslide.import_pptx_task",
            "tabslide.create_slide_history",
            "tabslide.cleanup_slide_history",
            "tabslide.migrate_fonts_to_oss",
            "tabslide.cleanup_element_changes",
        ]
        for task_name in expected_heavy_tasks:
            self.assertIn(task_name, CELERY_TASK_ROUTES, f"{task_name} 缺少路由配置")
            self.assertEqual(
                CELERY_TASK_ROUTES[task_name]["queue"],
                "heavy",
                f"{task_name} 应路由到 heavy 队列",
            )
        self.assertEqual(
            CELERY_TASK_ROUTES["tabslide.import_pptx_oss_task"]["queue"],
            PPTX_IMPORT_OSS_QUEUE,
        )
        self.assertIn(
            PPTX_IMPORT_OSS_QUEUE,
            {queue.name for queue in CELERY_TASK_QUEUES},
        )
        self.assertIn(PPTX_IMPORT_OSS_QUEUE, QUEUE_REGISTRY)
        self.assertIn(
            PPTX_IMPORT_OSS_QUEUE,
            WORKER_REGISTRY["worker-heavy"]["queues"],
        )
        self.assertEqual(
            TASK_REGISTRY["tabslide.import_pptx_oss_task"]["queue"],
            PPTX_IMPORT_OSS_QUEUE,
        )


class TestCRT01ImportPptxTask(unittest.TestCase):
    """CRT-01: PPTX 导入异步化回归测试。"""

    def test_task_is_registered_with_correct_name(self):
        from apps.tabslide.tasks import import_pptx_oss_task
        self.assertEqual(import_pptx_oss_task.name, "tabslide.import_pptx_oss_task")

    def test_legacy_task_name_and_argument_contract_are_unchanged(self):
        from apps.tabslide.tasks import import_pptx_task

        self.assertEqual(import_pptx_task.name, "tabslide.import_pptx_task")
        self.assertEqual(
            list(inspect.signature(import_pptx_task.run).parameters),
            [
                "file_path",
                "organization_id",
                "space_id",
                "file_name",
                "user_id",
                "agent_run_id",
                "collection_id",
            ],
        )

    def test_task_has_appropriate_time_limits(self):
        from apps.tabslide.tasks import import_pptx_oss_task
        self.assertEqual(import_pptx_oss_task.time_limit, 600)
        self.assertEqual(import_pptx_oss_task.soft_time_limit, 560)

    def test_task_does_not_retry(self):
        from apps.tabslide.tasks import import_pptx_oss_task
        self.assertEqual(import_pptx_oss_task.max_retries, 0)

    def test_cache_prefix_constant_defined(self):
        from apps.tabslide.tasks import IMPORT_PPTX_CACHE_PREFIX
        self.assertEqual(IMPORT_PPTX_CACHE_PREFIX, "import_pptx:")

    def test_task_source_contains_finally_cleanup(self):
        """确保任务包含 finally 块清理本地文件和 OSS 临时对象。"""
        from apps.tabslide.tasks import _execute_import_pptx_task
        src = inspect.getsource(_execute_import_pptx_task)
        self.assertIn("finally:", src, "任务应有 finally 块")
        self.assertIn("os.unlink(local_file_path)", src, "finally 块应删除临时文件")
        self.assertIn("oss_service.delete_file(object_key)", src,
                      "finally 块应删除 OSS 临时对象")

    def test_task_source_stores_progress_and_result(self):
        """确保任务在缓存中存储进度（processing）和结果（completed/failed）。"""
        from apps.tabslide.tasks import _execute_import_pptx_task
        src = inspect.getsource(_execute_import_pptx_task)
        self.assertIn('"status": "processing"', src)
        self.assertIn('"status": "completed"', src)
        self.assertIn('"status": "failed"', src)

    def test_api_import_endpoint_returns_task_id(self):
        """确保 API 端点返回 task_id 而非同步结果。"""
        from apps.tabslide.api import import_pptx
        src = inspect.getsource(import_pptx)
        self.assertIn("import_pptx_oss_task.delay", src,
                       "API 应调用 import_pptx_oss_task.delay 异步派发")
        self.assertIn("task_id", src,
                       "API 应在响应中返回 task_id")

    def test_status_polling_endpoint_exists(self):
        """确保状态轮询端点存在。"""
        from apps.tabslide.api import get_import_pptx_status
        src = inspect.getsource(get_import_pptx_status)
        self.assertIn("IMPORT_PPTX_CACHE_PREFIX", src,
                       "轮询端点应使用 IMPORT_PPTX_CACHE_PREFIX 读取缓存")


if __name__ == "__main__":
    unittest.main()
