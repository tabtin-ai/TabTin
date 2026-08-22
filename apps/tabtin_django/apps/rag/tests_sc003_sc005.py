"""
SC-003 / SC-005 回归测试

SC-003: embed_record_task 入口应通过 Redis 分布式锁防止同一 record 并发执行。
        当 embedding API 响应超过防抖窗口时，第二个并发任务应被跳过。

SC-005: _flush_record_batch SPOP + delay 非原子问题。
        SPOP 后若 delay() 失败，record_id 应被回写到 Redis Set，防止永久丢失。
"""

import uuid
import unittest
from unittest.mock import patch, MagicMock, call


class FlushRecordBatchSC005Test(unittest.TestCase):
    """SC-005: SPOP + delay 失败时应回写 record_ids"""

    def test_delay_failure_restores_record_to_set(self):
        """delay() 失败时，record_id 应被回写到 Redis Set"""
        from apps.rag.tasks import _flush_record_batch

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())
        set_key = f"rag:record_batch:{table_id}"
        trigger_key = f"rag:record_batch_trigger:{table_id}"

        mock_redis = MagicMock()
        mock_redis.spop.side_effect = [
            [record_id.encode()],  # 第一批：弹出一个 record_id
            [],                     # 第二批：Set 已空
        ]
        mock_redis.scard.return_value = 0

        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_task:
            mock_task.delay.side_effect = Exception("Broker connection failed")

            result = _flush_record_batch(table_id)

        # 应调用 sadd 回写失败的 record_id
        mock_redis.sadd.assert_called_once_with(set_key, record_id)
        # flushed 计数应为 0（因为 delay 失败，未成功分发）
        self.assertEqual(result.get("flushed"), 0)

    def test_delay_success_does_not_restore(self):
        """delay() 成功时，不应调用 sadd 回写"""
        from apps.rag.tasks import _flush_record_batch

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.spop.side_effect = [
            [record_id.encode()],
            [],
        ]
        mock_redis.scard.return_value = 0

        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_task:
            mock_task.delay.return_value = MagicMock()  # 成功

            result = _flush_record_batch(table_id)

        # 成功时不应调用 sadd
        mock_redis.sadd.assert_not_called()
        self.assertEqual(result.get("flushed"), 1)

    def test_partial_delay_failure_restores_only_failed(self):
        """多个 record_id 中只有部分 delay 失败时，只回写失败的那些"""
        from apps.rag.tasks import _flush_record_batch

        table_id = str(uuid.uuid4())
        rid_success = str(uuid.uuid4())
        rid_fail = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.spop.side_effect = [
            [rid_success.encode(), rid_fail.encode()],
            [],
        ]
        mock_redis.scard.return_value = 0

        call_count = 0

        def side_effect_delay(rid, force):
            nonlocal call_count
            call_count += 1
            if rid == rid_fail:
                raise Exception("dispatch failed")

        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_task:
            mock_task.delay.side_effect = side_effect_delay

            result = _flush_record_batch(table_id)

        # 只有 rid_fail 应被回写
        mock_redis.sadd.assert_called_once_with(set_key := f"rag:record_batch:{table_id}", rid_fail)
        # flushed 为 1（成功分发了 rid_success）
        self.assertEqual(result.get("flushed"), 1)

    def test_redis_restore_failure_logs_critical(self):
        """回写 record_id 时 Redis 也不可用，应记录 CRITICAL 级别日志"""
        import logging
        from apps.rag.tasks import _flush_record_batch

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.spop.side_effect = [
            [record_id.encode()],
            [],
        ]
        mock_redis.scard.return_value = 0
        mock_redis.sadd.side_effect = Exception("Redis also down")

        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_task, \
             patch("apps.rag.tasks.logger") as mock_logger:
            mock_task.delay.side_effect = Exception("Broker failed")

            _flush_record_batch(table_id)

        # 应记录 error 级别日志（CRITICAL 场景）
        error_calls = mock_logger.error.call_args_list
        self.assertTrue(
            any("CRITICAL" in str(c) or "Data may be lost" in str(c) for c in error_calls),
            "应在回写失败时记录包含 CRITICAL 或 Data may be lost 的 error 日志",
        )


class EmbedRecordTaskSC003Test(unittest.TestCase):
    """SC-003: embed_record_task 应通过 Redis 锁防止并发执行"""

    def test_concurrent_task_skipped_when_lock_held(self):
        """当 record 锁已被持有时，新任务应直接跳过"""
        from apps.rag.tasks import _acquire_record_lock, _release_record_lock

        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        # 第一次 SET NX 成功（锁空闲）
        # 第二次 SET NX 失败（锁已被持有）
        mock_redis.set.side_effect = [True, None]

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            token1 = _acquire_record_lock(record_id)
            token2 = _acquire_record_lock(record_id)

        self.assertTrue(bool(token1), "第一次获锁应成功")
        self.assertFalse(bool(token2), "锁已被持有时，第二次获锁应失败（返回空字符串）")

    def test_lock_released_after_task_success(self):
        """任务成功后应释放 record 锁"""
        from apps.rag.tasks import _acquire_record_lock, _release_record_lock

        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.set.return_value = True  # 获锁成功

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            token = _acquire_record_lock(record_id)
            self.assertTrue(bool(token))
            _release_record_lock(record_id, token)

        # 应调用 Lua 脚本释放锁
        mock_redis.eval.assert_called_once()
        call_args = mock_redis.eval.call_args
        self.assertIn(f"rag:record_index_lock:{record_id}", str(call_args))

    def test_lock_released_after_task_failure(self):
        """任务失败后应释放 record 锁（finally 块保证）"""
        from apps.rag.tasks import _acquire_record_lock, _release_record_lock

        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            token = _acquire_record_lock(record_id)
            try:
                raise Exception("embedding failed")
            except Exception:
                pass
            finally:
                _release_record_lock(record_id, token)

        mock_redis.eval.assert_called_once()

    def test_redis_failure_in_acquire_is_fail_open(self):
        """Redis 故障时 _acquire_record_lock 应 fail-open（返回非空 token），允许任务执行"""
        from apps.rag.tasks import _acquire_record_lock

        record_id = str(uuid.uuid4())

        with patch("django_redis.get_redis_connection", side_effect=ConnectionError("Redis down")):
            token = _acquire_record_lock(record_id)

        # fail-open：Redis 故障时应返回非空 token，允许任务继续执行，防止所有 record 卡住
        self.assertTrue(bool(token), "Redis 故障时应 fail-open，返回非空 token")
        self.assertTrue(token.startswith("fail-open-"), "fail-open token 应有 fail-open- 前缀以便识别")

    def test_lock_ttl_greater_than_task_time_limit(self):
        """record 锁 TTL 应大于 embed_record_task time_limit（300s），防止任务执行中锁过期"""
        from apps.rag.tasks import _acquire_record_lock

        record_id = str(uuid.uuid4())
        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            _acquire_record_lock(record_id)

        mock_redis.set.assert_called_once()
        call_kwargs = mock_redis.set.call_args
        # redis.set(key, value, nx=True, ex=TTL) 中 ex 是关键字参数
        ex_value = call_kwargs.kwargs.get("ex")
        self.assertIsNotNone(ex_value, "应通过 ex 关键字参数设置 TTL")
        self.assertGreater(ex_value, 300, f"record 锁 TTL ({ex_value}s) 应大于 task time_limit (300s)")
