"""
回归测试：CC-006、CC-013 修复验证

CC-006: incremental_index_all 直接调用 service.index_tables_batch() 绕过 target-level 锁，
        与 index_table_task 并发时产生重复 embedding API 调用（重复计费）。
        修复：在调用 index_tables_batch 前对每个 table_id 竞争锁，已有锁则跳过。

CC-013: index_table_records_task 直接调用 service.index_table_records()，
        不持有任何 target-level 锁，与 embed_record_task 并发时存在竞态。
        修复：添加 table-level target lock，TTL >= time_limit。
"""

import inspect
import uuid
from unittest.mock import patch, MagicMock, call, ANY
from django.test import SimpleTestCase, override_settings


class TestCC006IncrementalIndexLockProtection(SimpleTestCase):
    """CC-006: _run_incremental_index_all 必须在调用 index_tables_batch 前获取 target lock。"""

    def test_incremental_index_acquires_target_lock_before_batch(self):
        """_run_incremental_index_all 源码中必须调用 _acquire_target_lock 后再调用 index_tables_batch。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module._run_incremental_index_all)
        self.assertIn(
            "_acquire_target_lock",
            src,
            "_run_incremental_index_all 必须调用 _acquire_target_lock 以保护 table 索引",
        )
        self.assertIn(
            "_release_target_lock",
            src,
            "_run_incremental_index_all 必须在完成后调用 _release_target_lock 释放锁",
        )

    def test_incremental_index_skips_locked_tables(self):
        """当 table 已被其他 task 持有锁时，incremental_index_all 应跳过该 table（不调用 index_tables_batch）。"""
        import apps.rag.tasks as tasks_module

        table_id_locked = str(uuid.uuid4())
        table_id_free = str(uuid.uuid4())

        def fake_acquire_lock(target_type, target_id, ttl=600):
            if str(target_id) == table_id_locked:
                return ""
            return str(uuid.uuid4())

        mock_service = MagicMock()
        mock_service.index_tables_batch.return_value = {
            "total": 1, "success": 1, "skipped": 0, "failed": 0
        }

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.iterator.return_value = iter([])

        with patch("apps.rag.tasks._acquire_target_lock", side_effect=fake_acquire_lock), \
             patch("apps.rag.tasks._release_target_lock"), \
             patch("apps.rag.tasks._get_checkpoint", return_value=None), \
             patch("apps.rag.tasks._set_checkpoint"), \
             patch("apps.rag.tasks._iter_id_batches", return_value=[[table_id_locked, table_id_free]]), \
             patch("apps.rag.services.IndexService", return_value=mock_service), \
             patch("apps.tabdata.models.Table") as mock_table_cls, \
             patch("apps.tabdoc.models.Document") as mock_doc_cls:
            mock_table_cls.objects.order_by.return_value.values_list.return_value = mock_qs
            mock_doc_cls.objects.filter.return_value \
                .exclude.return_value \
                .exclude.return_value \
                .order_by.return_value \
                .values_list.return_value = mock_qs

            try:
                tasks_module._run_incremental_index_all()
            except Exception:
                pass

        calls = mock_service.index_tables_batch.call_args_list
        if calls:
            for c in calls:
                passed_ids = c[1].get("table_ids", c[0][0] if c[0] else [])
                self.assertNotIn(
                    table_id_locked,
                    [str(tid) for tid in passed_ids],
                    "已锁定的 table 不应被传入 index_tables_batch",
                )

    def test_incremental_index_releases_locks_after_batch(self):
        """每批次 index_tables_batch 完成后，已获取的锁必须全部释放。"""
        import apps.rag.tasks as tasks_module

        acquired = {}
        released = []

        def fake_acquire_lock(target_type, target_id, ttl=600):
            token = str(uuid.uuid4())
            acquired[str(target_id)] = token
            return token

        def fake_release_lock(target_type, target_id, token=""):
            released.append(str(target_id))

        table_ids = [str(uuid.uuid4()), str(uuid.uuid4())]

        mock_service = MagicMock()
        mock_service.index_tables_batch.return_value = {
            "total": 2, "success": 2, "skipped": 0, "failed": 0
        }

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.iterator.return_value = iter([])

        with patch("apps.rag.tasks._acquire_target_lock", side_effect=fake_acquire_lock), \
             patch("apps.rag.tasks._release_target_lock", side_effect=fake_release_lock), \
             patch("apps.rag.tasks._get_checkpoint", return_value=None), \
             patch("apps.rag.tasks._set_checkpoint"), \
             patch("apps.rag.tasks._iter_id_batches", return_value=[table_ids]), \
             patch("apps.rag.services.IndexService", return_value=mock_service), \
             patch("apps.tabdata.models.Table") as mock_table_cls, \
             patch("apps.tabdoc.models.Document") as mock_doc_cls:
            mock_table_cls.objects.order_by.return_value.values_list.return_value = mock_qs
            mock_doc_cls.objects.filter.return_value \
                .exclude.return_value \
                .exclude.return_value \
                .order_by.return_value \
                .values_list.return_value = mock_qs

            try:
                tasks_module._run_incremental_index_all()
            except Exception:
                pass

        for tid in acquired:
            self.assertIn(tid, released, f"table {tid} 获取了锁但未释放，可能导致锁泄漏")

    def test_incremental_index_releases_locks_even_on_exception(self):
        """即使 index_tables_batch 抛异常，已获取的锁也必须被释放（finally 块保护）。"""
        import apps.rag.tasks as tasks_module

        acquired = {}
        released = []

        def fake_acquire_lock(target_type, target_id, ttl=600):
            token = str(uuid.uuid4())
            acquired[str(target_id)] = token
            return token

        def fake_release_lock(target_type, target_id, token=""):
            released.append(str(target_id))

        table_ids = [str(uuid.uuid4())]

        mock_service = MagicMock()
        mock_service.index_tables_batch.side_effect = RuntimeError("模拟批量索引失败")

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.iterator.return_value = iter([])

        with patch("apps.rag.tasks._acquire_target_lock", side_effect=fake_acquire_lock), \
             patch("apps.rag.tasks._release_target_lock", side_effect=fake_release_lock), \
             patch("apps.rag.tasks._get_checkpoint", return_value=None), \
             patch("apps.rag.tasks._set_checkpoint"), \
             patch("apps.rag.tasks._iter_id_batches", return_value=[table_ids]), \
             patch("apps.rag.services.IndexService", return_value=mock_service), \
             patch("apps.tabdata.models.Table") as mock_table_cls, \
             patch("apps.tabdoc.models.Document") as mock_doc_cls:
            mock_table_cls.objects.order_by.return_value.values_list.return_value = mock_qs
            mock_doc_cls.objects.filter.return_value \
                .exclude.return_value \
                .exclude.return_value \
                .order_by.return_value \
                .values_list.return_value = mock_qs

            try:
                tasks_module._run_incremental_index_all()
            except Exception:
                pass

        for tid in acquired:
            self.assertIn(tid, released, f"table {tid} 的锁在异常场景下未被释放，会导致锁泄漏")


class TestCC013IndexTableRecordsTaskLock(SimpleTestCase):
    """CC-013: index_table_records_task 必须持有 table-level target lock。"""

    def test_index_table_records_task_source_acquires_target_lock(self):
        """index_table_records_task 源码中必须调用 _acquire_target_lock。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_records_task)
        self.assertIn(
            "_acquire_target_lock",
            src,
            "index_table_records_task 必须调用 _acquire_target_lock 防止并发竞态",
        )

    def test_index_table_records_task_source_releases_lock_in_finally(self):
        """index_table_records_task 必须在 finally 块中释放锁。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_records_task)
        self.assertIn(
            "_release_target_lock",
            src,
            "index_table_records_task 必须调用 _release_target_lock",
        )
        self.assertIn(
            "finally",
            src,
            "index_table_records_task 必须有 finally 块保证锁释放",
        )

    def test_index_table_records_task_skips_when_lock_not_acquired(self):
        """当 target lock 不可获取时，index_table_records_task 应直接返回 already_processing。"""
        import apps.rag.tasks as tasks_module

        table_id = str(uuid.uuid4())

        mock_request = MagicMock()
        mock_request.id = str(uuid.uuid4())
        mock_request.retries = 0

        mock_task = MagicMock()
        mock_task.request = mock_request
        mock_task.max_retries = 3

        with patch("apps.rag.tasks._acquire_target_lock", return_value=""), \
             patch("apps.tabdata.models.Table") as mock_table_model:
            mock_table_model.objects.filter.return_value.exists.return_value = True

            # 直接调用未绑定的函数体（绕过 Celery 装饰器，bind=True 场景下 self 是第一个参数）
            result = tasks_module.index_table_records_task.__wrapped__(
                mock_task, table_id, False
            )

        self.assertEqual(result.get("reason"), "already_processing")
        self.assertFalse(result.get("success"))

    def test_index_table_records_task_lock_ttl_exceeds_time_limit(self):
        """index_table_records_task 的锁 TTL 必须 >= time_limit (1800s)，防止任务超时前锁已过期。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_records_task)

        # 从源码提取 _acquire_target_lock 的 ttl 参数
        import re
        matches = re.findall(r'_acquire_target_lock\([^)]+ttl\s*=\s*(\d+)', src)
        self.assertTrue(matches, "index_table_records_task 中未找到带 ttl 参数的 _acquire_target_lock 调用")
        for ttl_val in matches:
            self.assertGreaterEqual(
                int(ttl_val), 1800,
                f"index_table_records_task 的锁 TTL={ttl_val} 必须 >= time_limit 1800s",
            )

    def test_index_table_records_task_releases_lock_before_retry(self):
        """index_table_records_task 在 except 路径中，retry 前必须先释放锁（防止锁泄漏）。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_records_task)

        # 验证 except 块中有 _release_target_lock 调用（在 retry 前释放）
        except_start = src.find("except Exception as exc:")
        self.assertNotEqual(except_start, -1, "index_table_records_task 中未找到 except 块")

        except_block = src[except_start:]
        retry_pos = except_block.find("self.retry(")
        release_pos = except_block.find("_release_target_lock(")

        self.assertNotEqual(release_pos, -1, "except 块中必须有 _release_target_lock 调用")
        self.assertLess(
            release_pos,
            retry_pos,
            "必须在 self.retry() 之前调用 _release_target_lock，否则重试时锁未释放",
        )

    def test_index_table_records_task_uses_table_lock_key(self):
        """index_table_records_task 应使用 'table' 类型的 target lock，与 index_table_task 共用同一锁命名空间。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_records_task)
        self.assertIn(
            '"table"',
            src,
            "index_table_records_task 应使用 target_type='table' 的锁，与 index_table_task 互斥",
        )
