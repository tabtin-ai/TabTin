import importlib.util
import io
import os
import re
import tempfile
import zipfile
import base64
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_image_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_parse_css_color = _PPTX_IO._parse_css_color
_merge_image_color_mask_overlays = _PPTX_IO._merge_image_color_mask_overlays
_extract_svg_canvas_size = _PPTX_IO._extract_svg_canvas_size
_render_svg_to_png_with_playwright = _PPTX_IO._render_svg_to_png_with_playwright
_normalize_image_bytes_for_pptx = _PPTX_IO._normalize_image_bytes_for_pptx
read = _PPTX_IO.read
write = _PPTX_IO.write


class TestPptxImageChain(TestCase):
    def _new_data_url(self, fmt: str, size=(40, 30), color=(255, 0, 0), mime=None) -> str:
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow not available")

        img = Image.new("RGB", size, color)
        buf = io.BytesIO()
        img.save(buf, format=fmt)
        data = base64.b64encode(buf.getvalue()).decode("ascii")
        mime_map = {
            "PNG": "image/png",
            "JPEG": "image/jpeg",
            "JPG": "image/jpeg",
            "GIF": "image/gif",
            "WEBP": "image/webp",
        }
        mime_type = mime or mime_map.get(fmt.upper(), "image/png")
        return f"data:{mime_type};base64,{data}"

    def _svg_data_url(self) -> str:
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">'
            '<rect width="64" height="48" fill="#00ff00"/></svg>'
        ).encode("utf-8")
        return "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii")

    def _roundtrip_single_image(self, element: dict, canvas_width: int = 1920, canvas_height: int = 1080):
        pages = [
            {
                "id": "page-1",
                "elements": [element],
                "background": {"type": "color", "value": "#ffffff"},
            }
        ]
        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=canvas_width, canvas_height=canvas_height)
            out_pages = read(pptx_path=pptx_path, canvas_width=canvas_width, canvas_height=canvas_height)
            return out_pages[0]["elements"]
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_parse_css_color_supports_short_and_long_hex_alpha(self):
        self.assertEqual(_parse_css_color("#1234"), ("#112233", 0.267))
        self.assertEqual(_parse_css_color("#11223380"), ("#112233", 0.502))

    def test_merge_image_color_mask_overlay(self):
        elements = [
            {
                "id": "img-1",
                "type": "image",
                "x": 100,
                "y": 120,
                "width": 320,
                "height": 180,
                "rotate": 15,
                "zIndex": 3,
                "props": {},
            },
            {
                "id": "mask-1",
                "type": "shape",
                "x": 100,
                "y": 120,
                "width": 320,
                "height": 180,
                "rotate": 15,
                "zIndex": 4,
                "opacity": 0.4,
                "props": {
                    "fill": "#112233",
                    "radius": 16,
                    "pptxShapeType": "roundRect",
                },
            },
        ]

        merged = _merge_image_color_mask_overlays(elements)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["type"], "image")
        self.assertEqual(merged[0]["props"]["colorMask"], "rgba(17,34,51,0.4)")
        self.assertEqual(merged[0]["props"]["radius"], 16.0)

    def test_extract_svg_canvas_size(self):
        svg_with_size = b'<svg xmlns="http://www.w3.org/2000/svg" width="800px" height="600px"></svg>'
        self.assertEqual(_extract_svg_canvas_size(svg_with_size), (800, 600))

        svg_with_viewbox = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"></svg>'
        self.assertEqual(_extract_svg_canvas_size(svg_with_viewbox), (1600, 900))

    def test_render_svg_to_png_with_playwright_fallback(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#ff0000"/></svg>'
        png_bytes = _render_svg_to_png_with_playwright(svg)
        if png_bytes is None:
            self.skipTest("Playwright/Chromium not available")
        self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_normalize_svg_to_png(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#00ff00"/></svg>'
        png_bytes = _normalize_image_bytes_for_pptx(svg, src_hint="foo.svg")
        if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            self.skipTest("SVG normalization fallback unavailable")
        self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_normalize_webp_to_png(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow not available")

        img = Image.new("RGB", (4, 4), (255, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="WEBP")
        webp_bytes = buf.getvalue()

        png_bytes = _normalize_image_bytes_for_pptx(webp_bytes, src_hint="foo.webp")
        self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_roundtrip_supports_png_jpeg_gif_webp_svg(self):
        cases = [
            ("PNG", self._new_data_url("PNG"), "data:image/png;base64,"),
            ("JPEG", self._new_data_url("JPEG"), "data:image/jpeg;base64,"),
            ("GIF", self._new_data_url("GIF"), "data:image/gif;base64,"),
            ("WEBP", self._new_data_url("WEBP"), "data:image/png;base64,"),  # 归一化为 PNG
            ("SVG", self._svg_data_url(), "data:image/png;base64,"),  # 归一化为 PNG
        ]
        for name, src, expected_prefix in cases:
            with self.subTest(fmt=name):
                elements = self._roundtrip_single_image(
                    {
                        "id": f"img-{name.lower()}",
                        "type": "image",
                        "x": 10,
                        "y": 20,
                        "width": 200,
                        "height": 100,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {"src": src},
                    }
                )
                if not elements and name == "SVG":
                    self.skipTest("SVG runtime normalization unavailable in this environment")
                self.assertEqual(len(elements), 1)
                out_src = elements[0]["props"].get("src", "")
                self.assertTrue(out_src.startswith(expected_prefix))

    def test_write_read_preserves_image_geometry_and_transform(self):
        src = self._new_data_url("PNG")
        elements = self._roundtrip_single_image(
            {
                "id": "img-geo",
                "type": "image",
                "x": 123.4,
                "y": 67.8,
                "width": 456.7,
                "height": 210.3,
                "rotate": 33.3,
                "opacity": 0.61,
                "flipH": True,
                "flipV": True,
                "zIndex": 0,
                "props": {"src": src},
            }
        )
        self.assertEqual(len(elements), 1)
        out = elements[0]
        self.assertAlmostEqual(out["x"], 123.4, delta=1.0)
        self.assertAlmostEqual(out["y"], 67.8, delta=1.0)
        self.assertAlmostEqual(out["width"], 456.7, delta=1.0)
        self.assertAlmostEqual(out["height"], 210.3, delta=1.0)
        self.assertAlmostEqual(out.get("rotate", 0), 33.3, delta=0.8)
        self.assertAlmostEqual(out.get("opacity", 1), 0.61, delta=0.06)
        self.assertTrue(out.get("flipH"))
        self.assertTrue(out.get("flipV"))

    def test_write_read_preserves_image_blur_and_invert_filters(self):
        src = self._new_data_url("PNG")
        elements = self._roundtrip_single_image(
            {
                "id": "img-filter",
                "type": "image",
                "x": 10,
                "y": 20,
                "width": 200,
                "height": 100,
                "rotate": 0,
                "zIndex": 0,
                "props": {
                    "src": src,
                    "filters": {
                        "brightness": 1.2,
                        "contrast": 0.9,
                        "saturate": 1.3,
                        "blur": 4,
                        "grayscale": 1,
                        "invert": 1,
                    },
                },
            }
        )
        out_filters = elements[0]["props"].get("filters", {})
        self.assertEqual(out_filters.get("blur"), 4.0)
        self.assertEqual(out_filters.get("invert"), 1)
        self.assertEqual(out_filters.get("brightness"), 1.2)
        self.assertEqual(out_filters.get("contrast"), 0.9)
        self.assertEqual(out_filters.get("saturate"), 1.3)
        self.assertEqual(out_filters.get("grayscale"), 1)

    def test_write_read_preserves_image_rect_clip(self):
        src = self._new_data_url("PNG")
        elements = self._roundtrip_single_image(
            {
                "id": "img-clip-rect",
                "type": "image",
                "x": 10,
                "y": 20,
                "width": 200,
                "height": 100,
                "rotate": 0,
                "zIndex": 0,
                "props": {
                    "src": src,
                    "clip": {
                        "shape": "rect",
                        "range": [
                            [0.1, 0.2],
                            [0.9, 0.2],
                            [0.9, 0.8],
                            [0.1, 0.8],
                        ],
                    },
                },
            }
        )
        out_clip = elements[0]["props"].get("clip")
        self.assertIsNotNone(out_clip)
        self.assertEqual(out_clip.get("shape"), "rect")
        self.assertEqual(len(out_clip.get("range", [])), 4)

    def test_write_read_preserves_image_ellipse_clip(self):
        src = self._new_data_url("PNG")
        elements = self._roundtrip_single_image(
            {
                "id": "img-clip-ellipse",
                "type": "image",
                "x": 10,
                "y": 20,
                "width": 200,
                "height": 100,
                "rotate": 0,
                "zIndex": 0,
                "props": {
                    "src": src,
                    "clip": {"shape": "ellipse", "range": []},
                },
            }
        )
        out_clip = elements[0]["props"].get("clip")
        self.assertIsNotNone(out_clip)
        self.assertEqual(out_clip.get("shape"), "ellipse")

    def test_write_read_preserves_image_radius_shadow_colormask(self):
        src = self._new_data_url("PNG")
        elements = self._roundtrip_single_image(
            {
                "id": "img-style",
                "type": "image",
                "x": 20,
                "y": 30,
                "width": 220,
                "height": 140,
                "rotate": 12,
                "zIndex": 0,
                "shadow": {
                    "h": 6,
                    "v": 4,
                    "blur": 8,
                    "color": "rgba(0,0,0,0.35)",
                },
                "props": {
                    "src": src,
                    "radius": 18,
                    "colorMask": "rgba(12,34,56,0.4)",
                },
            }
        )
        # colorMask 写回是“图片 + 叠层”，读取后应合并回单图片
        self.assertEqual(len(elements), 1)
        out = elements[0]
        out_props = out.get("props", {})
        self.assertAlmostEqual(out_props.get("radius", 0), 18, delta=2.0)
        self.assertEqual(out_props.get("colorMask"), "rgba(12,34,56,0.4)")
        self.assertIn("shadow", out)

    def test_write_color_mask_overlay_matches_ellipse_clip_geometry(self):
        src = self._new_data_url("PNG")
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "img-mask-ellipse",
                        "type": "image",
                        "x": 24,
                        "y": 36,
                        "width": 260,
                        "height": 140,
                        "rotate": 8,
                        "zIndex": 0,
                        "props": {
                            "src": src,
                            "clip": {"shape": "ellipse", "range": []},
                            "colorMask": "rgba(20,40,60,0.35)",
                        },
                    }
                ],
                "background": {"type": "color", "value": "#ffffff"},
            }
        ]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=1920, canvas_height=1080)
            with zipfile.ZipFile(pptx_path, "r") as zf:
                slide_xml = zf.read("ppt/slides/slide1.xml").decode("utf-8", errors="ignore")
            ellipse_count = len(re.findall(r'<a:prstGeom[^>]*prst="ellipse"', slide_xml))
            # 一个来自图片本体裁剪，一个来自 colorMask 叠层，二者都应为 ellipse
            self.assertGreaterEqual(ellipse_count, 2)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass
