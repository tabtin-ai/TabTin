import importlib.util
import os
import tempfile
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_hyperlink_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write


_PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3ZfD0AAAAASUVORK5CYII="
)


class TestPptxHyperlinkChain(TestCase):
    def _roundtrip(self, pages, canvas_width=1920, canvas_height=1080):
        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )
            return read(
                pptx_path=pptx_path,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_text_inline_hyperlink_roundtrip(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "text-1",
                        "type": "text",
                        "x": 120,
                        "y": 120,
                        "width": 800,
                        "height": 180,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "content": '<p><a href="https://text.example.com">Text Link</a></p>',
                            "defaultFontFamily": "Calibri",
                            "defaultFontSize": 18,
                            "defaultColor": "#333333",
                        },
                    }
                ],
            }
        ]

        out_pages = self._roundtrip(pages)
        text_elements = [el for el in out_pages[0]["elements"] if el.get("type") == "text"]
        self.assertEqual(len(text_elements), 1)
        content = text_elements[0].get("props", {}).get("content", "")
        self.assertIn('href="https://text.example.com"', content)

    def test_text_inline_slide_hyperlink_roundtrip(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "text-slide-link",
                        "type": "text",
                        "x": 120,
                        "y": 120,
                        "width": 800,
                        "height": 180,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "content": '<p><a href="#page-2">Jump To Next</a></p>',
                            "defaultFontFamily": "Calibri",
                            "defaultFontSize": 18,
                            "defaultColor": "#333333",
                        },
                    }
                ],
            },
            {
                "id": "page-2",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [],
            },
        ]

        out_pages = self._roundtrip(pages)
        text_elements = [el for el in out_pages[0]["elements"] if el.get("type") == "text"]
        self.assertEqual(len(text_elements), 1)
        content = text_elements[0].get("props", {}).get("content", "")
        self.assertIn('href="#page-2"', content)

    def test_shape_image_table_element_hyperlink_roundtrip(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "shape-link",
                        "type": "shape",
                        "x": 80,
                        "y": 80,
                        "width": 280,
                        "height": 140,
                        "rotate": 0,
                        "zIndex": 0,
                        "link": {"type": "web", "target": "https://shape.example.com"},
                        "props": {
                            "pptxShapeType": "rect",
                            "fill": "#E8F0FF",
                        },
                    },
                    {
                        "id": "image-link",
                        "type": "image",
                        "x": 420,
                        "y": 80,
                        "width": 240,
                        "height": 140,
                        "rotate": 0,
                        "zIndex": 1,
                        "link": {"type": "web", "target": "https://image.example.com"},
                        "props": {
                            "src": _PNG_DATA_URL,
                        },
                    },
                    {
                        "id": "table-link",
                        "type": "table",
                        "x": 80,
                        "y": 280,
                        "width": 580,
                        "height": 180,
                        "rotate": 0,
                        "zIndex": 2,
                        "link": {"type": "web", "target": "https://table.example.com"},
                        "props": {
                            "data": [[{"text": "Cell", "colspan": 1, "rowspan": 1}]],
                            "colWidths": [1],
                        },
                    },
                ],
            }
        ]

        out_pages = self._roundtrip(pages)
        out_elements = out_pages[0].get("elements", [])

        shape_el = next(el for el in out_elements if el.get("type") == "shape")
        image_el = next(el for el in out_elements if el.get("type") == "image")
        table_el = next(el for el in out_elements if el.get("type") == "table")

        self.assertEqual(shape_el.get("link", {}).get("type"), "web")
        self.assertEqual(shape_el.get("link", {}).get("target"), "https://shape.example.com")

        self.assertEqual(image_el.get("link", {}).get("type"), "web")
        self.assertEqual(image_el.get("link", {}).get("target"), "https://image.example.com")

        self.assertEqual(table_el.get("link", {}).get("type"), "web")
        self.assertEqual(table_el.get("link", {}).get("target"), "https://table.example.com")

    def test_table_single_hyperlink_cell_keeps_rich_text(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "table-rich-link",
                        "type": "table",
                        "x": 120,
                        "y": 160,
                        "width": 600,
                        "height": 220,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "data": [[{
                                "text": "Cell Link",
                                "richText": '<p><a href="https://cell.example.com">Cell Link</a></p>',
                                "colspan": 1,
                                "rowspan": 1,
                            }]],
                            "colWidths": [1],
                        },
                    }
                ],
            }
        ]

        out_pages = self._roundtrip(pages)
        table_el = next(el for el in out_pages[0].get("elements", []) if el.get("type") == "table")
        cell = table_el.get("props", {}).get("data", [[]])[0][0]
        self.assertIn("richText", cell)
        self.assertIn('href="https://cell.example.com"', cell.get("richText", ""))

    def test_table_single_slide_hyperlink_cell_keeps_rich_text(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "table-rich-slide-link",
                        "type": "table",
                        "x": 120,
                        "y": 160,
                        "width": 600,
                        "height": 220,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "data": [[{
                                "text": "Cell Slide Link",
                                "richText": '<p><a href="#page-2">Cell Slide Link</a></p>',
                                "colspan": 1,
                                "rowspan": 1,
                            }]],
                            "colWidths": [1],
                        },
                    }
                ],
            },
            {
                "id": "page-2",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [],
            },
        ]

        out_pages = self._roundtrip(pages)
        table_el = next(el for el in out_pages[0].get("elements", []) if el.get("type") == "table")
        cell = table_el.get("props", {}).get("data", [[]])[0][0]
        self.assertIn("richText", cell)
        self.assertIn('href="#page-2"', cell.get("richText", ""))

    def test_shape_slide_link_roundtrip(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "shape-slide-link",
                        "type": "shape",
                        "x": 100,
                        "y": 120,
                        "width": 260,
                        "height": 120,
                        "rotate": 0,
                        "zIndex": 0,
                        "link": {"type": "slide", "target": "page-2"},
                        "props": {
                            "pptxShapeType": "roundRect",
                            "fill": "#DFF5E1",
                        },
                    }
                ],
            },
            {
                "id": "page-2",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [],
            },
        ]

        out_pages = self._roundtrip(pages)
        out_shape = next(el for el in out_pages[0].get("elements", []) if el.get("type") == "shape")
        self.assertEqual(out_shape.get("link", {}).get("type"), "slide")
        self.assertEqual(out_shape.get("link", {}).get("target"), "page-2")

    def test_text_inline_hyperlink_rejects_unsafe_scheme(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "text-unsafe-link",
                        "type": "text",
                        "x": 120,
                        "y": 120,
                        "width": 800,
                        "height": 180,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "content": '<p><a href="javascript:alert(1)">Unsafe</a> Safe</p>',
                            "defaultFontFamily": "Calibri",
                            "defaultFontSize": 18,
                            "defaultColor": "#333333",
                        },
                    }
                ],
            }
        ]

        out_pages = self._roundtrip(pages)
        text_elements = [el for el in out_pages[0]["elements"] if el.get("type") == "text"]
        self.assertEqual(len(text_elements), 1)
        content = text_elements[0].get("props", {}).get("content", "")
        self.assertNotIn("javascript:", content)
        self.assertIn("Unsafe", content)
        self.assertIn("Safe", content)

    def test_element_hyperlink_rejects_unsafe_scheme(self):
        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "shape-unsafe-link",
                        "type": "shape",
                        "x": 80,
                        "y": 80,
                        "width": 280,
                        "height": 140,
                        "rotate": 0,
                        "zIndex": 0,
                        "link": {"type": "web", "target": "javascript:alert(1)"},
                        "props": {
                            "pptxShapeType": "rect",
                            "fill": "#E8F0FF",
                        },
                    },
                ],
            }
        ]

        out_pages = self._roundtrip(pages)
        out_shape = next(el for el in out_pages[0].get("elements", []) if el.get("type") == "shape")
        self.assertNotIn("link", out_shape)
