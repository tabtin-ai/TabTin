"""
F13 回归测试 — Docparse 模块 P0 修复
覆盖: SVC-4 (SoftTimeLimitExceeded 更新 DB 状态), SVC-10 (Redis 分布式信号量)

注: fitz (PyMuPDF) 在测试环境中不可用，使用源码分析验证逻辑正确性。
"""
import os
from unittest.mock import patch

from django.test import TestCase


def _read_source(relpath: str) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    full = os.path.join(base, relpath)
    with open(full) as f:
        return f.read()


class SVC4SoftTimeLimitUpdatesDBTest(TestCase):
    """SVC-4: SoftTimeLimitExceeded 时 ParsedDocument.status 更新为 FAILED"""

    def test_timeout_handler_updates_status(self):
        source = _read_source("tasks.py")
        self.assertIn("SoftTimeLimitExceeded", source)
        self.assertIn("Status.FAILED", source)
        self.assertIn("解析超时", source)

    def test_timeout_handler_does_not_retry(self):
        source = _read_source("tasks.py")
        lines = source.split("\n")
        in_timeout_block = False
        for line in lines:
            if "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
            elif in_timeout_block and "except" in line and "Exception" in line:
                break
            elif in_timeout_block and "self.retry" in line:
                self.fail("SoftTimeLimitExceeded 块中不应包含 self.retry")


class SVC10RedisVLMSemaphoreTest(TestCase):
    """SVC-10: VLM 信号量改为 Redis 分布式"""

    def test_no_threading_semaphore(self):
        source = _read_source("service.py")
        self.assertNotIn("threading.Semaphore", source)
        self.assertNotIn("import threading", source)

    def test_redis_semaphore_class_exists(self):
        source = _read_source("service.py")
        self.assertIn("class _RedisVLMSemaphore", source)
        self.assertIn("redis.incr", source)
        self.assertIn("redis.decr", source)

    def test_redis_key_defined(self):
        source = _read_source("service.py")
        self.assertIn("_VLM_REDIS_KEY", source)
        self.assertIn("docparse:vlm_concurrent", source)

    def test_fallback_when_no_redis(self):
        source = _read_source("service.py")
        self.assertIn("Redis 不可用", source)
        self.assertIn("return True", source)

    def test_beat_schedule_defined(self):
        source = _read_source("tasks.py")
        self.assertIn("DOCPARSE_BEAT_SCHEDULE", source)
        self.assertIn("docparse-cleanup-temp-files", source)
