"""
TC-PREVIEW-BG-01 — preview_service._build_background_css 字段名兼容性

回归用例：
  - DB 内部存储格式：{"type":"solid","value":"#0A0E1A"}（dom_extractor / pptx_io 早期产出）
  - 前端 API 出参格式：{"type":"solid","color":"#0A0E1A"}（normalize_background_for_api 转后）
  - 'color' 类型也按 solid 处理（OOXML 历史命名）
  - theme 背景（{"type":"theme","theme":{"key":"bg1","color":"#XXX"}}）

修复前 bug：
  page.background 在 DB 是 {"value":"#0A0E1A"}，但 preview 找 .color，
  导致渲染为白色背景。Agent 看 preview 截图以为背景没了，
  误以为内容也丢了（白字在白底上看不见）。
"""

from __future__ import annotations

import unittest

from apps.tabslide.services.preview_service import _build_background_css


class PreviewBackgroundCompatTests(unittest.TestCase):
    # ── solid / color / theme 三种 type ──

    def test_solid_with_color_key(self):
        """API 出参格式：solid + color。"""
        css = _build_background_css({"type": "solid", "color": "#0A0E1A"})
        # _safe_css_color 规范化为小写，是 CSS 等价写法
        self.assertEqual(css.lower(), "background-color: #0a0e1a;")

    def test_solid_with_value_key(self):
        """DB 内部格式：solid + value (历史字段命名)。这是修复前的 bug 现场。"""
        css = _build_background_css({"type": "solid", "value": "#0A0E1A"})
        self.assertEqual(css.lower(), "background-color: #0a0e1a;")

    def test_color_type_treated_as_solid(self):
        """OOXML 历史命名 'color'，行为同 'solid'。"""
        css = _build_background_css({"type": "color", "value": "#FF0000"})
        self.assertEqual(css.lower(), "background-color: #ff0000;")

    def test_theme_with_color(self):
        """theme 背景：从 theme.color 取值。"""
        css = _build_background_css({
            "type": "theme",
            "theme": {"key": "bg1", "color": "#1A1D24"},
        })
        self.assertEqual(css.lower(), "background-color: #1a1d24;")

    # ── gradient ──

    def test_gradient(self):
        css = _build_background_css({
            "type": "gradient",
            "gradient": {
                "type": "linear",
                "rotate": 135,
                "colors": [
                    {"color": "#FF0000", "pos": 0},
                    {"color": "#0000FF", "pos": 1.0},
                ],
            },
        }).lower()
        self.assertIn("linear-gradient(135.0deg", css)
        self.assertIn("#ff0000", css)
        self.assertIn("#0000ff", css)

    def test_gradient_empty_falls_back(self):
        css = _build_background_css({"type": "gradient", "gradient": {"colors": []}})
        self.assertEqual(css, "background-color: #ffffff;")

    # ── image ──

    def test_image_dict_format(self):
        """新格式：image 是 dict。"""
        css = _build_background_css({
            "type": "image",
            "image": {"src": "https://x/y.png", "size": "cover"},
        })
        self.assertIn("background-image: url('https://x/y.png')", css)
        self.assertIn("background-size: cover", css)

    def test_image_string_format(self):
        """老格式：image 是 string URL。"""
        css = _build_background_css({
            "type": "image",
            "image": "https://x/y.png",
        })
        self.assertIn("background-image: url('https://x/y.png')", css)

    def test_image_src_at_top_level(self):
        """更老格式：src 在顶层。"""
        css = _build_background_css({
            "type": "image",
            "src": "https://x/y.png",
        })
        self.assertIn("background-image: url('https://x/y.png')", css)

    def test_image_size_whitelist(self):
        """非白名单的 size 回退到 cover。"""
        css = _build_background_css({
            "type": "image",
            "image": {"src": "https://x.png", "size": "evil; xss"},
        })
        self.assertIn("background-size: cover", css)

    # ── 边界 ──

    def test_none_returns_white(self):
        self.assertEqual(_build_background_css(None), "background-color: #ffffff;")

    def test_empty_dict_returns_white(self):
        # 空 dict 走 solid 分支，因为没有 color/value，回退 #ffffff
        css = _build_background_css({})
        self.assertEqual(css, "background-color: #ffffff;")

    def test_unknown_type_returns_white(self):
        css = _build_background_css({"type": "unknown_xyz"})
        self.assertEqual(css, "background-color: #ffffff;")


if __name__ == "__main__":
    unittest.main()
