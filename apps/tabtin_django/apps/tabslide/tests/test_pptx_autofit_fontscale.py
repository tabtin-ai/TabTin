"""：导出时预算 normAutofit fontScale 回归。

不内嵌字体后，缺字机器回退更宽字体会让紧凑单行标题换行跑版；WPS/PowerPoint 打开不重算
autofit，故必须在导出时把 fontScale 算好写死。仅对「本来一行放得下、回退加宽才超行」的
单行文字温和缩放，多行/宽松文字不动。
"""

import importlib.util
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_autofit_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

write = _PPTX_IO.write
A = "http://schemas.openxmlformats.org/drawingml/2006/main"


class TestAutofitFontScale(TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._out = os.path.join(self._tmp, "out.pptx")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _scales(self):
        from lxml import etree
        vals = []
        with zipfile.ZipFile(self._out) as z:
            for n in z.namelist():
                if n.startswith("ppt/slides/slide") and n.endswith(".xml"):
                    root = etree.fromstring(z.read(n))
                    for na in root.iter(f"{{{A}}}normAutofit"):
                        vals.append(na.get("fontScale"))
        return vals

    def test_tight_single_line_gets_shrunk(self):
        # 一个很窄的框里放一行较长中文标题 → 本来一行刚好，回退加宽会超行 → 应缩放
        pages = [{
            "id": "p1", "width": 1280, "height": 720,
            "elements": [{
                "id": "t1", "type": "text", "x": 40, "y": 40, "width": 300, "height": 60,
                "props": {"content": "<p>持续不断记录意义自</p>",
                          "defaultFontSize": 24},
            }],
        }]
        write(pages, self._out, canvas_width=1280, canvas_height=720, font_meta=None)
        scales = self._scales()
        self.assertTrue(any(s is not None for s in scales))
        for s in scales:
            if s is not None:
                self.assertLess(int(s), 100000)
                self.assertGreaterEqual(int(s), 50000)

    def test_loose_text_not_shrunk(self):
        # 宽框里放很短文字 → 远放得下 → 不应缩放
        pages = [{
            "id": "p1", "width": 1280, "height": 720,
            "elements": [{
                "id": "t1", "type": "text", "x": 40, "y": 40, "width": 1000, "height": 200,
                "props": {"content": "<p>Hi</p>", "defaultFontSize": 18},
            }],
        }]
        write(pages, self._out, canvas_width=1280, canvas_height=720, font_meta=None)
        for s in self._scales():
            self.assertIsNone(s)
