"""：Keynote/macOS 兼容清洗回归。

python-pptx 输出在 PowerPoint/LibreOffice 能开，但 Apple Keynote 会因三处 OOXML 结构
直接"文件格式无效"拒绝导入。write() 末尾的 _sanitize_pptx_for_keynote 必须修掉它们。
"""

import importlib.util
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_keynote_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

write = _PPTX_IO.write


class TestKeynoteSanitize(TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._out = os.path.join(self._tmp, "out.pptx")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_widescreen(self):
        pages = [{
            "id": "p1", "width": 1280, "height": 720,
            "elements": [{
                "id": "t1", "type": "text", "x": 100, "y": 100, "width": 600, "height": 120,
                "props": {"content": "<p>Keynote 兼容测试</p>"},
            }],
        }]
        write(pages, self._out, canvas_width=1280, canvas_height=720, font_meta=None)

    def test_no_printer_settings(self):
        self._write_widescreen()
        with zipfile.ZipFile(self._out) as z:
            names = z.namelist()
            self.assertEqual([n for n in names if "printerSettings" in n], [])
            ct = z.read("[Content_Types].xml").decode()
            self.assertNotIn("printerSettings", ct)

    def test_sldsz_has_no_contradictory_type(self):
        # 16:9 尺寸不得再带 type="screen4x3"
        self._write_widescreen()
        with zipfile.ZipFile(self._out) as z:
            pres = z.read("ppt/presentation.xml").decode()
        import re
        m = re.search(r"<p:sldSz[^/]*/>", pres)
        self.assertIsNotNone(m)
        el = m.group(0)
        cx = int(re.search(r'cx="(\d+)"', el).group(1))
        cy = int(re.search(r'cy="(\d+)"', el).group(1))
        if abs(cx - 12192000) <= 60000 and abs(cy - 6858000) <= 60000:
            self.assertNotIn("screen4x3", el)

    def test_notes_master_id_lst_present_when_rel_exists(self):
        self._write_widescreen()
        with zipfile.ZipFile(self._out) as z:
            rels = z.read("ppt/_rels/presentation.xml.rels").decode()
            pres = z.read("ppt/presentation.xml").decode()
        if "notesMaster" in rels:
            self.assertIn("<p:notesMasterIdLst", pres)

    def test_sanitize_is_idempotent(self):
        self._write_widescreen()
        _PPTX_IO._sanitize_pptx_for_keynote(self._out)  # second pass
        with zipfile.ZipFile(self._out) as z:
            pres = z.read("ppt/presentation.xml").decode()
            self.assertLessEqual(pres.count("<p:notesMasterIdLst"), 1)
            self.assertEqual(
                [n for n in z.namelist() if "printerSettings" in n], []
            )
