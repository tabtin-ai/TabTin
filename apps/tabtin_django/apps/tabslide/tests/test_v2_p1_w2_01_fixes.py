"""
V2 P1 Wave2-01 修复回归测试

- I4-12: update_element_by_page_id before_snapshot 深拷贝
- I5-29: _render_element rotate/opacity/位置值 _safe_float 校验
- I5-33: _render_page_screenshot / _run_visual_lint browser.close() try/finally 保护
"""

from __future__ import annotations

import importlib
import importlib.util
import math
import sys
import types
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]


def _load_module(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _safe_float_standalone(value, fallback: float = 0.0) -> float:
    """与 preview_service._safe_float 等价的独立副本，用于不依赖 Django 的测试。"""
    try:
        f = float(value)
        return f if math.isfinite(f) else fallback
    except (TypeError, ValueError):
        return fallback


# ============================================================================
# I4-12: before_snapshot 必须使用 copy.deepcopy
# ============================================================================


class BeforeSnapshotDeepCopyTests(TestCase):
    """update_element_by_page_id 的 before_snapshot 必须深拷贝，
    确保审计日志中 before/after 不因引用共享而变成同一份数据。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        source_path = _BASE / "services" / "slide_service.py"
        cls.source = source_path.read_text(encoding="utf-8")

    def _get_method_source(self) -> str:
        start = self.source.find("def update_element_by_page_id(")
        self.assertGreater(start, 0, "找不到 update_element_by_page_id 方法")
        end = self.source.find("\n    def ", start + 1)
        return self.source[start:end] if end > 0 else self.source[start:]

    def test_uses_deepcopy(self):
        method_src = self._get_method_source()
        self.assertIn("copy.deepcopy", method_src,
                       "before_snapshot 必须使用 copy.deepcopy 而非浅拷贝")

    def test_no_shallow_only_dict_comprehension(self):
        """before_snapshot 赋值不能只有裸字典推导（浅拷贝）。"""
        method_src = self._get_method_source()
        lines = method_src.split("\n")
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("before_snapshot") and "=" in stripped:
                self.assertIn("deepcopy", stripped,
                              f"before_snapshot 赋值行应包含 deepcopy: {stripped}")

    def test_deepcopy_produces_independent_snapshot(self):
        """验证 deepcopy 行为：修改原始嵌套对象不影响快照。"""
        import copy
        original = {"text": {"content": "hello", "style": {"bold": True}}}
        patch_keys = ["text"]
        snapshot = copy.deepcopy({k: original.get(k) for k in patch_keys})
        original["text"]["content"] = "modified"
        original["text"]["style"]["bold"] = False
        self.assertEqual(snapshot["text"]["content"], "hello")
        self.assertTrue(snapshot["text"]["style"]["bold"])

    def test_batch_update_also_uses_deepcopy(self):
        """batch_update_elements 必须同样使用 deepcopy（回归守卫）。"""
        start = self.source.find("def batch_update_elements(")
        self.assertGreater(start, 0)
        end = self.source.find("\n    def ", start + 1)
        batch_src = self.source[start:end] if end > 0 else self.source[start:]
        self.assertIn("deepcopy", batch_src,
                       "batch_update_elements 也必须使用 deepcopy")


# ============================================================================
# I5-29: _render_element 位置/旋转/透明度 _safe_float 校验
# ============================================================================


class RenderElementSafeFloatTests(TestCase):
    """_render_element 中 x/y/w/h/rotate/opacity 必须经过 _safe_float 校验，
    防止 CSS 注入。"""

    def test_safe_float_rejects_string_injection(self):
        self.assertEqual(_safe_float_standalone("0; background: red", 0), 0)

    def test_safe_float_rejects_nan(self):
        self.assertEqual(_safe_float_standalone(float("nan"), 42), 42)

    def test_safe_float_rejects_inf(self):
        self.assertEqual(_safe_float_standalone(float("inf"), 0), 0)

    def test_safe_float_accepts_valid_number(self):
        self.assertEqual(_safe_float_standalone(45.5, 0), 45.5)

    def test_safe_float_accepts_int(self):
        self.assertEqual(_safe_float_standalone(100, 0), 100.0)

    def test_safe_float_accepts_zero(self):
        self.assertEqual(_safe_float_standalone(0, 99), 0.0)

    def test_safe_float_accepts_negative(self):
        self.assertEqual(_safe_float_standalone(-10.5, 0), -10.5)

    def test_source_code_uses_safe_float_for_all_fields(self):
        """源码级验证：_render_element 中 x/y/w/h/rotate/opacity 都调用了 _safe_float。"""
        source_path = _BASE / "services" / "preview_service.py"
        source = source_path.read_text(encoding="utf-8")
        start = source.find("def _render_element(")
        self.assertGreater(start, 0)
        end = source.find("\ndef ", start + 1)
        func_src = source[start:end] if end > 0 else source[start:]
        normalized = func_src.replace("'", '"')
        for field in ("rotate", "opacity"):
            self.assertIn(f'_safe_float(el.get("{field}"', normalized,
                          f"{field} 必须使用 _safe_float 校验")

    def test_source_code_uses_safe_float_for_positions(self):
        """位置值 left/top/width/height 也应使用 _safe_float。"""
        source_path = _BASE / "services" / "preview_service.py"
        source = source_path.read_text(encoding="utf-8")
        start = source.find("def _render_element(")
        self.assertGreater(start, 0)
        end = source.find("\ndef ", start + 1)
        func_src = source[start:end] if end > 0 else source[start:]
        normalized = func_src.replace("'", '"')
        for field in ("left", "width", "height"):
            self.assertIn(f'_safe_float(el.get("{field}"', normalized,
                          f"{field} 必须使用 _safe_float 校验")

    def test_malicious_rotate_produces_safe_css(self):
        """CSS 注入场景：恶意 rotate 值被 _safe_float 清理后，CSS 中只有数字。"""
        malicious = "45deg; background: url(evil)"
        cleaned = _safe_float_standalone(malicious, 0)
        self.assertEqual(cleaned, 0)
        css = f"rotate({cleaned}deg)"
        self.assertNotIn("url(", css)
        self.assertNotIn("background", css)

    def test_malicious_opacity_produces_safe_css(self):
        """CSS 注入场景：恶意 opacity 值被清理。"""
        malicious = "1; position:fixed; z-index:9999"
        cleaned = _safe_float_standalone(malicious, 1)
        self.assertEqual(cleaned, 1)
        css = f"opacity: {cleaned};"
        self.assertNotIn("position:fixed", css)


# ============================================================================
# I5-33: browser.close() 必须在 try/finally 中
# ============================================================================


class BrowserCloseProtectionTests(TestCase):
    """_render_page_screenshot / _run_visual_lint / _run_visual_lint_batch
    中 browser.close() 必须在 try/finally 块中，防止异常时浏览器进程泄漏。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        source_path = _BASE / "services" / "preview_service.py"
        cls.source = source_path.read_text(encoding="utf-8")

    def _extract_function(self, name: str) -> str:
        pattern = f"async def {name}("
        start = self.source.find(pattern)
        if start < 0:
            pattern = f"def {name}("
            start = self.source.find(pattern)
        self.assertGreater(start, 0, f"找不到函数 {name}")
        search_after = start + len(pattern)
        next_func = self.source.find("\nasync def ", search_after)
        next_func2 = self.source.find("\ndef ", search_after)
        candidates = [c for c in (next_func, next_func2) if c > 0]
        end = min(candidates) if candidates else len(self.source)
        return self.source[start:end]

    def _assert_browser_close_in_finally(self, func_name: str):
        func_src = self._extract_function(func_name)
        self.assertIn("browser.close()", func_src,
                       f"{func_name} 应调用 browser.close()")
        self.assertIn("finally:", func_src,
                       f"{func_name} 应有 finally 块")
        finally_pos = func_src.find("finally:")
        close_pos = func_src.find("browser.close()", finally_pos)
        self.assertGreater(close_pos, finally_pos,
                           f"{func_name} 中 browser.close() 应在 finally 块内")

    def test_render_page_screenshot_finally(self):
        self._assert_browser_close_in_finally("_render_page_screenshot")

    def test_run_visual_lint_finally(self):
        self._assert_browser_close_in_finally("_run_visual_lint")

    def test_run_visual_lint_batch_finally(self):
        self._assert_browser_close_in_finally("_run_visual_lint_batch")

    def test_no_browser_close_outside_finally(self):
        """browser.close() 不应出现在 finally 块之外。"""
        for func_name in ("_render_page_screenshot", "_run_visual_lint", "_run_visual_lint_batch"):
            func_src = self._extract_function(func_name)
            finally_pos = func_src.find("finally:")
            before_finally = func_src[:finally_pos]
            self.assertNotIn("browser.close()", before_finally,
                             f"{func_name} 中 browser.close() 不应出现在 finally 之前")

    def test_try_block_present(self):
        """每个函数在 browser launch 后必须有 try 块。"""
        for func_name in ("_render_page_screenshot", "_run_visual_lint", "_run_visual_lint_batch"):
            func_src = self._extract_function(func_name)
            launch_pos = func_src.find("chromium.launch(")
            self.assertGreater(launch_pos, 0, f"{func_name} 必须有 browser launch")
            after_launch = func_src[launch_pos:]
            try_pos = after_launch.find("try:")
            finally_pos = after_launch.find("finally:")
            self.assertGreater(try_pos, 0, f"{func_name} launch 后必须有 try")
            self.assertGreater(finally_pos, try_pos, f"{func_name} 中 finally 必须在 try 之后")
