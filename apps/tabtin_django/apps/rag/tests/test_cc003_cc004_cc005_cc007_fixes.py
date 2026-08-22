"""
回归测试：CC-003、CC-004、CC-005、CC-007 修复验证

CC-003: _acquire_record_lock 在 Redis 异常时之前 fail-open（返回 non-empty token），
        导致 Redis 故障时并发执行，与 _acquire_target_lock 的 fail-closed 行为不一致。
        修复：Redis 异常时返回空串 ""（fail-closed）。

CC-004: incremental_index_all 在 Redis 异常时设 _acquired=True（fail-open），
        导致 Redis 最脆弱的时刻反而触发并发风暴。
        修复：Redis 异常时直接 return skip（fail-closed）。

CC-005: embed_record_task 异常路径中 self.retry() 抛出 Retry 异常，
        触发 finally 中的 _release_record_lock，导致双重释放，可能误删下一个 worker 的锁。
        修复：在 except 块中先释放锁并置空 token，finally 仅在 token 非空时释放。

CC-007: _flush_record_batch 回写失败 record_ids 时 redis.expire(set_key, 30) 硬编码 30s，
        与 DA-006 修复后的 300s 语义不符，broker 故障持续 >30s 时回写仍静默丢失。
        修复：定义 _RECORD_BATCH_SET_TTL=300 并使用该常量。
"""

import inspect
import uuid
from unittest.mock import patch, MagicMock, call, ANY
from django.test import SimpleTestCase, TestCase, override_settings


class TestCC003RecordLockFailClosed(SimpleTestCase):
    """CC-003: _acquire_record_lock 在 Redis 异常时必须 fail-closed（返回空串）。"""

    def test_redis_exception_returns_empty_string(self):
        """`_acquire_record_lock` Redis 异常时返回空串，而非 non-empty fail-open token。"""
        from apps.rag.tasks import _acquire_record_lock

        with patch("apps.rag.tasks.__builtins__", {}):
            pass

        # 通过 mock get_redis_connection 验证 fail-closed 行为
        record_id = str(uuid.uuid4())
        with patch("django_redis.get_redis_connection", side_effect=Exception("redis down")):
            result = _acquire_record_lock(record_id)

        self.assertEqual(
            result,
            "",
            "_acquire_record_lock 在 Redis 异常时必须返回空串（fail-closed），"
            "不能返回 fail-open-{uuid} 之类的非空值",
        )

    def test_redis_exception_does_not_return_failopen_token(self):
        """确认 Redis 异常时不会返回 'fail-open-' 前缀的 token。"""
        from apps.rag.tasks import _acquire_record_lock

        record_id = str(uuid.uuid4())
        with patch("django_redis.get_redis_connection", side_effect=ConnectionError("redis down")):
            result = _acquire_record_lock(record_id)

        self.assertFalse(
            result.startswith("fail-open-"),
            f"Redis 异常时不应返回 fail-open token，实际返回: {result!r}",
        )

    def test_source_code_no_fail_open_pattern(self):
        """源码中不应再出现 fail-open-{uuid} 模式。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module._acquire_record_lock)
        self.assertNotIn(
            "fail-open-",
            src,
            "_acquire_record_lock 源码不应包含 fail-open- 字符串",
        )


class TestCC004IncrementalIndexFailClosed(SimpleTestCase):
    """CC-004: incremental_index_all Redis 异常时必须 fail-closed（直接 return skip）。"""

    @override_settings(RAG_ENABLED=True)
    def test_redis_exception_skips_execution(self):
        """Redis 异常时 incremental_index_all 必须 return skip，而非继续执行。"""
        from apps.rag.tasks import incremental_index_all

        with patch("django_redis.get_redis_connection", side_effect=Exception("redis down")):
            result = incremental_index_all.run()

        self.assertIsInstance(result, dict)
        self.assertFalse(
            result.get("success", True) and not result.get("skipped", False),
            "Redis 不可用时 incremental_index_all 不应继续执行",
        )
        self.assertEqual(
            result.get("reason"),
            "redis_unavailable",
            f"Redis 异常时 reason 应为 redis_unavailable，实际: {result.get('reason')}",
        )

    @override_settings(RAG_ENABLED=True)
    def test_redis_exception_does_not_call_run_incremental(self):
        """Redis 异常时不应调用 _run_incremental_index_all。"""
        from apps.rag.tasks import incremental_index_all

        with patch("django_redis.get_redis_connection", side_effect=Exception("redis down")):
            with patch("apps.rag.tasks._run_incremental_index_all") as mock_run:
                incremental_index_all.run()

        mock_run.assert_not_called()

    def test_source_code_fail_closed(self):
        """源码中 Redis 异常分支不应再设 _acquired = True。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.incremental_index_all)
        # fail-open 特征：except 块中出现 _acquired = True
        lines = src.split("\n")
        in_except = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("except"):
                in_except = True
            elif stripped.startswith("if not _acquired") or stripped.startswith("try:"):
                in_except = False
            if in_except and "_acquired = True" in stripped:
                self.fail(
                    "incremental_index_all except 块中不应设 _acquired = True（fail-open 模式）"
                )


class TestCC005EmbedRecordTaskNoDualRelease(SimpleTestCase):
    """CC-005: embed_record_task 异常路径不应双重释放锁。"""

    def test_source_code_except_releases_before_retry(self):
        """except 块中必须在 self.retry() 前调用 _release_record_lock 并置空 lock_token。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.embed_record_task)

        # 确认 except 块中有 _release_record_lock 调用
        self.assertIn(
            "_release_record_lock",
            src,
            "embed_record_task except 块必须调用 _release_record_lock",
        )
        # 确认 lock_token = "" 出现（用于防止 finally 双重释放）
        self.assertIn(
            'lock_token = ""',
            src,
            "embed_record_task 必须在 except 块中将 lock_token 置空以防 finally 双重释放",
        )

    def test_source_code_finally_guards_with_if_lock_token(self):
        """finally 块必须用 if lock_token: 守护，避免双重释放。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.embed_record_task)

        self.assertIn(
            "if lock_token:",
            src,
            "embed_record_task finally 块必须有 if lock_token: 守护",
        )

    def test_release_called_once_on_retry_path(self):
        """验证 retry 路径下不会发生双重释放：except 释放后置空 token，finally 仅在 token 非空时执行。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.embed_record_task)

        # 找出 except 块和 finally 块中各自的关键语句顺序
        lines = src.split("\n")
        in_except = False
        in_finally = False
        except_has_release = False
        except_has_clear_token = False
        finally_has_guard = False

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("except Exception"):
                in_except = True
                in_finally = False
            elif stripped.startswith("finally:"):
                in_finally = True
                in_except = False
            elif stripped.startswith("def ") and not stripped.startswith("def embed_record_task"):
                break

            if in_except:
                if "_release_record_lock(" in stripped:
                    except_has_release = True
                if 'lock_token = ""' in stripped:
                    except_has_clear_token = True
            if in_finally:
                if "if lock_token:" in stripped:
                    finally_has_guard = True

        self.assertTrue(
            except_has_release,
            "except 块中必须调用 _release_record_lock（防止 Retry 异常触发 finally 双重释放）",
        )
        self.assertTrue(
            except_has_clear_token,
            'except 块中必须将 lock_token 置为 ""（防止 finally 再次释放）',
        )
        self.assertTrue(
            finally_has_guard,
            "finally 块必须用 if lock_token: 守护，避免 token 已清空时再次调用 _release_record_lock",
        )


class TestCC007FlushRecordBatchTTL(SimpleTestCase):
    """CC-007: _flush_record_batch 回写失败 record_ids 时必须使用 300s TTL，而非 30s。"""

    def test_source_code_uses_constant_not_hardcoded_30(self):
        """源码中不应再有 redis.expire(set_key, 30) 的硬编码 30。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module._flush_record_batch)

        # 确认不再有硬编码 30s
        self.assertNotIn(
            "expire(set_key, 30)",
            src,
            "_flush_record_batch 不应硬编码 expire(set_key, 30)，应使用 _RECORD_BATCH_SET_TTL",
        )

    def test_source_code_defines_record_batch_set_ttl(self):
        """源码中必须定义 _RECORD_BATCH_SET_TTL 常量。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module._flush_record_batch)

        self.assertIn(
            "_RECORD_BATCH_SET_TTL",
            src,
            "_flush_record_batch 必须定义 _RECORD_BATCH_SET_TTL 常量",
        )

    def test_source_code_ttl_value_is_300(self):
        """_RECORD_BATCH_SET_TTL 必须等于 300（与 DA-006 一致）。"""
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module._flush_record_batch)

        self.assertIn(
            "_RECORD_BATCH_SET_TTL = 300",
            src,
            "_RECORD_BATCH_SET_TTL 必须等于 300s",
        )

    def test_redis_expire_uses_correct_ttl(self):
        """实际 expire 调用中使用 300s TTL，而非 30s。"""
        from apps.rag.tasks import _flush_record_batch

        expire_calls = []

        def fake_spop(key, count):
            if not hasattr(fake_spop, "called"):
                fake_spop.called = True
                return [b"record-id-1"]
            return None

        redis_mock = MagicMock()
        redis_mock.spop.side_effect = fake_spop
        redis_mock.scard.return_value = 0
        redis_mock.expire.side_effect = lambda key, ttl: expire_calls.append(ttl)

        with patch("django_redis.get_redis_connection", return_value=redis_mock):
            with patch("apps.rag.tasks.embed_record_task") as mock_task:
                mock_task.delay.side_effect = Exception("broker down")
                _flush_record_batch.run("test-table-id")

        # 检查 expire 调用的 TTL（如果有 failed_ids 被回写）
        for ttl in expire_calls:
            self.assertEqual(
                ttl,
                300,
                f"_flush_record_batch 回写时 expire TTL 应为 300s，实际为 {ttl}s",
            )
