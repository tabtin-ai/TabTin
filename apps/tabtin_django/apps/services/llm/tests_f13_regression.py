"""
F13 回归测试 — LLM 模块 P1 修复
覆盖: SVC-12 (SoftTimeLimitExceeded 不重试，直接标记失败)

注: 使用源码结构分析避免 Celery bind=True 的 mock 签名冲突。
"""
import os

from django.test import TestCase


def _read_source() -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    full = os.path.join(base, "tasks", "llm_tasks.py")
    with open(full) as f:
        return f.read()


class SVC12TimeoutNoRetryTest(TestCase):
    """SVC-12: LLM 超时时直接返回失败结果，不触发 self.retry()"""

    def test_process_llm_request_timeout_returns_failure(self):
        """验证 process_llm_request_async 在超时时标记 TIMEOUT_NO_RETRY"""
        source = _read_source()
        self.assertIn("SoftTimeLimitExceeded", source)
        self.assertIn("TIMEOUT_NO_RETRY", source)

        lines = source.split("\n")
        in_func = False
        in_timeout_block = False
        found_no_retry_return = False
        brace_depth = 0

        for line in lines:
            if "def process_llm_request_async" in line:
                in_func = True
                continue
            if in_func and line.strip().startswith("def ") and "process_llm_request_async" not in line:
                break
            if in_func and "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
            if in_timeout_block:
                if "self.retry" in line:
                    self.fail("process_llm_request_async 的 SoftTimeLimitExceeded 块中不应有 self.retry")
                if "TIMEOUT_NO_RETRY" in line:
                    found_no_retry_return = True
                if line.strip().startswith("except ") and "SoftTimeLimitExceeded" not in line:
                    in_timeout_block = False

        self.assertTrue(found_no_retry_return, "SoftTimeLimitExceeded 块应返回 TIMEOUT_NO_RETRY")

    def test_process_vision_request_timeout_returns_failure(self):
        """验证 process_vision_request_async 在超时时标记 TIMEOUT_NO_RETRY"""
        source = _read_source()
        lines = source.split("\n")
        in_func = False
        in_timeout_block = False
        found_no_retry_return = False

        for line in lines:
            if "def process_vision_request_async" in line:
                in_func = True
                continue
            if in_func and line.strip().startswith("def ") and "process_vision_request_async" not in line:
                break
            if in_func and "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
            if in_timeout_block:
                if "self.retry" in line:
                    self.fail("process_vision_request_async 的 SoftTimeLimitExceeded 块中不应有 self.retry")
                if "TIMEOUT_NO_RETRY" in line:
                    found_no_retry_return = True
                if line.strip().startswith("except ") and "SoftTimeLimitExceeded" not in line:
                    in_timeout_block = False

        self.assertTrue(found_no_retry_return, "SoftTimeLimitExceeded 块应返回 TIMEOUT_NO_RETRY")

    def test_non_timeout_exception_still_retries(self):
        """验证非超时异常仍走 self.retry 路径（通过代码结构检查）"""
        source = _read_source()
        lines = source.split("\n")
        in_func = False
        in_timeout_block = False
        in_general_except = False
        found_general_retry = False

        for line in lines:
            if "def process_llm_request_async" in line:
                in_func = True
                continue
            if in_func and line.strip().startswith("def ") and "process_llm_request_async" not in line:
                break
            if in_func and "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
                in_general_except = False
            if in_func and "except" in line and "Exception" in line and "SoftTimeLimitExceeded" not in line:
                in_timeout_block = False
                in_general_except = True
            if in_general_except and "self.retry" in line:
                found_general_retry = True

        self.assertTrue(found_general_retry, "一般异常处理应包含 self.retry")
