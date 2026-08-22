"""HTML→PPTX 抽取层样式保真回归（opacity / alpha / shadow / wordSpace / transform / ellipse）。"""

from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from apps.tabslide.services.dom_extractor import (
    _apply_plain_text_transform,
    _apply_text_transform_to_html_content,
    _clamp_elements_to_canvas,
    _dedup_text_covered_by_shape_text,
    _dom_shape_extract_to_ppt_element,
    _enrich_text_element_from_layout,
    _normalize_extracted_html_whitespace,
    _postprocess_slide_elements,
    _validate_html_constraints,
    _walker_text_dedup,
)


class DomShapeFidelityTests(TestCase):
    def test_element_opacity_preserved(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": -80, "y": -80, "width": 320, "height": 320,
            "fill": "#F7E4D4",
            "borderRadiusPx": 160,
            "opacity": 0.6,
            "shadow": None,
        })
        self.assertEqual(el["pptxShapeType"], "ellipse")
        self.assertAlmostEqual(float(el["opacity"]), 0.6, places=3)
        self.assertEqual(el["fill"], "#F7E4D4")

    def test_fill_alpha_and_opacity_merged_once(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": 0, "y": 0, "width": 100, "height": 100,
            "fill": "#FFFFFF14",  # ~0.078 alpha
            "opacity": 0.5,
            "borderRadiusPx": 0,
        })
        fill = el["fill"]
        self.assertTrue(fill.startswith("#FFFFFF"))
        self.assertEqual(len(fill), 9)
        aa = int(fill[7:9], 16) / 255.0
        self.assertAlmostEqual(aa, 0.078 * 0.5, delta=0.02)
        self.assertEqual(el.get("opacity", 1), 1)

    def test_fill_css_rgba_keeps_alpha(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": 0, "y": 0, "width": 40, "height": 40,
            "fill": None,
            "fillCss": "rgba(10, 10, 10, 0.48)",
            "opacity": 1,
            "borderRadiusPx": 0,
        })
        self.assertEqual(len(el["fill"]), 9)
        self.assertTrue(el["fill"].startswith("#0A0A0A"))

    def test_shadow_passed_through(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": 80, "y": 80, "width": 400, "height": 200,
            "fill": "#FFFFFF",
            "borderRadiusPx": 16,
            "opacity": 1,
            "shadow": {"h": 0, "v": 4, "blur": 24, "color": "#0A0A0A", "opacity": 0.06},
        })
        self.assertEqual(el["pptxShapeType"], "roundRect")
        sh = el["shadow"]
        self.assertAlmostEqual(sh["blur"], 24)
        self.assertAlmostEqual(sh["opacity"], 0.06)


class TextEnrichFidelityTests(TestCase):
    def test_letter_spacing_maps_to_word_space(self):
        el = {
            "type": "text",
            "content": "<p>eyebrow</p>",
            "defaultColor": "#C96A1A",
            "defaultFontSize": 10,
        }
        _enrich_text_element_from_layout(el, {
            "fontWeight": 700,
            "letterSpacing": 4.0,
            "color": "#C96A1A",
            "textTransform": "uppercase",
            "runs": [{"text": "EYEBROW", "bold": True, "color": "#C96A1A", "fontSize": 13}],
        })
        self.assertEqual(el["wordSpace"], 4.0)
        self.assertIn("EYEBROW", el["content"])
        self.assertNotIn("text-transform", el["content"].lower())

    def test_rgba_color_from_layout(self):
        el = {"type": "text", "content": "<p>sub</p>", "defaultColor": "#000000", "opacity": 0.5}
        _enrich_text_element_from_layout(el, {
            "color": "#0A0A0A7A",
            "opacity": 0.5,
            "runs": [],
        })
        self.assertEqual(el["defaultColor"], "#0A0A0A7A")
        self.assertEqual(el["opacity"], 1, "9 位色含 alpha 时应清掉元素 opacity，避免双重变虚")

    def test_text_transform_applied_without_css_wrapper(self):
        out = _apply_text_transform_to_html_content("<p>hello world</p>", "uppercase")
        self.assertEqual(out, "<p>HELLO WORLD</p>")
        self.assertEqual(_apply_plain_text_transform("ab", "capitalize"), "Ab")

    def test_whitespace_collapsed(self):
        dirty = "<p>\n    TabTin Team\n  </p>"
        clean = _normalize_extracted_html_whitespace(dirty)
        self.assertNotIn("\n", clean)
        self.assertIn("TabTin Team", clean)


class CanvasSchemeATests(TestCase):
    def test_decorative_circle_keeps_negative_origin(self):
        el = {
            "type": "shape", "x": -80, "y": -80, "width": 320, "height": 320,
            "fill": "#F7E4D4", "opacity": 0.6,
        }
        out = _clamp_elements_to_canvas([dict(el)], 1280, 720)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["x"], out[0]["y"]), (-80, -80))
        self.assertEqual((out[0]["width"], out[0]["height"]), (320, 320))


class PostprocessWordSpaceTests(TestCase):
    def test_postprocess_keeps_word_space_from_layout(self):
        el = {
            "id": "t1",
            "type": "text",
            "x": 80,
            "y": 100,
            "width": 200,
            "height": 20,
            "content": "<p>label</p>",
            "defaultFontSize": 10,
            "defaultColor": "#C96A1A",
            "opacity": 1,
            "rotate": 0,
            "locked": False,
            "visible": True,
        }
        layout = [{
            "x": 80, "y": 100, "width": 200, "height": 20,
            "letterSpacing": 2.0,
            "color": "#C96A1A",
            "fontWeight": 700,
            "textTransform": "uppercase",
            "runs": [{"text": "LABEL", "bold": True, "color": "#C96A1A", "fontSize": 13}],
        }]
        out = _postprocess_slide_elements([el], text_layout_data=layout)
        self.assertEqual(out[0].get("wordSpace"), 2.0)


class CodeBlockLayoutCollisionTests(TestCase):
    """代码块 (x,y) 撞上内层 `$` span 时不得截断 content。"""

    def test_enrich_skips_short_layout_subset(self):
        el = {
            "type": "text",
            "content": (
                '<p><span style="color:">$</span> tabtin code open<br>'
                '<span style="color:">$</span> tabtin space create</p>'
            ),
            "defaultColor": "#F5A830",
            "defaultFontSize": 12,
        }
        _enrich_text_element_from_layout(el, {
            "x": 669, "y": 332, "width": 10, "height": 16,
            "color": "#888888",
            "runs": [{"text": "$", "color": "#888888", "fontSize": 14}],
        })
        self.assertIn("tabtin code open", el["content"])
        self.assertEqual(el["defaultColor"], "#F5A830", "错配 layout 不应改字色")

    def test_postprocess_prefers_longer_layout_on_xy_collision(self):
        el = {
            "id": "code",
            "type": "text",
            "x": 669,
            "y": 332,
            "width": 400,
            "height": 120,
            "content": "<p>$ tabtin code open<br>$ tabtin space create</p>",
            "defaultColor": "#F5A830",
            "defaultFontSize": 12,
            "opacity": 1,
            "rotate": 0,
            "locked": False,
            "visible": True,
        }
        layouts = [
            {
                "x": 669, "y": 332, "width": 400, "height": 120,
                "color": "#F5A830",
                "runs": [
                    {"text": "$ tabtin code open\n$ tabtin space create", "color": "#F5A830"},
                ],
            },
            {
                "x": 669, "y": 332, "width": 8, "height": 16,
                "color": "#888888",
                "runs": [{"text": "$", "color": "#888888"}],
            },
        ]
        out = _postprocess_slide_elements([el], text_layout_data=layouts)
        self.assertIn("tabtin code open", out[0]["content"])
        self.assertIn("<br>", out[0]["content"])


class SiblingTitleLayoutCollisionTests(TestCase):
    """同排多卡片标题 / 脚注两端不得因 y+h 模糊匹配串文。"""

    def test_postprocess_does_not_cross_contaminate_same_row_titles(self):
        titles = [
            ("文档协作", 80),
            ("数据表格", 460),
            ("研发场景", 840),
        ]
        elements = []
        layouts = []
        for i, (text, x) in enumerate(titles):
            elements.append({
                "id": f"t{i}",
                "type": "text",
                "x": x,
                "y": 220,
                "width": 280,
                "height": 36,
                "content": f"<p>{text}</p>",
                "defaultFontSize": 22,
                "defaultColor": "#0A0A0A",
                "opacity": 1,
                "rotate": 0,
                "locked": False,
                "visible": True,
            })
            layouts.append({
                "x": x, "y": 220, "width": 280, "height": 36,
                "fontWeight": 700,
                "runs": [{"text": text, "bold": True, "fontSize": 28}],
            })
        # 故意再塞一个「最长」layout，y/h 相同但 x 偏离，旧逻辑会盖掉全部标题
        layouts.append({
            "x": 840, "y": 220, "width": 280, "height": 36,
            "fontWeight": 700,
            "runs": [{"text": "研发场景", "bold": True, "fontSize": 28}],
        })
        out = _postprocess_slide_elements(elements, text_layout_data=layouts)
        self.assertTrue(any("文档协作" in (e.get("content") or "") for e in out))
        self.assertTrue(any("数据表格" in (e.get("content") or "") for e in out))
        self.assertEqual(
            sum(1 for e in out if "研发场景" in (e.get("content") or "")),
            1,
        )
        self.assertFalse(all("研发场景" in (e.get("content") or "") for e in out))

    def test_footer_year_not_replaced_by_brand(self):
        els = [
            {
                "id": "left",
                "type": "text",
                "x": 80,
                "y": 680,
                "width": 200,
                "height": 20,
                "content": "<p>TabTin 团队版</p>",
                "defaultFontSize": 12,
                "defaultColor": "#FFFFFF",
                "opacity": 1,
                "rotate": 0,
                "locked": False,
                "visible": True,
            },
            {
                "id": "right",
                "type": "text",
                "x": 1160,
                "y": 680,
                "width": 60,
                "height": 20,
                "content": "<p>2025</p>",
                "defaultFontSize": 12,
                "defaultColor": "#FFFFFF",
                "opacity": 1,
                "rotate": 0,
                "locked": False,
                "visible": True,
            },
        ]
        layouts = [
            {
                "x": 80, "y": 680, "width": 200, "height": 20,
                "runs": [{"text": "TabTin 团队版"}],
            },
            # 故意偏移 x，模拟测量误差；仍应匹配左侧，不得盖右侧年份
            {
                "x": 82, "y": 680, "width": 200, "height": 20,
                "runs": [{"text": "TabTin 团队版"}],
            },
        ]
        out = _postprocess_slide_elements(els, text_layout_data=layouts)
        by_id = {e["id"]: e for e in out}
        self.assertIn("2025", by_id["right"]["content"])
        self.assertNotIn("团队版", by_id["right"]["content"])
        self.assertIn("TabTin 团队版", by_id["left"]["content"])

    def test_enrich_skips_mismatched_layout_text(self):
        el = {
            "type": "text",
            "content": "<p>文档协作</p>",
            "defaultColor": "#0A0A0A",
            "defaultFontSize": 22,
        }
        _enrich_text_element_from_layout(el, {
            "runs": [{"text": "研发场景", "bold": True}],
            "fontWeight": 700,
        })
        self.assertIn("文档协作", el["content"])
        self.assertNotIn("研发场景", el["content"])


class InsetOutlineShapeTests(TestCase):
    """inset box-shadow 假描边 → outline（与 border 等价写出）。"""

    def test_outline_only_round_rect_from_raw_line(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": 100, "y": 600, "width": 140, "height": 44,
            "fill": None,
            "borderRadiusPx": 22,
            "line": {"color": "#0A0A0A38", "width": 1.125, "style": "solid"},
            "shadow": None,
            "opacity": 1,
        })
        self.assertEqual(el["pptxShapeType"], "roundRect")
        self.assertNotIn("fill", el)
        outline = el.get("outline") or {}
        self.assertAlmostEqual(float(outline.get("width", 0)), 1.125, places=3)
        self.assertTrue(str(outline.get("color", "")).startswith("#0A0A0A"))


class HtmlConstraintWarningTests(TestCase):
    def test_linear_gradient_on_child_no_longer_warned(self):
        html = (
            '<div class="ppt-slide">'
            '<div style="background:linear-gradient(135deg,#f5a830,#e07e29)">x</div>'
            "</div>"
        )
        warnings = _validate_html_constraints(html)
        self.assertFalse(any("Gradients are only supported" in w for w in warnings))
        self.assertFalse(any("linear-gradient" in w for w in warnings))

    def test_radial_gradient_still_warned(self):
        html = '<div class="ppt-slide"><div style="background:radial-gradient(circle,#fff,)">x</div></div>'
        warnings = _validate_html_constraints(html)
        self.assertTrue(any("radial-gradient" in w for w in warnings))


class CompositePillShapeTextTests(TestCase):
    """方案 A：流程胶囊由 shape + 内嵌 text（verticalAlign middle）承载。"""

    def test_dom_shape_passes_embedded_text(self):
        el = _dom_shape_extract_to_ppt_element({
            "x": 10, "y": 20, "width": 48, "height": 22,
            "fill": "#E07E291F",
            "borderRadiusPx": 11,
            "text": {
                "content": '<p style="text-align:center"><span>抓取</span></p>',
                "align": "center",
                "verticalAlign": "middle",
                "defaultFontSize": 9,
                "defaultColor": "#C96A1A",
                "defaultFontName": "Inter",
                "margin": {"top": 0, "right": 0, "bottom": 0, "left": 0},
            },
        })
        self.assertEqual(el["type"], "shape")
        self.assertEqual(el["pptxShapeType"], "roundRect")
        self.assertEqual(el["text"]["verticalAlign"], "middle")
        self.assertIn("抓取", el["text"]["content"])

    def test_dedup_drops_text_covered_by_shape_text(self):
        shape = {
            "type": "shape",
            "x": 100, "y": 200, "width": 50, "height": 24,
            "text": {"content": "<p>抓取</p>", "verticalAlign": "middle"},
        }
        orphan = {
            "type": "text",
            "x": 101, "y": 201, "width": 48, "height": 22,
            "content": "<p>抓取</p>",
            "_fromWalker": True,
        }
        arrow = {
            "type": "text",
            "x": 160, "y": 204, "width": 12, "height": 16,
            "content": "<p>→</p>",
        }
        out = _dedup_text_covered_by_shape_text([shape, orphan, arrow])
        plains = [
            __import__("re").sub(r"<[^>]+>", "", e.get("content") or "").strip()
            for e in out if e.get("type") == "text"
        ]
        self.assertEqual(plains, ["→"])
        self.assertTrue(any(e.get("type") == "shape" and "抓取" in (e.get("text") or {}).get("content", "") for e in out))

    def test_flow_pills_extract_as_shape_text_not_orphan_row(self):
        from apps.tabslide.services.dom_extractor import extract_elements_from_html

        html = """
        <!DOCTYPE html><html><head><style>
          .ppt-slide { width:1280px; height:720px; position:relative; overflow:hidden; }
          .tag {
            display: inline-flex; align-items: center; justify-content: center;
            padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
            background: rgba(224,126,41,0.12); color: #c96a1a;
          }
        </style></head><body>
          <div class="ppt-slide" style="padding:80px 100px;">
            <div style="display:flex;gap:8px;align-items:center">
              <span class="tag">抓取</span><span style="color:rgba(10,10,10,0.3)">→</span>
              <span class="tag">存储</span><span style="color:rgba(10,10,10,0.3)">→</span>
              <span class="tag">分析</span><span style="color:rgba(10,10,10,0.3)">→</span>
              <span class="tag">报告</span>
            </div>
          </div>
        </body></html>
        """
        # 本用例只验证原生 DOM pill，不依赖转换器为图表/图标注入的外部 CDN。
        with patch(
            "apps.tabslide.services.dom_extractor._ensure_full_html",
            side_effect=lambda value: value,
        ):
            pages = extract_elements_from_html(html, canvas_width=1280, canvas_height=720)
        elements = pages[0]["elements"]
        pills = []
        for e in elements:
            if e.get("type") != "shape":
                continue
            text = e.get("text") if isinstance(e.get("text"), dict) else None
            if not text:
                continue
            plain = __import__("re").sub(r"<[^>]+>", "", text.get("content") or "").strip()
            if plain in ("抓取", "存储", "分析", "报告"):
                pills.append((
                    plain,
                    text.get("verticalAlign"),
                    text.get("sourceLineCount"),
                    text.get("wordWrap"),
                    e,
                ))
        labels = [p[0] for p in pills]
        self.assertEqual(sorted(labels), ["分析", "存储", "抓取", "报告"])
        for _, valign, line_count, word_wrap, _ in pills:
            self.assertEqual(valign, "middle")
            self.assertEqual(line_count, 1)
            self.assertFalse(word_wrap)
        # 不得再有整行 orphan「抓取→存储→…」
        for e in elements:
            if e.get("type") != "text":
                continue
            plain = __import__("re").sub(r"<[^>]+>", "", e.get("content") or "").strip()
            self.assertNotIn("抓取→存储", plain.replace(" ", ""))
            self.assertNotIn(plain, ("抓取", "存储", "分析", "报告"))
        arrow_texts = [
            __import__("re").sub(r"<[^>]+>", "", e.get("content") or "").strip()
            for e in elements if e.get("type") == "text"
        ]
        self.assertGreaterEqual(sum(1 for t in arrow_texts if "→" in t), 3)

    def test_url_background_badge_keeps_walker_text(self):
        """url() 背景会变 image 且不带 text；walker 不得当合成宿主跳过。"""
        from apps.tabslide.services.dom_extractor import extract_elements_from_html

        # 1x1 PNG data URI
        png = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        html = f"""
        <!DOCTYPE html><html><head><style>
          .ppt-slide {{ width:1280px; height:720px; position:relative; overflow:hidden; }}
          .chip {{
            display:inline-flex; align-items:center; justify-content:center;
            padding:6px 14px; border-radius:999px; font-size:12px; color:#fff;
            background-image: url('{png}'); background-size: cover;
          }}
        </style></head><body>
          <div class="ppt-slide" style="padding:80px 100px;">
            <span class="chip">徽章字</span>
          </div>
        </body></html>
        """
        # data URL 背景回归不依赖 MathJax/图表/图标 CDN，避免网络抖动遮蔽断言。
        with patch(
            "apps.tabslide.services.dom_extractor._ensure_full_html",
            side_effect=lambda value: value,
        ):
            pages = extract_elements_from_html(html, canvas_width=1280, canvas_height=720)
        elements = pages[0]["elements"]
        texts = [
            __import__("re").sub(r"<[^>]+>", "", e.get("content") or "").strip()
            for e in elements if e.get("type") == "text"
        ]
        self.assertIn("徽章字", texts)
        # 不得错误落成带 text 却被丢掉的 shape（image 路径）
        for e in elements:
            if e.get("type") == "shape" and isinstance(e.get("text"), dict):
                plain = __import__("re").sub(r"<[^>]+>", "", e["text"].get("content") or "").strip()
                self.assertNotEqual(plain, "徽章字")


class FlexDotBulletGeometryTests(TestCase):
    """flex 行：空圆点 span + 文案 span —— textBoxRect 只量文字，不得与 ellipse 同 x。"""

    def test_text_box_starts_after_decorative_dot(self):
        from apps.tabslide.services.dom_extractor import extract_elements_from_html

        html = """
        <!DOCTYPE html><html><head><style>
          .ppt-slide { width:1280px; height:720px; position:relative; overflow:hidden; }
          .row { display:flex; align-items:flex-start; gap:10px; padding:5px 0; }
          .dot { width:7px; height:7px; border-radius:50%; background:#e07e29; flex-shrink:0; margin-top:7px; }
          .s-small { font-size:14px; color:; }
        </style></head><body>
          <div class="ppt-slide" style="padding:80px 100px;">
            <div class="row"><span class="dot"></span><span class="s-small">灵活分配配额</span></div>
          </div>
        </body></html>
        """
        # 纯 DOM 几何回归不依赖 MathJax/图表/图标 CDN，避免网络抖动遮蔽断言。
        with patch(
            "apps.tabslide.services.dom_extractor._ensure_full_html",
            side_effect=lambda value: value,
        ):
            pages = extract_elements_from_html(html, canvas_width=1280, canvas_height=720)
        self.assertEqual(len(pages), 1)
        elements = pages[0]["elements"]
        dots = [
            e for e in elements
            if e.get("type") == "shape"
            and e.get("pptxShapeType") == "ellipse"
            and float(e.get("width") or 0) <= 16
        ]
        texts = [
            e for e in elements
            if e.get("type") == "text" and "灵活分配配额" in (e.get("content") or "")
        ]
        self.assertTrue(dots, "应抽出圆点 ellipse")
        self.assertTrue(texts, "应抽出列表正文")
        dot, text = dots[0], texts[0]
        # 文字框左缘必须在圆点右缘之外（允许 1px 量框误差）
        self.assertGreaterEqual(
            float(text["x"]) + 1,
            float(dot["x"]) + float(dot["width"]),
            msg=f"text.x={text['x']} still overlaps dot x={dot['x']} w={dot['width']}",
        )


class WalkerListItemDedupTests(TestCase):
    """list-item = 编号 span + p：walker 整行不得与 PURE_DOM 的 p 双重落盘。"""

    def test_soft_dedup_drops_walker_row_overlapping_inner_p(self):
        pure = {
            "type": "text",
            "x": 152,
            "y": 546,
            "width": 302,
            "height": 20,
            "content": '<p class="t-body-sm">分层记忆：偏好 / 洞察 / 工作记录自动分类</p>',
        }
        walker = {
            "type": "text",
            "x": 132,
            "y": 544,
            "width": 322,
            "height": 26,
            "content": "<p>分层记忆：偏好 / 洞察 / 工作记录自动分类</p>",
            "_fromWalker": True,
            "_walkerKey": "132_544_分层记忆：偏好 / 洞察 / 工作",
        }
        # 编号+正文整行（正文为子串）
        walker_with_num = {
            "type": "text",
            "x": 132,
            "y": 495,
            "width": 216,
            "height": 26,
            "content": '<p><span class="list-num">01</span>任务拆解为阶段 + 里程碑</p>',
            "_fromWalker": True,
        }
        pure_num_body = {
            "type": "text",
            "x": 168,
            "y": 497,
            "width": 180,
            "height": 20,
            "content": "<p class=\"t-body-sm\">任务拆解为阶段 + 里程碑</p>",
        }
        out = _walker_text_dedup([pure, walker, pure_num_body, walker_with_num])
        plains = [
            __import__("re").sub(r"<[^>]+>", "", e.get("content") or "").strip()
            for e in out
            if e.get("type") == "text"
        ]
        self.assertEqual(plains.count("分层记忆：偏好 / 洞察 / 工作记录自动分类"), 1)
        self.assertEqual(plains.count("任务拆解为阶段 + 里程碑"), 1)
        self.assertFalse(any(e.get("_fromWalker") for e in out if "分层记忆" in (e.get("content") or "")))
