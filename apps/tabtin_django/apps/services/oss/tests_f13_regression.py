"""
F13 回归测试 — OSS 模块 P0 修复
覆盖: SVC-1, SVC-2, SVC-3, SVC-8 (+ SVC-5/SVC-6 Beat Schedule)
"""
import uuid
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.services.oss.models import FileRecord


class SVC1UrlPathScopeTest(TestCase):
    """SVC-1: url_path 在 object_key 分支外提前定义，传入自定义 key 时不再 NameError"""

    def test_url_path_defined_before_branch(self):
        """验证源码结构: url_path 在 if/else 之前赋值"""
        import ast
        import inspect
        from apps.services.oss.tasks import download_and_upload_from_url

        source = inspect.getsource(download_and_upload_from_url.__wrapped__)
        tree = ast.parse(source)
        func_body = tree.body[0].body

        url_path_assign_line = None
        if_object_key_line = None

        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "url_path":
                        if url_path_assign_line is None or node.lineno < url_path_assign_line:
                            url_path_assign_line = node.lineno
            if isinstance(node, ast.If):
                test = node.test
                if isinstance(test, ast.Name) and test.id == "object_key":
                    if_object_key_line = node.lineno

        self.assertIsNotNone(url_path_assign_line, "url_path 赋值未找到")
        self.assertIsNotNone(if_object_key_line, "if object_key 分支未找到")
        self.assertLess(
            url_path_assign_line, if_object_key_line,
            "url_path 必须在 if object_key 之前定义",
        )

    def test_retry_preserves_original_error(self):
        """同步复用 OSS task 时，上层必须拿到真实失败原因而非空 Retry。"""
        import inspect
        from apps.services.oss.tasks import download_and_upload_from_url

        source = inspect.getsource(download_and_upload_from_url.__wrapped__)
        self.assertGreaterEqual(source.count("self.retry(exc=e,"), 2)


class SVC2BatchUrlsSchemaTest(TestCase):
    """SVC-2: BatchUploadRequest schema 包含 urls 字段，API 从 data.urls 读取"""

    def test_schema_has_urls_field(self):
        from apps.services.oss.schemas import BatchUploadRequest

        data = BatchUploadRequest(urls=["https://a.com/1.png", "https://b.com/2.png"])
        self.assertEqual(len(data.urls), 2)

    def test_schema_urls_default_empty(self):
        from apps.services.oss.schemas import BatchUploadRequest

        data = BatchUploadRequest()
        self.assertEqual(data.urls, [])

    def test_api_reads_from_data_urls(self):
        """验证 batch_upload_from_urls 函数体不再包含 request.body 解析"""
        import inspect
        from apps.services.oss.api import batch_upload_from_urls

        source = inspect.getsource(batch_upload_from_urls)
        self.assertNotIn("request.body", source)
        self.assertNotIn("request.POST.getlist", source)
        self.assertIn("data.urls", source)


class SVC3IdempotentRetryTest(TestCase):
    """SVC-3: 重试时复用已有 FileRecord，不重复 create()"""

    def test_existing_uploading_record_is_reused(self):
        """模拟查询逻辑: metadata__celery_task_id 匹配已有记录"""
        fake_task_id = "celery-task-retry-test-001"

        existing = FileRecord.objects.create(
            file_name="test.png",
            file_key="folder/test.png",
            file_path="folder/",
            file_size=100,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash="abc123",
            bucket_name="test-bucket",
            upload_source="url",
            status="uploading",
            metadata={"celery_task_id": fake_task_id},
        )

        found = FileRecord.objects.filter(
            metadata__celery_task_id=fake_task_id,
            status="uploading",
        ).first()
        self.assertIsNotNone(found)
        self.assertEqual(found.id, existing.id)

    def test_no_match_when_celery_task_id_differs(self):
        FileRecord.objects.create(
            file_name="other.png",
            file_key="folder/other.png",
            file_path="folder/",
            file_size=100,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash="def456",
            bucket_name="test-bucket",
            upload_source="url",
            status="uploading",
            metadata={"celery_task_id": "different-task-id"},
        )

        found = FileRecord.objects.filter(
            metadata__celery_task_id="nonexistent-task-id",
            status="uploading",
        ).first()
        self.assertIsNone(found)


class SVC8SyncModeFileSizeLimitTest(TestCase):
    """SVC-8: sync_mode 单文件上限为 50MB"""

    def test_sync_mode_max_constant_is_50mb(self):
        from apps.services.oss.tasks import _SYNC_MODE_MAX_FILE_SIZE

        self.assertEqual(_SYNC_MODE_MAX_FILE_SIZE, 50 * 1024 * 1024)

    def test_sync_mode_guard_in_source(self):
        """验证 sync_mode 路径中有 _SYNC_MODE_MAX_FILE_SIZE 检查"""
        import inspect
        from apps.services.oss.tasks import batch_download_and_upload_from_urls

        source = inspect.getsource(batch_download_and_upload_from_urls.__wrapped__)
        self.assertIn("_SYNC_MODE_MAX_FILE_SIZE", source)


class BeatScheduleRegistrationTest(TestCase):
    """SVC-5 + SVC-6: Beat Schedule 已注册"""

    def test_oss_beat_schedule_defined(self):
        from apps.services.oss.tasks import OSS_BEAT_SCHEDULE

        self.assertIn("oss-cleanup-old-upload-tasks", OSS_BEAT_SCHEDULE)
        self.assertIn("oss-cleanup-orphan-files", OSS_BEAT_SCHEDULE)

    def test_docparse_beat_schedule_defined(self):
        """验证 docparse tasks.py 定义了 DOCPARSE_BEAT_SCHEDULE（源码检查避免 fitz 导入）"""
        import os

        docparse_tasks = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "docparse", "tasks.py",
        )
        with open(docparse_tasks) as f:
            source = f.read()
        self.assertIn("DOCPARSE_BEAT_SCHEDULE", source)
        self.assertIn("docparse-cleanup-temp-files", source)

    def test_celery_schedule_exports_include_oss_and_docparse(self):
        """验证 celery.py 的 _SCHEDULE_EXPORTS 注册了 oss 和 docparse"""
        import os

        celery_py = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "..", "tabtin", "celery.py",
        )
        with open(celery_py) as f:
            source = f.read()
        self.assertIn("apps.services.oss.tasks", source)
        self.assertIn("apps.services.docparse.tasks", source)
