"""
F10 回归测试 — DP-008 / DP-010 修复验证
- DP-008: PptxParser 不再注册 application/vnd.ms-powerpoint MIME
- DP-010: VisionParser 超时保护不再被 shutdown(wait=True) 阻塞
"""
import concurrent.futures
import os
import sys
import threading
import time
from unittest.mock import MagicMock, patch

import pytest


def _read_source(relpath: str) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    full = os.path.join(base, relpath)
    with open(full) as f:
        return f.read()


# ======================================================================
# DP-008: PptxParser MIME 注册一致性
# ======================================================================


class TestDP008PptxMimeConsistency:
    """PptxParser 只注册 .pptx MIME，不注册 .ppt MIME。"""

    def test_supported_mimes_excludes_ppt(self):
        """supported_mimes 不包含旧版 .ppt 的 MIME 类型。"""
        from apps.services.docparse.parsers.pptx_parser import PptxParser

        parser = PptxParser()
        mimes = parser.supported_mimes()
        assert "application/vnd.ms-powerpoint" not in mimes

    def test_supported_mimes_includes_pptx(self):
        """supported_mimes 包含 .pptx 的 MIME 类型。"""
        from apps.services.docparse.parsers.pptx_parser import PptxParser

        parser = PptxParser()
        mimes = parser.supported_mimes()
        assert "application/vnd.openxmlformats-officedocument.presentationml.presentation" in mimes

    def test_registry_no_ppt_mime(self):
        """注册表中不存在 application/vnd.ms-powerpoint 到 PptxParser 的映射。"""
        from apps.services.docparse.parsers.registry import get_parser_for_mime

        result = get_parser_for_mime("application/vnd.ms-powerpoint")
        assert result is None, (
            f"application/vnd.ms-powerpoint 不应注册任何解析器，但得到 {result}"
        )

    def test_registry_pptx_mime_resolves(self):
        """注册表中 .pptx MIME 正确映射到 PptxParser。"""
        from apps.services.docparse.parsers.pptx_parser import PptxParser
        from apps.services.docparse.parsers.registry import get_parser_for_mime

        result = get_parser_for_mime(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
        assert result is PptxParser

    def test_ppt_extension_still_raises(self):
        """即使通过其他途径传入 .ppt 文件，parse() 仍给出明确错误。"""
        from apps.services.docparse.parsers.pptx_parser import PptxParser

        parser = PptxParser()
        with pytest.raises(ValueError, match="不支持旧版 .ppt 格式"):
            parser.parse("/tmp/test.ppt")

    def test_source_no_vnd_ms_powerpoint(self):
        """源码级验证：supported_mimes 不含 vnd.ms-powerpoint 字符串。"""
        source = _read_source("parsers/pptx_parser.py")
        lines = source.split("\n")
        in_supported_mimes = False
        for line in lines:
            if "def supported_mimes" in line:
                in_supported_mimes = True
            elif in_supported_mimes and "def " in line:
                break
            elif in_supported_mimes and "vnd.ms-powerpoint" in line:
                pytest.fail(
                    "supported_mimes() 方法中不应包含 vnd.ms-powerpoint"
                )


# ======================================================================
# DP-010: VisionParser 超时保护有效性
# ======================================================================


class TestDP010VisionTimeoutEffective:
    """VisionParser 超时保护不被 shutdown(wait=True) 阻塞。"""

    def test_source_no_shutdown_wait_true(self):
        """源码级验证：不使用 shutdown(wait=True) 或 with 上下文管理器。"""
        source = _read_source("parsers/vision_parser.py")
        assert "shutdown(wait=True)" not in source, (
            "不应使用 shutdown(wait=True)，会阻塞超时逻辑"
        )

    def test_source_no_context_manager_threadpool(self):
        """源码级验证：不使用 with ThreadPoolExecutor 上下文管理器。"""
        source = _read_source("parsers/vision_parser.py")
        assert "with concurrent.futures.ThreadPoolExecutor" not in source, (
            "不应使用 with ThreadPoolExecutor 上下文管理器"
        )

    def test_source_uses_shutdown_wait_false(self):
        """源码级验证：使用 shutdown(wait=False) 非阻塞关闭。"""
        source = _read_source("parsers/vision_parser.py")
        assert "shutdown(wait=False" in source

    def test_source_uses_cancel_futures(self):
        """源码级验证：超时路径使用 cancel_futures=True。"""
        source = _read_source("parsers/vision_parser.py")
        assert "cancel_futures=True" in source

    def test_timeout_raises_without_blocking(self):
        """
        功能验证：超时后在合理时间内返回 TimeoutError，不被 shutdown 阻塞。

        通过 sys.modules 注入 mock 绕过 Django 依赖，直接测试 _call_api 的
        ThreadPoolExecutor 超时路径。
        """
        block_duration = 30
        timeout_override = 0.3

        mock_sem = MagicMock()
        mock_sem.acquire.return_value = True

        def slow_chat(**kwargs):
            time.sleep(block_duration)
            return {"choices": [{"message": {"content": "{}"}}]}

        mock_service = MagicMock()
        mock_service.chat = slow_chat

        mock_docparse_service = MagicMock()
        mock_docparse_service.get_vlm_semaphore.return_value = mock_sem

        mock_factory = MagicMock()
        mock_factory.get_llm_service_for_scene.return_value = mock_service

        saved_modules = {}
        inject_keys = [
            "apps.services.docparse.service",
            "apps.services.docparse.models",
            "apps.services.llm.services.factory",
            "apps.services.llm.services.billed_call",
            "apps.services.llm.services.billing",
        ]
        for key in inject_keys:
            saved_modules[key] = sys.modules.get(key)

        try:
            sys.modules["apps.services.docparse.service"] = mock_docparse_service
            sys.modules["apps.services.docparse.models"] = MagicMock()
            sys.modules["apps.services.llm.services.factory"] = mock_factory
            sys.modules["apps.services.llm.services.billed_call"] = MagicMock()
            sys.modules["apps.services.llm.services.billing"] = MagicMock()

            from apps.services.docparse.parsers.vision_parser import VisionParser

            parser = VisionParser(model="test-model", user_id="u1", organization_id="w1")

            with patch.object(
                type(parser).mro()[0].__module__
                and sys.modules["apps.services.docparse.parsers.vision_parser"],
                "_VLM_CALL_TIMEOUT",
                timeout_override,
            ):
                start = time.monotonic()
                with pytest.raises(TimeoutError, match="VLM API 单次调用超时"):
                    parser._call_api("test-model", "AAAA")
                elapsed = time.monotonic() - start

            max_allowed = timeout_override + 2.0
            assert elapsed < max_allowed, (
                f"超时后应立即返回，但耗时 {elapsed:.1f}s（允许上限 {max_allowed:.1f}s），"
                f"说明 shutdown 仍在阻塞"
            )
        finally:
            for key in inject_keys:
                if saved_modules[key] is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = saved_modules[key]

    def test_timeout_pattern_behavioral(self):
        """
        行为验证：用与生产代码完全相同的 ThreadPoolExecutor 模式验证
        shutdown(wait=False) 不会阻塞。
        """
        block_duration = 30
        test_timeout = 0.2

        def blocking_fn():
            time.sleep(block_duration)
            return "done"

        start = time.monotonic()
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = pool.submit(blocking_fn)
        try:
            future.result(timeout=test_timeout)
            pytest.fail("应该抛出 TimeoutError")
        except concurrent.futures.TimeoutError:
            future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
        elapsed = time.monotonic() - start

        max_allowed = test_timeout + 1.0
        assert elapsed < max_allowed, (
            f"shutdown(wait=False) 应立即返回，但耗时 {elapsed:.1f}s"
        )

    def test_context_manager_would_block(self):
        """
        对比验证：with 上下文管理器（旧代码模式）会因 shutdown(wait=True) 阻塞。
        此测试证明旧代码确实存在问题。
        """
        block_duration = 3
        test_timeout = 0.2

        def blocking_fn():
            time.sleep(block_duration)
            return "done"

        start = time.monotonic()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(blocking_fn)
                try:
                    future.result(timeout=test_timeout)
                except concurrent.futures.TimeoutError:
                    raise TimeoutError("timeout")
        except TimeoutError:
            pass
        elapsed = time.monotonic() - start

        assert elapsed >= block_duration * 0.8, (
            f"with 上下文管理器应阻塞等待线程完成（约 {block_duration}s），"
            f"但仅用了 {elapsed:.1f}s — 测试前提不成立"
        )

    def test_normal_call_pool_shutdown_called(self):
        """正常调用完成后线程池也被 shutdown(wait=False)。"""
        mock_service = MagicMock()
        mock_service.chat.return_value = {
            "choices": [{"message": {"content": '{"blocks": []}'}}],
            "usage": {},
        }

        mock_sem = MagicMock()
        mock_sem.acquire.return_value = True

        mock_docparse_service = MagicMock()
        mock_docparse_service.get_vlm_semaphore.return_value = mock_sem

        mock_factory = MagicMock()
        mock_factory.get_llm_service_for_scene.return_value = mock_service

        saved_modules = {}
        inject_keys = [
            "apps.services.docparse.service",
            "apps.services.docparse.models",
            "apps.services.llm.services.factory",
            "apps.services.llm.services.billed_call",
            "apps.services.llm.services.billing",
        ]
        for key in inject_keys:
            saved_modules[key] = sys.modules.get(key)

        try:
            sys.modules["apps.services.docparse.service"] = mock_docparse_service
            sys.modules["apps.services.docparse.models"] = MagicMock()
            sys.modules["apps.services.llm.services.factory"] = mock_factory
            sys.modules["apps.services.llm.services.billed_call"] = MagicMock()
            sys.modules["apps.services.llm.services.billing"] = MagicMock()

            from apps.services.docparse.parsers.vision_parser import VisionParser

            parser = VisionParser(model="test-model", user_id="u1", organization_id="w1")

            mock_pool_instance = MagicMock()
            mock_future = MagicMock()
            mock_future.result.return_value = mock_service.chat.return_value
            mock_pool_instance.submit.return_value = mock_future

            with patch(
                "concurrent.futures.ThreadPoolExecutor",
                return_value=mock_pool_instance,
            ):
                parser._call_api("test-model", "AAAA")
                mock_pool_instance.shutdown.assert_called_once_with(wait=False)
        finally:
            for key in inject_keys:
                if saved_modules[key] is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = saved_modules[key]
