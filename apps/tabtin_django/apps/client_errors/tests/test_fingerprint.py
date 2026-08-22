"""Wave 2 回归测试：``ClientErrorEvent.compute_fingerprint`` 算法。

覆盖三类核心场景，对应 Wave 2 的修复目标：

1. **全噪声 component_stack 退化**——动态 list / dangerouslySetInnerHTML 渲染场景下
   component_stack 经常**全是** ``at div (<anonymous>)``。过滤后无可分辨内容时
   必须**等价于"完全没 component_stack"**——否则同 root cause 因 cs 是否被采集
   而被分到不同 group，admindash 调试不可用。
2. **stack_trace 全空白退化**——stack_trace 字段非空但只含空白行（``\\n   \\n``）
   时也必须等价于无 stack。
3. **普通 throw 区分度**（无 cs 无 stack）——退化路径要保留 message 区分度，
   避免所有"光秃秃 throw"被合并到同一 fingerprint。

使用 ``SimpleTestCase``——本测试只调 ``compute_fingerprint`` 纯逻辑，不命中 DB。
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.client_errors.models import ClientErrorEvent


def _fp(*, error_type: str = "Error", stack_trace: str = "", component_stack: str = "", message: str = "") -> str:
    return ClientErrorEvent(
        error_type=error_type,
        stack_trace=stack_trace,
        component_stack=component_stack,
        message=message,
    ).compute_fingerprint()


class FingerprintComponentStackTest(SimpleTestCase):
    """component_stack 边界处理。"""

    def test_no_cs_equals_all_anonymous_cs(self) -> None:
        """核心退化：完全没 cs vs cs 全是 anonymous div → 必须同 fingerprint。"""
        fp_no_cs = _fp(stack_trace="at foo (file.js:1:1)")
        fp_all_anon = _fp(
            stack_trace="at foo (file.js:1:1)",
            component_stack=(
                "    at div (<anonymous>)\n"
                "    at div (<anonymous>)\n"
                "    at div (<anonymous>)"
            ),
        )
        self.assertEqual(fp_no_cs, fp_all_anon)

    def test_no_cs_equals_single_anonymous_cs(self) -> None:
        fp_no_cs = _fp(stack_trace="at foo (file.js:1:1)")
        fp_single = _fp(stack_trace="at foo (file.js:1:1)", component_stack="    at div (<anonymous>)")
        self.assertEqual(fp_no_cs, fp_single)

    def test_meaningful_cs_distinguishes_from_no_cs(self) -> None:
        fp_no_cs = _fp(stack_trace="at foo (file.js:1:1)")
        fp_real = _fp(
            stack_trace="at foo (file.js:1:1)",
            component_stack="    at MyComponent (at app.tsx:42:5)\n    at div (<anonymous>)",
        )
        self.assertNotEqual(fp_no_cs, fp_real)

    def test_different_meaningful_cs_distinguish(self) -> None:
        """两个不同根因的 React 错误（不同组件）必须有不同 fingerprint。"""
        fp_a = _fp(
            stack_trace="at foo (file.js:1:1)",
            component_stack="    at TableView (at table.tsx:10:5)\n    at div (<anonymous>)",
        )
        fp_b = _fp(
            stack_trace="at foo (file.js:1:1)",
            component_stack="    at ChartWidget (at chart.tsx:20:5)\n    at div (<anonymous>)",
        )
        self.assertNotEqual(fp_a, fp_b)


class FingerprintStackTraceTest(SimpleTestCase):
    """stack_trace 边界处理。"""

    def test_blank_stack_equals_empty_stack(self) -> None:
        fp_empty = _fp(stack_trace="", message="boom")
        fp_blank = _fp(stack_trace="   \n   \n", message="boom")
        self.assertEqual(fp_empty, fp_blank)

    def test_short_stack_does_not_degrade(self) -> None:
        """少于 5 行 stack 应正常算指纹（取所有可用行），不退化到 message。"""
        fp_one_line = _fp(stack_trace="at foo (file.js:1:1)")
        fp_one_line_diff = _fp(stack_trace="at bar (file.js:1:1)")
        self.assertNotEqual(fp_one_line, fp_one_line_diff)


class FingerprintMessageFallbackTest(SimpleTestCase):
    """普通 throw（无 cs 无 stack）退化到 message 区分度。"""

    def test_pure_throw_distinguishes_by_message(self) -> None:
        fp_a = _fp(message="Cannot read property foo of undefined")
        fp_b = _fp(message="Cannot read property bar of undefined")
        self.assertNotEqual(fp_a, fp_b)

    def test_pure_throw_same_message_same_fingerprint(self) -> None:
        fp_a = _fp(message="boom")
        fp_b = _fp(message="boom")
        self.assertEqual(fp_a, fp_b)

    def test_error_type_distinguishes_pure_throws(self) -> None:
        fp_typeerror = _fp(error_type="TypeError", message="boom")
        fp_referenceerror = _fp(error_type="ReferenceError", message="boom")
        self.assertNotEqual(fp_typeerror, fp_referenceerror)


class FingerprintCombinationTest(SimpleTestCase):
    """三个信号组合的优先级。"""

    def test_cs_dominates_when_present(self) -> None:
        """有 cs 时 fingerprint 不应只受 stack 影响——同 cs 不同 stack 仍区分。"""
        cs = "    at MyComponent (at app.tsx:42:5)"
        fp_a = _fp(stack_trace="at foo (file.js:1:1)", component_stack=cs)
        fp_b = _fp(stack_trace="at bar (file.js:1:1)", component_stack=cs)
        # 两个 stack 不同 → js_frames 不同 → 整体 fingerprint 不同
        self.assertNotEqual(fp_a, fp_b)

    def test_same_signals_same_fingerprint(self) -> None:
        a = _fp(
            error_type="TypeError",
            stack_trace="at foo (file.js:1:1)\nat bar (file.js:2:2)",
            component_stack="    at MyComponent (at app.tsx:42:5)",
            message="ignored when stack/cs present",
        )
        b = _fp(
            error_type="TypeError",
            stack_trace="at foo (file.js:1:1)\nat bar (file.js:2:2)",
            component_stack="    at MyComponent (at app.tsx:42:5)",
            message="this message is also ignored",
        )
        self.assertEqual(a, b)
