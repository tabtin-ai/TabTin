"""Phase-3 Wave-4 type-aware 校验测试

防止"image 元素被强加 props.content"这类数据污染。
"""

from __future__ import annotations

import pytest

from apps.tabslide.services.slide_service import (
    PatchValidationError,
    validate_props_for_element_type,
)


# ─── image 元素：拒绝文字/形状/线条特有字段 ─────────────────────────────


def test_image_rejects_content():
    """子 Agent 实测发现的污染场景：image 元素被强加 props.content。"""
    with pytest.raises(PatchValidationError) as exc_info:
        validate_props_for_element_type("image", {"props": {"content": "<p>x</p>"}})
    err = exc_info.value.errors[0]
    assert err["field"] == "props.content"
    assert "type='image'" in err["hint"]


def test_image_rejects_text_styling():
    """文字相关样式不能写到 image 元素。"""
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("image", {"props": {"defaultFontSize": 24}})


def test_image_rejects_shape_geometry():
    """shape 特有的 path / viewBox 不能写到 image。"""
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("image", {"props": {"path": "M 0 0 L 100 100"}})


def test_image_accepts_legal_props():
    """image 合法字段（src / filters / clip / radius 等）应当通过。"""
    validate_props_for_element_type("image", {"props": {"src": "https://x/y.png"}})
    validate_props_for_element_type("image", {"props": {"radius": 8}})
    validate_props_for_element_type("image", {"props": {"objectFit": "cover"}})
    validate_props_for_element_type("image", {"props": {"colorMask": "rgba(0,0,0,0.3)"}})
    # 通用视觉字段：outline / shadow 也应通过
    validate_props_for_element_type("image", {"props": {"outline": {"width": 2}}})


# ─── text 元素：拒绝 image/shape/line 特有 ───────────────────────────


def test_text_rejects_src():
    """text 元素不应有 src 字段（那是 image 的）。"""
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("text", {"props": {"src": "https://x/y.png"}})


def test_text_rejects_path():
    """text 元素不应有 path / viewBox（shape 字段）。"""
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("text", {"props": {"viewBox": [100, 50]}})


def test_text_accepts_content_and_font():
    validate_props_for_element_type("text", {"props": {"content": "<p>x</p>"}})
    validate_props_for_element_type("text", {
        "props": {"defaultFontSize": 18, "defaultColor": "#fff"}
    })
    # text 也可以有 outline / shadow / fill（文字框背景）
    validate_props_for_element_type("text", {"props": {"fill": "#000"}})


# ─── shape 元素：拒绝 text 容器特有 ─────────────────────────────────


def test_shape_rejects_content_top_level():
    """shape 的文字在 props.text.content，不在 props.content。"""
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("shape", {"props": {"content": "<p>x</p>"}})


def test_shape_rejects_src():
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("shape", {"props": {"src": "https://x/y.png"}})


def test_shape_accepts_geometry_and_fill():
    validate_props_for_element_type("shape", {"props": {"fill": "#FF0000"}})
    validate_props_for_element_type("shape", {"props": {"path": "M 0 0"}})
    validate_props_for_element_type("shape", {"props": {"gradient": {"colors": []}}})
    validate_props_for_element_type("shape", {
        "props": {"text": {"content": "Title", "defaultColor": "#fff"}}
    })  # shape 内的文字嵌套在 props.text


# ─── 多字段同时违规：所有错误一次返回 ──────────────────────────────


def test_image_multiple_violations_aggregated():
    """patch 含多个非法字段时，错误列表全列出来给 Agent 一次性看明白。"""
    with pytest.raises(PatchValidationError) as exc_info:
        validate_props_for_element_type("image", {
            "props": {"content": "x", "defaultFontSize": 24, "path": "M 0 0"}
        })
    fields = {e["field"] for e in exc_info.value.errors}
    assert fields == {"props.content", "props.defaultFontSize", "props.path"}


# ─── 边界情况：空 patch / 未知 type / 没 props ──────────────────────


def test_empty_patch_no_error():
    validate_props_for_element_type("image", {})


def test_patch_without_props_no_error():
    """只改顶层结构字段（如 x/y/width）不需要 type 校验。"""
    validate_props_for_element_type("image", {"x": 100, "y": 200})


def test_unknown_type_skips_check():
    """未知的 element type 跳过（向前兼容未来新类型）。"""
    validate_props_for_element_type("future_type", {"props": {"anything": 1}})


def test_props_not_dict_skipped():
    """props 不是 dict（异常 patch）也不应崩，留给 _deep_merge 处理。"""
    validate_props_for_element_type("image", {"props": "not-a-dict"})


# ─── line / chart / table / latex 简单覆盖 ──────────────────────────


def test_line_rejects_image_fields():
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("line", {"props": {"src": "x"}})


def test_chart_rejects_path():
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("chart", {"props": {"path": "M 0 0"}})


def test_table_rejects_content():
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("table", {"props": {"content": "x"}})


def test_latex_rejects_src():
    with pytest.raises(PatchValidationError):
        validate_props_for_element_type("latex", {"props": {"src": "x"}})


def test_latex_accepts_latex_field():
    validate_props_for_element_type("latex", {"props": {"latex": "x^2 + y^2 = z^2"}})


# ─── 错误消息友好性 ────────────────────────────────────────────────


def test_error_hint_includes_type_name():
    with pytest.raises(PatchValidationError) as exc_info:
        validate_props_for_element_type("image", {"props": {"content": "x"}})
    hint = exc_info.value.errors[0]["hint"]
    # 应该明确告诉 Agent 这字段属于哪个 type，让它能定位错在哪
    assert "image" in hint or "text" in hint
