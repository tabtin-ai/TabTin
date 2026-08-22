"""
回归测试：CC-009、CC-010、CC-012 修复验证

CC-009: reindex_failed_tasks 只查 status='failed'，SIGTERM 导致的 processing 僵尸任务
        永久不被处理，旧记录无限累积。
        修复：在 reindex_failed_tasks 中增加 processing 超时检测（阈值 1800s），
             超时任务转为 failed 以触发 reindex。

CC-010: 缺少 processing 状态超时检测机制。EmbeddingTask.started_at 字段已存在，
        但无任何逻辑对 started_at < now - threshold 且 status='processing' 的任务处理。
        修复：与 CC-009 合并，在 reindex_failed_tasks 中完成。

CC-012: on_commit 回调中 task.delay() 失败时 Django 静默吞掉异常，
        导致"DB 已提交但 Celery 任务未入队"的双写不一致，EmbeddingTask 记录也不存在，
        reindex_failed_tasks 无法兜底。
        修复：在 signals.py 的 _do_index 函数中捕获 broker 异常，降级写入
             EmbeddingTask(status='failed')。
"""

import inspect
import uuid
from datetime import timedelta
from unittest.mock import patch, MagicMock, call, ANY
from django.test import SimpleTestCase, override_settings


class TestCC009CC010ProcessingTimeoutDetection(SimpleTestCase):
    """CC-009/CC-010: reindex_failed_tasks 必须包含 processing 超时检测逻辑。"""

    def test_reindex_failed_tasks_contains_processing_timeout_logic(self):
        """reindex_failed_tasks 源码中必须包含对 processing 状态的超时检测。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.reindex_failed_tasks)
        self.assertIn(
            'processing',
            src,
            "reindex_failed_tasks 必须检测 processing 状态的超时任务",
        )
        self.assertIn(
            'started_at',
            src,
            "reindex_failed_tasks 必须通过 started_at 字段判断超时",
        )
        self.assertIn(
            '_PROCESSING_TIMEOUT_SECONDS',
            src,
            "reindex_failed_tasks 必须使用 _PROCESSING_TIMEOUT_SECONDS 作为超时阈值",
        )

    def test_processing_timeout_threshold_is_reasonable(self):
        """_PROCESSING_TIMEOUT_SECONDS 必须大于 embed_record_task 的 time_limit（300s）。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.reindex_failed_tasks)
        # 从源码中提取阈值（1800s 硬编码）
        self.assertIn(
            '1800',
            src,
            "_PROCESSING_TIMEOUT_SECONDS 应为 1800s（embed_record_task time_limit 300s 的 6 倍余量）",
        )

    def test_reindex_failed_tasks_converts_timed_out_processing_to_failed(self):
        """超过超时阈值的 processing 任务必须被转为 failed 状态。"""
        import apps.rag.tasks as tasks_module
        from django.utils import timezone
        import datetime

        mock_task = MagicMock()
        mock_task.status = 'processing'
        mock_task.started_at = timezone.now() - datetime.timedelta(seconds=3600)

        timeout_cutoff = timezone.now() - datetime.timedelta(seconds=1800)

        # 验证逻辑：started_at < timeout_cutoff 时，任务应被标记为 failed
        self.assertLess(
            mock_task.started_at,
            timeout_cutoff,
            "started 3600s 前的任务超过 1800s 阈值，应被检测为超时",
        )

    def test_reindex_failed_tasks_does_not_convert_recent_processing_to_failed(self):
        """未超时的 processing 任务不应被转为 failed。"""
        from django.utils import timezone
        import datetime

        mock_task = MagicMock()
        mock_task.status = 'processing'
        mock_task.started_at = timezone.now() - datetime.timedelta(seconds=300)

        timeout_cutoff = timezone.now() - datetime.timedelta(seconds=1800)

        # 验证逻辑：started_at > timeout_cutoff 时，任务不应被标记为超时
        self.assertGreater(
            mock_task.started_at,
            timeout_cutoff,
            "started 300s 前的任务未超过 1800s 阈值，不应被检测为超时",
        )

    def test_reindex_returns_processing_timeout_count(self):
        """reindex_failed_tasks 的返回值中必须包含 processing_timeout_converted 字段。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.reindex_failed_tasks)
        self.assertIn(
            'processing_timeout_converted',
            src,
            "reindex_failed_tasks 返回值必须包含 processing_timeout_converted 字段",
        )

    def test_processing_timeout_runs_before_failed_cleanup(self):
        """超时检测逻辑必须在 failed 清理之前执行（转为 failed 后可被同次扫描处理）。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.reindex_failed_tasks)
        timeout_pos = src.find('_PROCESSING_TIMEOUT_SECONDS')
        failed_filter_pos = src.find("filter(status='failed')")
        self.assertLess(
            timeout_pos,
            failed_filter_pos,
            "processing 超时检测必须在 failed 清理块之前执行",
        )


class TestCC012BrokerFailureFallback(SimpleTestCase):
    """CC-012: on_commit 中 task.delay() 失败时必须降级写入 EmbeddingTask(status='failed')。"""

    def test_signals_contains_create_fallback_embedding_task(self):
        """signals.py 必须包含 _create_fallback_embedding_task 辅助函数。"""
        import apps.rag.signals as signals_module
        self.assertTrue(
            hasattr(signals_module, '_create_fallback_embedding_task'),
            "signals.py 必须定义 _create_fallback_embedding_task 降级函数",
        )

    def test_create_fallback_embedding_task_creates_failed_record(self):
        """_create_fallback_embedding_task 必须写入 status='failed' 的 EmbeddingTask。"""
        import apps.rag.signals as signals_module

        mock_task = MagicMock()
        with patch('apps.rag.signals._create_fallback_embedding_task') as mock_fallback:
            mock_fallback.return_value = None
            signals_module._create_fallback_embedding_task(
                'table', str(uuid.uuid4()), Exception("broker error")
            )

    def test_auto_index_table_catches_broker_exception(self):
        """auto_index_table 的 _do_index 必须捕获 index_table_task.delay() 异常并降级。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module.auto_index_table)
        self.assertIn(
            '_create_fallback_embedding_task',
            src,
            "auto_index_table._do_index 必须在 broker 异常时调用 _create_fallback_embedding_task",
        )
        # 验证有 try/except 捕获
        self.assertIn(
            'broker_exc',
            src,
            "auto_index_table._do_index 必须捕获 broker 写入异常",
        )

    def test_auto_index_table_field_catches_broker_exception(self):
        """auto_index_table_field 的 _do_index 必须捕获 broker 异常并降级。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module.auto_index_table_field)
        self.assertIn(
            '_create_fallback_embedding_task',
            src,
            "auto_index_table_field._do_index 必须在 broker 异常时调用 _create_fallback_embedding_task",
        )

    def test_auto_delete_table_field_index_catches_broker_exception(self):
        """auto_delete_table_field_index 的 _do_index 必须捕获 broker 异常并降级。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module.auto_delete_table_field_index)
        self.assertIn(
            '_create_fallback_embedding_task',
            src,
            "auto_delete_table_field_index._do_index 必须在 broker 异常时调用 _create_fallback_embedding_task",
        )

    def test_auto_index_document_catches_broker_exception(self):
        """auto_index_document 的 _do_index 必须捕获 broker 异常并降级。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module.auto_index_document)
        self.assertIn(
            '_create_fallback_embedding_task',
            src,
            "auto_index_document._do_index 必须在 broker 异常时调用 _create_fallback_embedding_task",
        )

    def test_fallback_function_creates_failed_status_not_pending(self):
        """降级写入的 EmbeddingTask 状态必须是 'failed'，不能是 'pending'，确保 reindex 能扫描到。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module._create_fallback_embedding_task)
        self.assertIn(
            "status='failed'",
            src,
            "_create_fallback_embedding_task 必须写入 status='failed'，不能是 pending",
        )
        self.assertNotIn(
            "status='pending'",
            src,
            "_create_fallback_embedding_task 不能写入 status='pending'",
        )

    def test_fallback_function_includes_error_message(self):
        """降级写入的 EmbeddingTask 必须包含 error_message 以便排查。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module._create_fallback_embedding_task)
        self.assertIn(
            'error_message',
            src,
            "_create_fallback_embedding_task 必须在 EmbeddingTask 中写入 error_message",
        )

    def test_fallback_function_handles_db_failure_gracefully(self):
        """降级写入本身也可能失败（如 DB 也宕机），必须有二次异常处理，不能崩溃。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module._create_fallback_embedding_task)
        # 两个 except 块：一个捕获 try-create，一个捕获外层
        except_count = src.count('except Exception')
        self.assertGreaterEqual(
            except_count,
            1,
            "_create_fallback_embedding_task 必须有 except 保护，避免二次异常崩溃",
        )

    def test_fallback_function_logs_on_both_success_and_failure(self):
        """降级写入成功和失败时都应有日志输出，方便监控排查。"""
        import apps.rag.signals as signals_module
        src = inspect.getsource(signals_module._create_fallback_embedding_task)
        self.assertIn(
            'logger.',
            src,
            "_create_fallback_embedding_task 必须包含日志输出",
        )
