"""structural_lint 测试：纯 JSON 检查，覆盖每条规则的命中与豁免。"""

from __future__ import annotations

from apps.tabslide.services.structural_lint import check_structural_issues


def _by_type(problems: list[dict], type_name: str) -> list[dict]:
    return [p for p in problems if p.get("type") == type_name]


# ─── R1 element_missing_id ───────────────────────────────────────────


def test_element_missing_id_is_error():
    pages = [{
        "id": "page-1",
        "elements": [
            {"type": "text", "x": 0, "y": 0, "width": 100, "height": 30,
             "props": {"content": "<p>x</p>"}},  # no id
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "element_missing_id")
    assert len(problems) == 1
    assert problems[0]["severity"] == "error"
    assert problems[0]["page_id"] == "page-1"


def test_element_with_id_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "x": 0, "y": 0, "width": 100, "height": 30,
             "props": {"content": "<p>x</p>"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "element_missing_id")
    assert problems == []


# ─── R2 flat_content_field ───────────────────────────────────────────


def test_flat_fill_is_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 0, "y": 0, "width": 100, "height": 30,
             "fill": "#FF0000"},  # 应该在 props 下
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "flat_content_field")
    assert len(problems) == 1
    assert problems[0]["severity"] == "warning"
    assert "fill" in problems[0]["message"]


def test_flat_multiple_fields():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "x": 0, "y": 0, "width": 100, "height": 30,
             "content": "<p>x</p>", "fontSize": 20, "color": "#fff"},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "flat_content_field")
    assert len(problems) == 1
    msg = problems[0]["message"]
    assert "content" in msg and "fontSize" in msg and "color" in msg


def test_proper_props_wrapped_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 0, "y": 0, "width": 100, "height": 30,
             "props": {"fill": "#FF0000"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "flat_content_field")
    assert problems == []


# ─── R3 shape_no_visual ──────────────────────────────────────────────


def test_shape_no_fill_no_gradient_no_outline():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 0, "y": 0, "width": 100, "height": 30,
             "props": {"path": "M 0 0 L 100 0", "viewBox": [100, 30]}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "shape_no_visual")
    assert len(problems) == 1


def test_shape_with_fill_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 0, "y": 0, "width": 100, "height": 30,
             "props": {"fill": "#FF0000", "path": "M 0 0"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "shape_no_visual")
    assert problems == []


def test_shape_with_gradient_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "width": 100, "height": 30,
             "props": {"gradient": {"colors": [{"color": "#FF0000"}]}}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "shape_no_visual")
    assert problems == []


def test_shape_with_outline_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "width": 100, "height": 30,
             "props": {"outline": {"width": 2, "color": "#000"}}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "shape_no_visual")
    assert problems == []


# ─── R4 text_empty_content / text_missing_content / text_overlong ────


def test_text_empty_content():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "   "}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "text_empty_content")
    assert len(problems) == 1


def test_text_missing_content():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30, "props": {}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "text_missing_content")
    assert len(problems) == 1


def test_text_overlong():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "x" * 2500}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "text_overlong")
    assert len(problems) == 1


# ─── R5 image_invalid_src ────────────────────────────────────────────


def test_image_empty_src():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "width": 100, "height": 30, "props": {}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "image_invalid_src")
    assert len(problems) == 1


def test_image_data_image_uri_valid():
    # ：data:image/* 是 inline_images 渲染链路的正常产物，不再告警
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "width": 100, "height": 30,
             "props": {"src": "data:image/png;base64,AAA="}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "image_invalid_src")
    assert problems == []


def test_image_data_non_image_uri_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "width": 100, "height": 30,
             "props": {"src": "data:text/html,<script>x</script>"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "image_invalid_src")
    assert len(problems) == 1


def test_image_valid_https_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "width": 100, "height": 30,
             "props": {"src": "https://oss.example.com/x.png"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "image_invalid_src")
    assert problems == []


# ─── R10 out_of_canvas──────────────────────────────────────


def test_out_of_canvas_bottom_overflow():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 80, "y": 588, "width": 548, "height": 218,
             "props": {"fill": "#fff"}},  # 588+218=806 > 720
        ],
    }]
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "out_of_canvas",
    )
    assert len(problems) == 1
    assert problems[0]["severity"] == "warning"
    assert "下越界" in problems[0]["message"]


def test_out_of_canvas_within_tolerance_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "x": 0, "y": 0, "width": 1281, "height": 720,
             "props": {"content": "<p>x</p>"}},  # 越界 1px 在容差内
        ],
    }]
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "out_of_canvas",
    )
    assert problems == []


def test_in_canvas_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "shape", "x": 80, "y": 272, "width": 262, "height": 256,
             "props": {"fill": "#fff"}},
        ],
    }]
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "out_of_canvas",
    )
    assert problems == []


# ─── R11 sparse_page_bottom（ 视觉质量）───────────────────────


def _card(i, y, h=100):
    return {"id": f"c{i}", "type": "shape", "x": 80 + i * 300, "y": y,
            "width": 260, "height": h, "props": {"fill": "#fff"}}


def test_sparse_page_bottom_warning():
    # 4 个元素全挤在上半页（max y+h = 390 / 720 = 54%）
    pages = [{
        "id": "page-1",
        "elements": [_card(0, 100), _card(1, 100), _card(2, 290), _card(3, 290)],
    }]
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "sparse_page_bottom",
    )
    assert len(problems) == 1
    assert problems[0]["severity"] == "warning"


def test_full_height_page_no_sparse_warning():
    pages = [{
        "id": "page-1",
        "elements": [_card(0, 100), _card(1, 100), _card(2, 420, 200), _card(3, 420, 200)],
    }]  # max y+h = 620 / 720 = 86%
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "sparse_page_bottom",
    )
    assert problems == []


def test_few_elements_page_skips_sparse_check():
    # 封面类少元素页不检查
    pages = [{
        "id": "page-1",
        "elements": [_card(0, 200), _card(1, 200)],
    }]
    problems = _by_type(
        check_structural_issues(pages, canvas_w=1280, canvas_h=720), "sparse_page_bottom",
    )
    assert problems == []


# ─── R6 negative_dimensions ──────────────────────────────────────────


def test_negative_dimensions():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "x": 0, "y": 0, "width": -10, "height": 30,
             "props": {"content": "<p>x</p>"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "negative_dimensions")
    assert len(problems) == 1
    assert problems[0]["severity"] == "error"


# ─── R7 media_dominates_page ─────────────────────────────────────────


def test_media_dominates_page():
    """单页 image 元素总面积 > 70% canvas → 触发 info"""
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "x": 0, "y": 0, "width": 1500, "height": 800,
             "props": {"src": "https://x/y.png"}},
        ],
    }]
    # canvas 1920x1080 → 总面积 2,073,600；image 1500x800 = 1,200,000 占 57.8%
    # 调到 1700x900 = 1,530,000 占 73.8% → 触发
    pages[0]["elements"][0]["width"] = 1700
    pages[0]["elements"][0]["height"] = 900
    problems = _by_type(check_structural_issues(pages), "media_dominates_page")
    assert len(problems) == 1


def test_media_not_dominant():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "image", "x": 0, "y": 0, "width": 500, "height": 300,
             "props": {"src": "https://x/y.png"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "media_dominates_page")
    assert problems == []


# ─── R8 duplicate_element_id ─────────────────────────────────────────


def test_duplicate_id_across_pages():
    pages = [
        {"id": "page-1", "elements": [
            {"id": "shared-1", "type": "text", "width": 10, "height": 10,
             "props": {"content": "a"}},
        ]},
        {"id": "page-2", "elements": [
            {"id": "shared-1", "type": "text", "width": 10, "height": 10,
             "props": {"content": "b"}},
        ]},
    ]
    problems = _by_type(check_structural_issues(pages), "duplicate_element_id")
    assert len(problems) == 1
    assert problems[0]["severity"] == "error"
    assert "shared-1" in problems[0]["element_id"]


def test_duplicate_id_within_page():
    pages = [
        {"id": "page-1", "elements": [
            {"id": "dup", "type": "text", "width": 10, "height": 10,
             "props": {"content": "a"}},
            {"id": "dup", "type": "text", "width": 10, "height": 10,
             "props": {"content": "b"}},
        ]},
    ]
    problems = _by_type(check_structural_issues(pages), "duplicate_element_id")
    assert len(problems) == 1


def test_unique_ids_no_warning():
    pages = [
        {"id": "page-1", "elements": [
            {"id": "e1", "type": "text", "width": 10, "height": 10,
             "props": {"content": "a"}},
            {"id": "e2", "type": "text", "width": 10, "height": 10,
             "props": {"content": "b"}},
        ]},
    ]
    problems = _by_type(check_structural_issues(pages), "duplicate_element_id")
    assert problems == []


# ─── R9 unregistered_font ────────────────────────────────────────────


def test_registered_font_no_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "<p>x</p>", "defaultFontName": "MiSans"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "unregistered_font")
    assert problems == []


def test_system_font_no_warning():
    """系统字体（_FONT_ALIASES 里 value=None）也不应该警告"""
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "<p>x</p>", "defaultFontName": "Arial"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "unregistered_font")
    assert problems == []


def test_unregistered_font_warning():
    pages = [{
        "id": "page-1",
        "elements": [
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "<p>x</p>", "defaultFontName": "BizarreFont"}},
        ],
    }]
    problems = _by_type(check_structural_issues(pages), "unregistered_font")
    assert len(problems) == 1
    assert "BizarreFont" in problems[0]["message"]


# ─── 综合测试：多规则同时触发 ────────────────────────────────────────


def test_combined_violations():
    pages = [{
        "id": "page-1",
        "elements": [
            # 无 id + 顶层 fill + shape 无视觉
            {"type": "shape", "x": 0, "y": 0, "width": 100, "height": 30,
             "fill": "#FF0000"},
            # 重复 id（跟下面 e1 冲突）
            {"id": "e1", "type": "text", "width": 100, "height": 30,
             "props": {"content": "<p>x</p>"}},
            {"id": "e1", "type": "image", "width": 100, "height": 30, "props": {}},
        ],
    }]
    problems = check_structural_issues(pages)
    types = {p["type"] for p in problems}
    assert "element_missing_id" in types
    assert "flat_content_field" in types
    assert "duplicate_element_id" in types
    assert "image_invalid_src" in types


def test_empty_pages():
    assert check_structural_issues([]) == []
    assert check_structural_issues([{"id": "p1", "elements": []}]) == []


def test_non_dict_pages_skipped():
    pages = [None, "weird", {"id": "p1", "elements": [
        {"id": "e1", "type": "text", "props": {"content": "x"}}
    ]}]
    problems = check_structural_issues(pages)
    # 不应报错；非 dict 页跳过
    assert all(p.get("page_id") == "p1" for p in problems)


# ─── error 类问题应优先 ────────────────────────────────────────


def test_severity_classification():
    pages = [{
        "id": "page-1",
        "elements": [
            # error: missing id
            {"type": "text", "width": 10, "height": 10, "props": {"content": "x"}},
            # warning: flat field
            {"id": "e2", "type": "shape", "width": 10, "height": 10, "fill": "#FF0000"},
            # info: empty content
            {"id": "e3", "type": "text", "width": 10, "height": 10,
             "props": {"content": "   "}},
        ],
    }]
    problems = check_structural_issues(pages)
    severities = {p["type"]: p["severity"] for p in problems}
    assert severities["element_missing_id"] == "error"
    assert severities["flat_content_field"] == "warning"
    assert severities["text_empty_content"] == "info"
