"""
TC-PATCH-01 — PPTElement patch schema 通用校验

回归用例覆盖：
  1. validate_element_patch — 接受合法 patch
  2. validate_element_patch — 拒绝顶层未知字段
  3. validate_element_patch — 已知"误写"字段给出迁移提示（content / src / text / color 等）
  4. validate_element_patch — 拒绝空 dict / 非 dict
  5. validate_element_patch — props 内字段不做校验（留给前端类型系统）
  6. _ELEMENT_STRUCTURAL_KEYS 与 _PATCH_ALLOWED_TOP_KEYS 之间的不变量

设计依据：
  PPTElement 顶层字段 = 结构字段（id/type/x/y/.../link）+ props
  内容字段（content/src/fill/...）必须在 props 里
  这是平台层规则，不为某种 element type 专门写代码
"""

from __future__ import annotations

import unittest

from apps.tabslide.services.slide_service import (
    PatchValidationError,
    _ELEMENT_STRUCTURAL_KEYS,
    _PATCH_ALLOWED_TOP_KEYS,
    _PATCH_COMMON_MISTAKES,
    validate_element_patch,
)


class PatchSchemaValidationTests(unittest.TestCase):
    """validate_element_patch — 核心契约。"""

    # ── 接受合法 patch ──

    def test_accept_geometry_only_patch(self):
        """改位置/尺寸/旋转 — 只动顶层结构字段。"""
        validate_element_patch({"x": 100, "y": 200, "width": 800, "height": 450})
        validate_element_patch({"rotate": 45, "opacity": 0.8})
        validate_element_patch({"locked": True, "visible": False})

    def test_accept_props_only_patch(self):
        """改内容 — 走 props，不校验内部字段，给前端类型系统兜底。"""
        validate_element_patch({"props": {"content": "<p>hello</p>"}})
        validate_element_patch({"props": {"src": "https://x/y.png"}})
        validate_element_patch({"props": {"fill": "#FF0000", "anything": True}})

    def test_accept_mixed_geometry_and_props(self):
        """同时改位置和内容。"""
        validate_element_patch({
            "x": 100,
            "y": 200,
            "props": {"content": "<p>hi</p>"},
        })

    def test_accept_link_and_group(self):
        """超链接 / 组合字段。"""
        validate_element_patch({"link": {"type": "web", "target": "https://x"}})
        validate_element_patch({"groupId": "grp-1", "groupName": "组合"})

    def test_accept_flip_flags(self):
        """图片翻转。"""
        validate_element_patch({"flipH": True, "flipV": False})

    # ── 拒绝顶层未知字段 + 给出迁移提示 ──

    def test_reject_content_at_top_level(self):
        """文字内容必须在 props.content，**这是 Agent 最常犯的错**。"""
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({"content": "<p>x</p>"})
        err = ctx.exception.errors[0]
        self.assertEqual(err["field"], "content")
        self.assertIn("props.content", err["hint"])

    def test_reject_src_at_top_level(self):
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({"src": "https://x/y.png"})
        self.assertIn("props.src", ctx.exception.errors[0]["hint"])

    def test_reject_text_alias(self):
        """text 是 PPTist 老命名。文档/CLI Example 错误示例就是这个 key。"""
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({"text": "Hello"})
        self.assertIn("props.content", ctx.exception.errors[0]["hint"])

    def test_reject_color_at_top_level(self):
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({"color": "#FF0000"})
        self.assertIn("props.defaultColor", ctx.exception.errors[0]["hint"])

    def test_reject_font_props_at_top_level(self):
        for key, expected in [
            ("fontSize", "props.defaultFontSize"),
            ("fontFamily", "props.defaultFontFamily"),
            ("fontWeight", "props.defaultFontWeight"),
        ]:
            with self.assertRaises(PatchValidationError) as ctx:
                validate_element_patch({key: "value"})
            self.assertIn(expected, ctx.exception.errors[0]["hint"])

    def test_reject_unknown_key_without_hint(self):
        """没在 _PATCH_COMMON_MISTAKES 表里的未知字段也要拒绝，给一般性提示。"""
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({"someRandomThing": 123})
        err = ctx.exception.errors[0]
        self.assertEqual(err["field"], "someRandomThing")
        self.assertIn("unknown top-level key", err["hint"])
        self.assertIn("props", err["hint"])

    def test_reject_multiple_errors_at_once(self):
        """一次性返回所有错，避免 Agent 错→改→再错→改的多轮往返。"""
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({
                "content": "<p>x</p>",
                "color": "#FF0000",
                "unknownKey": "y",
            })
        errors = ctx.exception.errors
        self.assertEqual(len(errors), 3)
        fields = {e["field"] for e in errors}
        self.assertEqual(fields, {"content", "color", "unknownKey"})

    # ── 形式合法性 ──

    def test_reject_non_dict_patch(self):
        for bad in [None, [], "patch", 123]:
            with self.assertRaises(PatchValidationError):
                validate_element_patch(bad)

    def test_reject_empty_patch(self):
        with self.assertRaises(PatchValidationError) as ctx:
            validate_element_patch({})
        self.assertIn("empty", ctx.exception.errors[0]["hint"])

    # ── 内部不变量（防止后续维护破坏 schema）──

    def test_structural_keys_subset_of_allowed_top_keys(self):
        """结构字段必须是允许顶层 key 的子集。"""
        self.assertTrue(_ELEMENT_STRUCTURAL_KEYS.issubset(_PATCH_ALLOWED_TOP_KEYS))

    def test_allowed_top_keys_contains_props(self):
        """允许的顶层 key 必含 props。"""
        self.assertIn("props", _PATCH_ALLOWED_TOP_KEYS)

    def test_common_mistakes_never_in_allowed(self):
        """误写表里的字段不能也出现在允许列表里（否则提示和实际行为矛盾）。"""
        for mistake_key in _PATCH_COMMON_MISTAKES.keys():
            self.assertNotIn(
                mistake_key, _PATCH_ALLOWED_TOP_KEYS,
                f"`{mistake_key}` is both in _PATCH_COMMON_MISTAKES "
                f"and _PATCH_ALLOWED_TOP_KEYS — schema invariants broken",
            )

    def test_common_mistakes_targets_all_start_with_props(self):
        """所有误写提示都应指向 props.X，否则提示文本会矛盾。"""
        for key, target in _PATCH_COMMON_MISTAKES.items():
            self.assertTrue(
                target.startswith("props."),
                f"_PATCH_COMMON_MISTAKES['{key}'] = '{target}' should start with 'props.'",
            )


if __name__ == "__main__":
    unittest.main()
