""" 回归：演示文稿版本历史预览需回传完整页面数据。

根因：`_build_slide_preview` 旧实现把每页砍成 `{id, title?, elements_count}`，
而 TabSlide 页面模型没有页级 `title`/`name` 字段（标题是页内文本元素），
导致前端历史面板永远拿不到内容、只能显示占位图标。

修复后该纯函数应回传完整 `pages`（含 elements）+ `theme` + 画布尺寸，
供前端 SlideRenderer 渲染真实缩略图。这些用例只覆盖纯数据变换，不触库。
"""
from apps.collab.api import _build_slide_preview


def _sample_page(page_id: str, element_count: int) -> dict:
    return {
        "id": page_id,
        "elements": [{"id": f"{page_id}-el-{i}", "type": "text"} for i in range(element_count)],
        "background": {"type": "solid", "color": "#ffffff"},
    }


class TestBuildSlidePreviewGH641:
    def test_dict_format_returns_full_pages_and_deck_meta(self):
        """新格式（dict）应原样回传完整页面 + 主题 + 画布尺寸。"""
        data = {
            "pages": [_sample_page("p1", 3), _sample_page("p2", 1)],
            "theme": {"backgroundColor": "#f0f0f0", "themeColors": ["#123456"]},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "16:9",
        }

        result = _build_slide_preview(data)

        assert result["type"] == "slide"
        assert result["page_count"] == 2
        assert result["theme"] == data["theme"]
        assert result["canvas_width"] == 1920
        assert result["canvas_height"] == 1080
        assert result["preset"] == "16:9"
        # 关键：页面带完整 elements，前端才能渲染真实内容
        assert [p["id"] for p in result["pages"]] == ["p1", "p2"]
        assert len(result["pages"][0]["elements"]) == 3
        assert len(result["pages"][1]["elements"]) == 1

    def test_legacy_list_format_has_no_deck_meta(self):
        """旧格式（纯 list pages）无 deck 级元数据，theme/画布尺寸为 None。"""
        data = [_sample_page("p1", 2)]

        result = _build_slide_preview(data)

        assert result["type"] == "slide"
        assert result["page_count"] == 1
        assert result["pages"][0]["id"] == "p1"
        assert result["theme"] is None
        assert result["canvas_width"] is None
        assert result["canvas_height"] is None
        assert result["preset"] is None

    def test_empty_presentation(self):
        """0 页演示文稿不报错，page_count=0、pages 为空。"""
        result = _build_slide_preview({"pages": [], "theme": None})

        assert result["type"] == "slide"
        assert result["page_count"] == 0
        assert result["pages"] == []

    def test_non_dict_pages_are_filtered_out(self):
        """脏数据：非 dict 的页面项被过滤，不影响其余页面。"""
        data = {"pages": [_sample_page("p1", 1), "broken", None, 42]}

        result = _build_slide_preview(data)

        assert result["page_count"] == 1
        assert result["pages"][0]["id"] == "p1"

    def test_unexpected_type_returns_empty_slide(self):
        """既非 list 也非 dict 时退化为空 slide 预览，不抛异常。"""
        result = _build_slide_preview(None)

        assert result["type"] == "slide"
        assert result["page_count"] == 0
        assert result["pages"] == []
