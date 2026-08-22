import importlib.util
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

from lxml import etree

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_layer_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write

_NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"


class TestPptxLayerChain(TestCase):
    def _new_tmp_pptx_path(self) -> str:
        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        return pptx_path

    def _count_group_nodes(self, pptx_path: str, slide_no: int = 1) -> int:
        with zipfile.ZipFile(pptx_path, "r") as zf:
            xml_bytes = zf.read(f"ppt/slides/slide{slide_no}.xml")
        doc = etree.fromstring(xml_bytes)
        groups = doc.findall(f".//{{{_NS_P}}}grpSp")
        return len(groups)

    def _get_group_names(self, pptx_path: str, slide_no: int = 1) -> list[str]:
        with zipfile.ZipFile(pptx_path, "r") as zf:
            xml_bytes = zf.read(f"ppt/slides/slide{slide_no}.xml")
        doc = etree.fromstring(xml_bytes)
        names: list[str] = []
        for node in doc.findall(f".//{{{_NS_P}}}grpSp/{{{_NS_P}}}nvGrpSpPr/{{{_NS_P}}}cNvPr"):
            raw = node.get("name")
            if raw:
                names.append(str(raw))
        return names

    def _get_text_content(self, element: dict) -> str:
        props = element.get("props") or {}
        raw = props.get("content")
        return str(raw) if raw is not None else ""

    def test_write_read_hidden_text_preserves_visible_and_z_order(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "txt-bottom",
                        "type": "text",
                        "x": 80,
                        "y": 80,
                        "width": 260,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 0,
                        "props": {
                            "content": "<p>Layer-Bottom-L0</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 22,
                            "defaultColor": "#222222",
                        },
                    },
                    {
                        "id": "txt-hidden",
                        "type": "text",
                        "x": 120,
                        "y": 120,
                        "width": 280,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 1,
                        "visible": False,
                        "props": {
                            "content": "<p>Layer-Hidden-L1</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 22,
                            "defaultColor": "#222222",
                        },
                    },
                    {
                        "id": "txt-top",
                        "type": "text",
                        "x": 160,
                        "y": 160,
                        "width": 260,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 2,
                        "props": {
                            "content": "<p>Layer-Top-L2</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 22,
                            "defaultColor": "#222222",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        pptx_path = self._new_tmp_pptx_path()
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            self.assertEqual(len(out_pages), 1)
            out_elements = out_pages[0]["elements"]
            self.assertEqual(len(out_elements), 3)

            self.assertEqual([el.get("zIndex") for el in out_elements], [0, 1, 2])

            hidden_el = next(
                el for el in out_elements if "Layer-Hidden-L1" in self._get_text_content(el)
            )
            self.assertFalse(hidden_el.get("visible", True))
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_read_contiguous_group_with_hidden_member_keeps_group_and_hidden(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "txt-g-a",
                        "type": "text",
                        "x": 100,
                        "y": 100,
                        "width": 240,
                        "height": 68,
                        "rotate": 0,
                        "zIndex": 0,
                        "groupId": "g-layer",
                        "props": {
                            "content": "<p>Group-Layer-A</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                    {
                        "id": "txt-g-hidden",
                        "type": "text",
                        "x": 170,
                        "y": 170,
                        "width": 260,
                        "height": 68,
                        "rotate": 0,
                        "zIndex": 1,
                        "groupId": "g-layer",
                        "visible": False,
                        "props": {
                            "content": "<p>Group-Layer-B-Hidden</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                    {
                        "id": "txt-free",
                        "type": "text",
                        "x": 540,
                        "y": 130,
                        "width": 240,
                        "height": 68,
                        "rotate": 0,
                        "zIndex": 2,
                        "props": {
                            "content": "<p>Layer-Free-Top</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        pptx_path = self._new_tmp_pptx_path()
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=1920, canvas_height=1080)
            self.assertGreaterEqual(self._count_group_nodes(pptx_path), 1)

            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_elements = out_pages[0]["elements"]

            grouped = [el for el in out_elements if el.get("groupId")]
            self.assertEqual(len(grouped), 2)
            self.assertEqual(len({el.get("groupId") for el in grouped}), 1)

            hidden_group_member = next(
                el for el in grouped if "Group-Layer-B-Hidden" in self._get_text_content(el)
            )
            self.assertFalse(hidden_group_member.get("visible", True))
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_non_contiguous_hidden_group_falls_back_flat_and_keeps_hidden(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "txt-g-a-hidden",
                        "type": "text",
                        "x": 80,
                        "y": 100,
                        "width": 240,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 0,
                        "groupId": "g-fallback",
                        "visible": False,
                        "props": {
                            "content": "<p>Group-Fallback-Hidden-A</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                    {
                        "id": "txt-mid",
                        "type": "text",
                        "x": 360,
                        "y": 100,
                        "width": 240,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 1,
                        "props": {
                            "content": "<p>Group-Fallback-Middle</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                    {
                        "id": "txt-g-b",
                        "type": "text",
                        "x": 640,
                        "y": 100,
                        "width": 240,
                        "height": 70,
                        "rotate": 0,
                        "zIndex": 2,
                        "groupId": "g-fallback",
                        "props": {
                            "content": "<p>Group-Fallback-B</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 20,
                            "defaultColor": "#111111",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        pptx_path = self._new_tmp_pptx_path()
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=1920, canvas_height=1080)
            self.assertEqual(self._count_group_nodes(pptx_path), 0)

            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_elements = out_pages[0]["elements"]
            self.assertEqual(len(out_elements), 3)
            self.assertTrue(all(not el.get("groupId") for el in out_elements))

            hidden_el = next(
                el for el in out_elements if "Group-Fallback-Hidden-A" in self._get_text_content(el)
            )
            self.assertFalse(hidden_el.get("visible", True))
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_write_read_group_name_preserved(self):
        pages = [
            {
                "id": "page-1",
                "elements": [
                    {
                        "id": "txt-g-name-a",
                        "type": "text",
                        "x": 110,
                        "y": 120,
                        "width": 220,
                        "height": 64,
                        "rotate": 0,
                        "zIndex": 0,
                        "groupId": "g-name",
                        "groupName": "核心流程组",
                        "props": {
                            "content": "<p>Group-Name-A</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 18,
                            "defaultColor": "#222222",
                        },
                    },
                    {
                        "id": "txt-g-name-b",
                        "type": "text",
                        "x": 360,
                        "y": 120,
                        "width": 220,
                        "height": 64,
                        "rotate": 0,
                        "zIndex": 1,
                        "groupId": "g-name",
                        "groupName": "核心流程组",
                        "props": {
                            "content": "<p>Group-Name-B</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 18,
                            "defaultColor": "#222222",
                        },
                    },
                    {
                        "id": "txt-solo",
                        "type": "text",
                        "x": 640,
                        "y": 200,
                        "width": 220,
                        "height": 64,
                        "rotate": 0,
                        "zIndex": 2,
                        "props": {
                            "content": "<p>Group-Name-Solo</p>",
                            "defaultFontFamily": "Microsoft YaHei",
                            "defaultFontSize": 18,
                            "defaultColor": "#222222",
                        },
                    },
                ],
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            },
        ]

        pptx_path = self._new_tmp_pptx_path()
        try:
            write(pages=pages, output_path=pptx_path, canvas_width=1920, canvas_height=1080)
            self.assertGreaterEqual(self._count_group_nodes(pptx_path), 1)
            self.assertIn("核心流程组", self._get_group_names(pptx_path))

            out_pages = read(pptx_path=pptx_path, canvas_width=1920, canvas_height=1080)
            out_elements = out_pages[0]["elements"]
            grouped = [el for el in out_elements if el.get("groupId")]
            self.assertEqual(len(grouped), 2)
            self.assertEqual({el.get("groupName") for el in grouped}, {"核心流程组"})
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass
