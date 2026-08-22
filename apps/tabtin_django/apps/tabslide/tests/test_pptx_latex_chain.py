import base64
import importlib.util
import json
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_latex_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write
_normalize_image_bytes_for_pptx = _PPTX_IO._normalize_image_bytes_for_pptx
_escape_xml_text = _PPTX_IO._escape_xml_text

LATEX_META_PREFIX = "TABSLIDE_LATEX_V1:"


def _encode_latex_meta(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return LATEX_META_PREFIX + base64.b64encode(raw).decode("ascii")


def _decode_latex_meta(meta: str) -> dict:
    if not meta.startswith(LATEX_META_PREFIX):
        raise ValueError("invalid latex meta prefix")
    raw = base64.b64decode(meta[len(LATEX_META_PREFIX):]).decode("utf-8")
    return json.loads(raw)


def _tiny_png_data_url() -> str:
    # 1x1 PNG
    png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="
    return "data:image/png;base64," + png_b64


class TestPptxLatexChain(TestCase):
    @staticmethod
    def _sample_svg() -> str:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32" '
            'preserveAspectRatio="xMidYMid meet" style="color:#111111">'
            '<path d="M2 16 L62 16" fill="none" stroke="currentColor" stroke-width="2"/>'
            '<path d="M32 2 L32 30" fill="none" stroke="currentColor" stroke-width="2"/>'
            '</svg>'
        )

    def test_normalize_svg_to_png_honors_target_size(self):
        svg_bytes = self._sample_svg().encode("utf-8")
        png = _normalize_image_bytes_for_pptx(
            svg_bytes,
            src_hint="formula.svg",
            target_width_px=320,
            target_height_px=160,
            supersample=3.0,
        )
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))

        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow not available")

        from io import BytesIO

        with Image.open(BytesIO(png)) as img:
            # 目标 320x160，超采样 3x => 960x480（受上限保护时至少应大于目标尺寸）
            self.assertGreaterEqual(img.width, 640)
            self.assertGreaterEqual(img.height, 320)

    def test_write_read_preserves_latex_alt_text_metadata(self):
        payload = {
            "latex": r"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}",
            "color": "#111827",
            "fixedRatio": True,
        }
        alt_text = _encode_latex_meta(payload)

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "img-latex-1",
                        "type": "image",
                        "x": 120,
                        "y": 160,
                        "width": 360,
                        "height": 120,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "src": _tiny_png_data_url(),
                            "fixedRatio": True,
                            "altText": alt_text,
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
            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)

            out_el = out_pages[0]["elements"][0]
            self.assertEqual(out_el["type"], "image")
            self.assertEqual(out_el["props"].get("altText"), alt_text)

            decoded = _decode_latex_meta(out_el["props"]["altText"])
            self.assertEqual(decoded["latex"], payload["latex"])
            self.assertEqual(decoded["color"], payload["color"])
            self.assertTrue(decoded["fixedRatio"])
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_latex_element_type_falls_back_to_image_and_keeps_metadata(self):
        payload = {
            "latex": r"\int_0^1 x^2 dx=\frac{1}{3}",
            "color": "#111111",
            "fixedRatio": True,
        }
        alt_text = _encode_latex_meta(payload)

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "latex-1",
                        "type": "latex",
                        "x": 200,
                        "y": 180,
                        "width": 420,
                        "height": 140,
                        "rotate": 0,
                        "zIndex": 1,
                        "props": {
                            "latex": payload["latex"],
                            "rasterSrc": _tiny_png_data_url(),
                            "altText": alt_text,
                            "fixedRatio": True,
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
            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_el = out_pages[0]["elements"][0]

            # 后端存储层仍为 image，但语义通过 altText 保留，前端可再还原为 latex
            self.assertEqual(out_el["type"], "image")
            self.assertEqual(out_el["props"].get("altText"), alt_text)
            self.assertTrue(out_el["props"].get("src", "").startswith("data:image/"))
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_latex_prefers_svg_over_raster_src_for_export(self):
        payload = {
            "latex": r"E=mc^2",
            "color": "#111111",
            "fixedRatio": True,
        }
        alt_text = _encode_latex_meta(payload)
        svg_markup = self._sample_svg()

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "latex-svg-priority",
                        "type": "latex",
                        "x": 200,
                        "y": 180,
                        "width": 420,
                        "height": 140,
                        "rotate": 0,
                        "zIndex": 1,
                        "props": {
                            "latex": payload["latex"],
                            "svg": svg_markup,
                            "rasterSrc": _tiny_png_data_url(),  # 极低清晰度兜底图
                            "altText": alt_text,
                            "fixedRatio": True,
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

            # 导出文件中的媒体图尺寸应明显大于 1x1，证明不是直接用了 rasterSrc 兜底。
            try:
                from PIL import Image
            except Exception:
                self.skipTest("Pillow not available")

            from io import BytesIO

            with zipfile.ZipFile(pptx_path, "r") as zf:
                media_names = [n for n in zf.namelist() if n.startswith("ppt/media/") and n.endswith(".png")]
                self.assertTrue(media_names)
                media_bytes = zf.read(media_names[0])

            with Image.open(BytesIO(media_bytes)) as img:
                self.assertGreaterEqual(img.width, 640)
                self.assertGreaterEqual(img.height, 240)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_latex_without_alt_text_auto_generates_metadata(self):
        payload = {
            "latex": r"f(x)=\sum_{n=0}^{\infty}\frac{x^n}{n!}",
            "color": "#0f172a",
            "fixedRatio": True,
        }

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "latex-auto-meta",
                        "type": "latex",
                        "x": 240,
                        "y": 220,
                        "width": 440,
                        "height": 120,
                        "rotate": 0,
                        "zIndex": 2,
                        "props": {
                            "latex": payload["latex"],
                            "rasterSrc": _tiny_png_data_url(),
                            "color": payload["color"],
                            "fixedRatio": payload["fixedRatio"],
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
            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_el = out_pages[0]["elements"][0]

            self.assertEqual(out_el["type"], "image")
            out_alt_text = out_el["props"].get("altText", "")
            self.assertTrue(out_alt_text.startswith(LATEX_META_PREFIX))

            decoded = _decode_latex_meta(out_alt_text)
            self.assertEqual(decoded["latex"], payload["latex"])
            self.assertEqual(decoded["color"], payload["color"])
            self.assertTrue(decoded["fixedRatio"])
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_latex_without_svg_or_raster_uses_placeholder_and_keeps_metadata(self):
        payload = {
            "latex": r"\alpha+\beta=\gamma",
            "color": "#111111",
            "fixedRatio": True,
        }

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "latex-placeholder",
                        "type": "latex",
                        "x": 120,
                        "y": 140,
                        "width": 360,
                        "height": 96,
                        "rotate": 0,
                        "zIndex": 1,
                        "props": {
                            "latex": payload["latex"],
                            "color": payload["color"],
                            "fixedRatio": payload["fixedRatio"],
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
            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            self.assertEqual(len(out_pages[0]["elements"]), 1)

            out_el = out_pages[0]["elements"][0]
            self.assertEqual(out_el["type"], "image")
            self.assertTrue(out_el["props"].get("src", "").startswith("data:image/"))

            out_alt_text = out_el["props"].get("altText", "")
            self.assertTrue(out_alt_text.startswith(LATEX_META_PREFIX))
            decoded = _decode_latex_meta(out_alt_text)
            self.assertEqual(decoded["latex"], payload["latex"])
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_written_slide_xml_contains_alt_text_descr(self):
        payload = {"latex": r"e^{i\pi}+1=0", "fixedRatio": True}
        alt_text = _encode_latex_meta(payload)

        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "img-latex-xml",
                        "type": "image",
                        "x": 80,
                        "y": 90,
                        "width": 300,
                        "height": 90,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "src": _tiny_png_data_url(),
                            "altText": alt_text,
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
            self.assertIn('descr="', slide_xml)
            self.assertIn("TABSLIDE_LATEX_V1:", slide_xml)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_escape_xml_text_handles_all_special_chars(self):
        """B7-02 回归: SVG path 中的 XML 特殊字符必须被完整转义"""
        malicious = 'M0 0"/><script>alert(1)</script><path d="M1 1'
        escaped = _escape_xml_text(malicious)
        self.assertNotIn("<", escaped)
        self.assertNotIn(">", escaped)
        self.assertNotIn('"', escaped)
        self.assertIn("&lt;", escaped)
        self.assertIn("&gt;", escaped)
        self.assertIn("&quot;", escaped)

    def test_write_latex_path_with_xml_special_chars_produces_valid_pptx(self):
        """B7-02 回归: path 含 XML 特殊字符时导出不应崩溃且 XML 有效"""
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "latex-xml-injection",
                        "type": "latex",
                        "x": 100,
                        "y": 100,
                        "width": 300,
                        "height": 100,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "latex": r"x^2",
                            "path": 'M0 0 L10&20 "30<40>50',
                            "viewBox": [100, 50],
                            "color": "#111111",
                            "rasterSrc": _tiny_png_data_url(),
                            "fixedRatio": True,
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

            self.assertNotIn("<script>", slide_xml)
            self.assertNotIn('alert(1)', slide_xml)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass
