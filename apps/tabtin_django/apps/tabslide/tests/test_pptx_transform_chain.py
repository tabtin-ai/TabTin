import importlib.util
import os
import tempfile
from pathlib import Path
from unittest import TestCase

from lxml import etree

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_build_write_batches = _PPTX_IO._build_write_batches
_extract_opacity = _PPTX_IO._extract_opacity
_find_transform_xfrm = _PPTX_IO._find_transform_xfrm
_normalize_z_index = _PPTX_IO._normalize_z_index
_resolve_flip_flag = _PPTX_IO._resolve_flip_flag
_sort_elements_by_z_index = _PPTX_IO._sort_elements_by_z_index
emu_to_px = _PPTX_IO.emu_to_px
px_to_emu = _PPTX_IO.px_to_emu
_resolve_slide_emu_for_write = _PPTX_IO._resolve_slide_emu_for_write
read = _PPTX_IO.read
write = _PPTX_IO.write


class _DummyShape:
    def __init__(self, xml: str):
        self._element = etree.fromstring(xml.encode("utf-8"))


class TestPptxTransformChain(TestCase):
    def test_emu_to_px_keeps_three_decimal_precision(self):
        # 10 / 3 = 3.333333..., 期望保留 3 位小数。
        self.assertEqual(emu_to_px(10, 3, 1), 3.333)

    def test_build_write_batches_keep_group_and_ungrouped_z_order(self):
        elements = [
            {"id": "a", "type": "shape", "zIndex": 0},
            {"id": "g1-1", "type": "shape", "groupId": "g1", "zIndex": 1},
            {"id": "g1-2", "type": "shape", "groupId": "g1", "zIndex": 2},
            {"id": "b", "type": "shape", "zIndex": 3},
        ]
        batches = _build_write_batches(elements)

        self.assertEqual(len(batches), 3)
        self.assertEqual(batches[0]["kind"], "single")
        self.assertEqual(batches[0]["element"]["id"], "a")

        self.assertEqual(batches[1]["kind"], "group")
        self.assertEqual(batches[1]["groupId"], "g1")
        self.assertEqual([e["id"] for e in batches[1]["elements"]], ["g1-1", "g1-2"])

        self.assertEqual(batches[2]["kind"], "single")
        self.assertEqual(batches[2]["element"]["id"], "b")

    def test_normalize_z_index_handles_invalid_inputs(self):
        self.assertEqual(_normalize_z_index("3"), 3)
        self.assertEqual(_normalize_z_index(2.8), 2)
        self.assertEqual(_normalize_z_index(-5), 0)
        self.assertEqual(_normalize_z_index("abc", fallback=7), 7)

    def test_sort_elements_by_z_index_keeps_invalid_at_tail_with_stable_order(self):
        elements = [
            {"id": "z2-a", "zIndex": 2},
            {"id": "invalid-1", "zIndex": "oops"},
            {"id": "z1", "zIndex": "1"},
            {"id": "invalid-2"},
            {"id": "z2-b", "zIndex": 2},
            "not-a-dict",
        ]
        sorted_elements = _sort_elements_by_z_index(elements)
        self.assertEqual(
            [el["id"] for el in sorted_elements],
            ["z1", "z2-a", "z2-b", "invalid-1", "invalid-2"],
        )

    def test_find_transform_xfrm_prefers_shape_sppr_over_nested_xfrm(self):
        shape = _DummyShape(
            """
            <p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <p:nvSpPr>
                <p:cNvPr id="2" name="Shape 1"/>
                <p:cNvSpPr>
                  <a:xfrm flipV="1" />
                </p:cNvSpPr>
                <p:nvPr/>
              </p:nvSpPr>
              <p:spPr>
                <a:xfrm flipH="1" />
              </p:spPr>
            </p:sp>
            """
        )
        xfrm = _find_transform_xfrm(shape._element)
        self.assertIsNotNone(xfrm)
        self.assertEqual(xfrm.get("flipH"), "1")
        self.assertIsNone(xfrm.get("flipV"))

    def test_resolve_flip_flag_respects_explicit_false(self):
        props = {"flipH": False}
        element = {"flipH": True, "flipV": True}
        self.assertFalse(_resolve_flip_flag(props, element, "flipH"))
        self.assertTrue(_resolve_flip_flag(props, element, "flipV"))

    def test_extract_opacity_ignores_solid_fill_color_alpha(self):
        shape = _DummyShape(
            """
            <p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <p:spPr>
                <a:solidFill>
                  <a:schemeClr val="accent1">
                    <a:alpha val="25000" />
                  </a:schemeClr>
                </a:solidFill>
              </p:spPr>
            </p:sp>
            """
        )
        self.assertIsNone(_extract_opacity(shape))

    def test_extract_opacity_ignores_blip_alpha_mod_fix(self):
        shape = _DummyShape(
            """
            <p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                   xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <p:spPr>
                <a:blipFill>
                  <a:blip>
                    <a:alphaModFix val="50000" />
                  </a:blip>
                </a:blipFill>
              </p:spPr>
            </p:pic>
            """
        )
        self.assertIsNone(_extract_opacity(shape))

    def test_resolve_slide_emu_for_write_prefers_source_dimensions(self):
        w_emu, h_emu = _resolve_slide_emu_for_write(
            canvas_width=1920,
            canvas_height=1080,
            source_slide_width_emu=14325600,
            source_slide_height_emu=8064000,
        )
        self.assertEqual((w_emu, h_emu), (14325600, 8064000))

    def test_resolve_slide_emu_for_write_falls_back_to_canvas_ratio(self):
        # 未提供 source EMU 时，沿用历史逻辑：默认宽度 + 画布比例推导高度
        w_emu, h_emu = _resolve_slide_emu_for_write(
            canvas_width=1024,
            canvas_height=768,
        )
        self.assertEqual(w_emu, 12192000)
        self.assertEqual(h_emu, 9144000)

    def test_px_emu_roundtrip_is_reversible_within_one_emu(self):
        slide_emu = 14325600
        canvas_px = 1920
        for emu in (0, 1, 10, 12700, 952500, 1234567, 9876543, 14325599):
            px = emu_to_px(emu, slide_emu, canvas_px)
            emu_back = px_to_emu(px, canvas_px, slide_emu)
            # emu_to_px 保留 3 位小数，理论最大误差约为 0.5 * 10^-3 px，
            # 在 16:9 1920 画布下约等于 3.7 EMU，这里给 8 EMU 安全边界。
            self.assertLessEqual(abs(emu_back - emu), 8)

    def test_write_read_shape_transform_roundtrip_keeps_precision(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "shape-1",
                        "type": "shape",
                        "x": 123.4567,
                        "y": 78.9123,
                        "width": 321.6543,
                        "height": 210.9876,
                        "rotate": 33.37,
                        "flipH": True,
                        "flipV": True,
                        "opacity": 0.6789,
                        "zIndex": 0,
                        "props": {
                            "viewBox": [321.6543, 210.9876],
                            "path": "M 0 0 L 321.6543 0 L 321.6543 210.9876 L 0 210.9876 Z",
                            "fill": "#336699",
                            "pptxShapeType": "rect",
                        },
                    },
                    {
                        "id": "shape-2",
                        "type": "shape",
                        "x": 300.1234,
                        "y": 200.5678,
                        "width": 220.3456,
                        "height": 130.2345,
                        "rotate": 0,
                        "zIndex": 1,
                        "props": {
                            "viewBox": [220.3456, 130.2345],
                            "path": "M 0 0 L 220.3456 0 L 220.3456 130.2345 L 0 130.2345 Z",
                            "fill": "#AA7733",
                            "pptxShapeType": "rect",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )

            self.assertEqual(len(out_pages), 1)
            out_elements = out_pages[0]["elements"]
            self.assertEqual(len(out_elements), 2)

            # zIndex / 层级顺序
            self.assertEqual(out_elements[0]["zIndex"], 0)
            self.assertEqual(out_elements[1]["zIndex"], 1)

            shape = out_elements[0]
            self.assertEqual(shape["type"], "shape")
            self.assertAlmostEqual(shape["x"], 123.457, places=3)
            self.assertAlmostEqual(shape["y"], 78.912, places=3)
            self.assertAlmostEqual(shape["width"], 321.654, places=3)
            self.assertAlmostEqual(shape["height"], 210.988, places=3)
            self.assertAlmostEqual(shape["rotate"], 33.37, places=2)
            self.assertTrue(shape.get("flipH"))
            self.assertTrue(shape.get("flipV"))
            # opacity 至少保留 4 位精度，避免频繁编辑后的可见漂移
            self.assertAlmostEqual(shape.get("opacity", 1.0), 0.6789, places=4)

            # 透明度语义单通道：避免 fill(alpha) 与 opacity 双重叠加
            fill_color = shape.get("props", {}).get("fill")
            self.assertEqual(str(fill_color).lower(), "#336699")
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_read_layer_order_visibility_and_locked_roundtrip(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "shape-hidden-locked",
                        "type": "shape",
                        "x": 900,
                        "y": 120,
                        "width": 180,
                        "height": 90,
                        "rotate": 0,
                        "zIndex": 5,
                        "visible": False,
                        "locked": True,
                        "props": {
                            "viewBox": [180, 90],
                            "path": "M 0 0 L 180 0 L 180 90 L 0 90 Z",
                            "fill": "#cc8844",
                            "pptxShapeType": "rect",
                        },
                    },
                    {
                        "id": "text-locked",
                        "type": "text",
                        "x": 300,
                        "y": 120,
                        "width": 220,
                        "height": 80,
                        "rotate": 0,
                        "zIndex": 1,
                        "locked": True,
                        "props": {
                            "content": "<p>Locked Text</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 24,
                            "defaultColor": "#222222",
                        },
                    },
                    {
                        "id": "line-hidden-locked",
                        "type": "line",
                        "x": 700,
                        "y": 140,
                        "width": 160,
                        "height": 80,
                        "rotate": 0,
                        "zIndex": 3,
                        "visible": False,
                        "locked": True,
                        "props": {
                            "start": [0, 0],
                            "end": [160, 80],
                            "style": "solid",
                            "color": "#0A84FF",
                            "lineWidth": 3,
                            "points": ["", ""],
                        },
                    },
                    {
                        "id": "text-bottom",
                        "type": "text",
                        "x": 100,
                        "y": 120,
                        "width": 220,
                        "height": 80,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "content": "<p>Bottom</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 24,
                            "defaultColor": "#222222",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_elements = out_pages[0]["elements"]
            self.assertEqual(len(out_elements), 4)

            # 导出时应按 zIndex 写入，读取后重建为 0..N-1 且保持视觉顺序
            self.assertEqual([el.get("zIndex") for el in out_elements], [0, 1, 2, 3])
            self.assertAlmostEqual(out_elements[0]["x"], 100.0, places=3)
            self.assertAlmostEqual(out_elements[1]["x"], 300.0, places=3)
            self.assertAlmostEqual(out_elements[2]["x"], 700.0, places=3)
            self.assertAlmostEqual(out_elements[3]["x"], 900.0, places=3)

            locked_text = out_elements[1]
            hidden_line = out_elements[2]
            hidden_shape = out_elements[3]

            self.assertEqual(locked_text.get("type"), "text")
            self.assertTrue(locked_text.get("locked"))
            self.assertNotIn("visible", locked_text)

            self.assertEqual(hidden_line.get("type"), "line")
            self.assertTrue(hidden_line.get("locked"))
            self.assertFalse(hidden_line.get("visible", True))

            self.assertEqual(hidden_shape.get("type"), "shape")
            self.assertTrue(hidden_shape.get("locked"))
            self.assertFalse(hidden_shape.get("visible", True))
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass
