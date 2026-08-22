"""grep_service 测试：纯 dict 输入，验证全文搜索的各种边界。

不依赖数据库，直接模拟 _read_pages_from_slide_pages 输出的格式：
  pages = [{"page_id": ..., "elements_data": [...], "order": ...}, ...]
"""

from __future__ import annotations

from apps.tabslide.services.grep_service import (
    DEFAULT_ELEMENT_TYPES,
    _build_excerpt,
    _extract_element_text,
    _strip_html,
    grep_pages,
)


# ─── Helpers ─────────────────────────────────────────────────


def _text_el(eid: str, content: str) -> dict:
    """构造 text 元素（content 是 HTML 字符串，与真实数据一致）"""
    return {
        "id": eid,
        "type": "text",
        "props": {"content": content},
    }


def _shape_el(eid: str, text: str) -> dict:
    """构造带文字的 shape 元素（text 是 props.text.content 嵌套结构）"""
    return {
        "id": eid,
        "type": "shape",
        "props": {
            "fill": "#FFFFFF",
            "text": {"content": text, "defaultColor": "#000"},
        },
    }


def _page(page_id: str, elements: list[dict], *, order: float = 0) -> dict:
    return {"page_id": page_id, "elements_data": elements, "order": order}


# ─── 1. 基本搜索 ──────────────────────────────────────────────


def test_basic_substring_match():
    pages = [
        _page("p1", [
            _text_el("e1", "<p>Hello Lumio world</p>"),
            _text_el("e2", "<p>nothing here</p>"),
        ]),
    ]
    result = grep_pages(pages, "Lumio")
    assert result["total_matches"] == 1
    m = result["matches"][0]
    assert m["page_id"] == "p1"
    assert m["page_index"] == 0
    assert m["element_id"] == "e1"
    assert m["element_type"] == "text"
    assert "Lumio" in m["content_excerpt"]


# ─── 2. 大小写不敏感 ──────────────────────────────────────────


def test_case_insensitive_match():
    pages = [
        _page("p1", [
            _text_el("e1", "<p>LUMIO is cool</p>"),
            _text_el("e2", "<p>lumio rocks</p>"),
            _text_el("e3", "<p>LuMiO mixed</p>"),
        ]),
    ]
    result = grep_pages(pages, "lumio")
    assert result["total_matches"] == 3
    ids = sorted(m["element_id"] for m in result["matches"])
    assert ids == ["e1", "e2", "e3"]


def test_case_insensitive_query_with_uppercase():
    """query 是大写时也应该匹配小写内容"""
    pages = [_page("p1", [_text_el("e1", "<p>hello world</p>")])]
    result = grep_pages(pages, "HELLO")
    assert result["total_matches"] == 1


# ─── 3. page_id 过滤 ─────────────────────────────────────────


def test_page_id_filter_via_caller():
    """grep_pages 自身不做 page_id 过滤（由调用方在 queryset 上过滤），
    但当只传单页时，page_index 应该按调用方传入的顺序从 0 计数。"""
    # 模拟"已经在 queryset 阶段过滤掉其他页"，只剩 page-3
    pages = [_page("page-3", [_text_el("e1", "<p>Primary text</p>")])]
    result = grep_pages(pages, "Primary")
    assert result["total_matches"] == 1
    m = result["matches"][0]
    assert m["page_id"] == "page-3"
    assert m["page_index"] == 0  # 调用方过滤后该页是第 0 个


# ─── 4. element_types 过滤 ───────────────────────────────────


def test_element_types_filter_excludes_shape():
    pages = [
        _page("p1", [
            _text_el("e1", "<p>Lumio in text</p>"),
            _shape_el("e2", "Lumio in shape"),
        ]),
    ]
    result = grep_pages(pages, "Lumio", element_types=["text"])
    assert result["total_matches"] == 1
    assert result["matches"][0]["element_id"] == "e1"


def test_element_types_filter_excludes_text():
    pages = [
        _page("p1", [
            _text_el("e1", "<p>Lumio in text</p>"),
            _shape_el("e2", "Lumio in shape"),
        ]),
    ]
    result = grep_pages(pages, "Lumio", element_types=["shape"])
    assert result["total_matches"] == 1
    assert result["matches"][0]["element_id"] == "e2"
    assert result["matches"][0]["element_type"] == "shape"


def test_default_element_types_covers_text_and_shape():
    """未传 element_types 时默认搜 text + shape"""
    pages = [
        _page("p1", [
            _text_el("e1", "<p>foo</p>"),
            _shape_el("e2", "foo bar"),
            # image 类型有 src，但默认 element_types 不会搜它
            {"id": "e3", "type": "image", "props": {"src": "https://x.com/foo.png"}},
        ]),
    ]
    result = grep_pages(pages, "foo")
    assert result["total_matches"] == 2
    types = {m["element_type"] for m in result["matches"]}
    assert types == set(DEFAULT_ELEMENT_TYPES)


# ─── 5. max_results 截断 ─────────────────────────────────────


def test_max_results_caps_output():
    pages = [
        _page(f"p{i}", [_text_el(f"e{i}", "<p>Lumio</p>")])
        for i in range(10)
    ]
    result = grep_pages(pages, "Lumio", max_results=3)
    assert len(result["matches"]) == 3
    assert result["total_matches"] == 3
    # 应该返回前 3 页的匹配，按 page_index 升序
    indices = [m["page_index"] for m in result["matches"]]
    assert indices == [0, 1, 2]


def test_max_results_no_truncation_when_below_limit():
    pages = [_page("p1", [_text_el("e1", "<p>Lumio</p>")])]
    result = grep_pages(pages, "Lumio", max_results=100)
    assert result["total_matches"] == 1
    assert len(result["matches"]) == 1


# ─── 6. HTML 标签剥离 ────────────────────────────────────────


def test_html_tags_stripped_for_matching():
    """搜 'Hello' 应该匹配 '<p>Hello</p>'，标签不应干扰"""
    pages = [_page("p1", [_text_el("e1", '<p><span style="color:red">Hello</span> world</p>')])]
    result = grep_pages(pages, "Hello")
    assert result["total_matches"] == 1


def test_html_tags_dont_match_themselves():
    """搜 'span' 不应匹配 HTML 标签本身（标签已被剥离）"""
    pages = [_page("p1", [_text_el("e1", '<p><span>Hi</span></p>')])]
    result = grep_pages(pages, "span")
    assert result["total_matches"] == 0


def test_html_excerpt_uses_plain_text():
    """content_excerpt 应该是剥离 HTML 后的纯文本"""
    pages = [_page("p1", [_text_el("e1",
        '<p><span style="color:#FFF;font-size:48pt">关键词在这里</span></p>')])]
    result = grep_pages(pages, "关键词")
    assert result["total_matches"] == 1
    excerpt = result["matches"][0]["content_excerpt"]
    assert "<span" not in excerpt
    assert "style" not in excerpt
    assert "关键词在这里" in excerpt


def test_strip_html_helper():
    assert _strip_html("<p>hi</p>") == "hi"
    assert _strip_html('<p style="color:red">x</p>') == "x"
    assert _strip_html("") == ""
    assert _strip_html("no tags") == "no tags"


# ─── 7. 多页匹配 ─────────────────────────────────────────────


def test_multiple_pages_match():
    pages = [
        _page("p1", [_text_el("e1", "<p>Lumio appears here</p>")]),
        _page("p2", [_text_el("e2", "<p>not here</p>")]),
        _page("p3", [
            _text_el("e3", "<p>Lumio again</p>"),
            _shape_el("e4", "Lumio in shape on p3"),
        ]),
    ]
    result = grep_pages(pages, "Lumio")
    assert result["total_matches"] == 3
    # 顺序按 page_index 升序、每页内按元素出现顺序
    actual = [(m["page_id"], m["page_index"]) for m in result["matches"]]
    assert actual == [("p1", 0), ("p3", 2), ("p3", 2)]


def test_page_index_reflects_order_in_input():
    """page_index 是输入 pages 列表的 0-based 顺序"""
    pages = [
        _page("zzz-last", [_text_el("e1", "<p>foo</p>")], order=0.0),
        _page("aaa-first", [_text_el("e2", "<p>foo</p>")], order=1.0),
    ]
    # 调用方按 order 排序后传入，service 不再重排
    result = grep_pages(pages, "foo")
    assert result["matches"][0]["page_index"] == 0
    assert result["matches"][0]["page_id"] == "zzz-last"
    assert result["matches"][1]["page_index"] == 1
    assert result["matches"][1]["page_id"] == "aaa-first"


# ─── 8. 无匹配 ───────────────────────────────────────────────


def test_no_match_returns_empty():
    pages = [_page("p1", [_text_el("e1", "<p>hello</p>")])]
    result = grep_pages(pages, "xyz-not-found")
    assert result == {"matches": [], "total_matches": 0}


def test_empty_pages():
    assert grep_pages([], "anything") == {"matches": [], "total_matches": 0}


def test_empty_query():
    pages = [_page("p1", [_text_el("e1", "<p>hello</p>")])]
    assert grep_pages(pages, "") == {"matches": [], "total_matches": 0}


# ─── 9. content_excerpt 上下文构造 ───────────────────────────


def test_excerpt_short_content_no_ellipsis():
    """短内容不应该加 …"""
    excerpt = _build_excerpt("hello world", 0, 5)
    assert excerpt == "hello world"


def test_excerpt_long_content_adds_ellipsis():
    """长内容应该前后加 …"""
    long = "x" * 100 + "MATCH" + "y" * 100
    excerpt = _build_excerpt(long, 100, 5)
    assert excerpt.startswith("…")
    assert excerpt.endswith("…")
    assert "MATCH" in excerpt
    # 40 + 5 + 40 + 2 ellipsis chars
    assert len(excerpt) == 40 + 5 + 40 + 2


def test_excerpt_at_start_no_left_ellipsis():
    content = "MATCH" + "y" * 100
    excerpt = _build_excerpt(content, 0, 5)
    assert not excerpt.startswith("…")
    assert excerpt.endswith("…")


def test_excerpt_at_end_no_right_ellipsis():
    content = "x" * 100 + "MATCH"
    excerpt = _build_excerpt(content, 100, 5)
    assert excerpt.startswith("…")
    assert not excerpt.endswith("…")


# ─── 10. element 文本提取 ────────────────────────────────────


def test_extract_text_element():
    el = {"type": "text", "props": {"content": "<p>hi</p>"}}
    assert _extract_element_text(el) == "hi"


def test_extract_shape_element():
    el = {"type": "shape", "props": {"text": {"content": "<p>shape text</p>"}}}
    assert _extract_element_text(el) == "shape text"


def test_extract_shape_without_text():
    """shape 没有 text.content → 返回空串"""
    el = {"type": "shape", "props": {"fill": "#FFF"}}
    assert _extract_element_text(el) == ""


def test_extract_unknown_type():
    el = {"type": "image", "props": {"src": "https://x/y.png"}}
    assert _extract_element_text(el) == ""


def test_extract_invalid_element():
    assert _extract_element_text(None) == ""  # type: ignore[arg-type]
    assert _extract_element_text({}) == ""
    assert _extract_element_text({"type": "text"}) == ""
    assert _extract_element_text({"type": "text", "props": None}) == ""


# ─── 11. 防御性输入 ──────────────────────────────────────────


def test_invalid_page_skipped():
    pages = [None, "weird", _page("p1", [_text_el("e1", "<p>Lumio</p>")])]
    result = grep_pages(pages, "Lumio")  # type: ignore[arg-type]
    assert result["total_matches"] == 1
    # 非法页跳过，page_index 仍按列表 0-based（None=0, "weird"=1, p1=2）
    assert result["matches"][0]["page_index"] == 2


def test_page_with_invalid_elements_field():
    pages = [{"page_id": "p1", "elements_data": "not-a-list", "order": 0}]
    result = grep_pages(pages, "anything")
    assert result["total_matches"] == 0


def test_page_with_none_elements():
    pages = [{"page_id": "p1", "elements_data": None, "order": 0}]
    result = grep_pages(pages, "anything")
    assert result["total_matches"] == 0


def test_element_without_id_still_returns_match():
    """element 没 id 也照样返回（element_id 给空串，至少 page_id 让 Agent 定位）"""
    pages = [_page("p1", [
        {"type": "text", "props": {"content": "<p>Lumio</p>"}},
    ])]
    result = grep_pages(pages, "Lumio")
    assert result["total_matches"] == 1
    assert result["matches"][0]["element_id"] == ""
    assert result["matches"][0]["page_id"] == "p1"
