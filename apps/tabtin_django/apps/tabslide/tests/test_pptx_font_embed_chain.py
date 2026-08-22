"""
PPTX 字体嵌入回归测试 — G1-01 修复验证

验证 write() 的 font_meta 参数能将嵌入字体正确写入 PPTX，
并可通过 extract_embedded_fonts() 往返读回。
"""

import base64
import importlib.util
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

from lxml import etree

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_font_embed_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

write = _PPTX_IO.write
extract_embedded_fonts = _PPTX_IO.extract_embedded_fonts
_embed_fonts_into_pptx = _PPTX_IO._embed_fonts_into_pptx
_resolve_font_data_for_embed = _PPTX_IO._resolve_font_data_for_embed


def _make_fake_ttf(size: int = 256) -> bytes:
    """生成带有 TrueType 魔术字节的伪字体数据。"""
    header = b"\x00\x01\x00\x00"
    return header + os.urandom(size - 4)


class TestResolveFontData(TestCase):
    """验证 _resolve_font_data_for_embed 能正确解码 base64 数据。"""

    def test_base64_decode(self):
        raw = _make_fake_ttf(64)
        entry = {"name": "TestFont", "data_base64": base64.b64encode(raw).decode()}
        result = _resolve_font_data_for_embed(entry)
        self.assertEqual(result, raw)

    def test_empty_entry_returns_none(self):
        result = _resolve_font_data_for_embed({"name": "TestFont"})
        self.assertIsNone(result)

    def test_bad_base64_returns_none(self):
        result = _resolve_font_data_for_embed({"name": "X", "data_base64": "!!!invalid!!!"})
        self.assertIsNone(result)


class TestWriteWithFontMeta(TestCase):
    """验证 write() + font_meta 端到端嵌入字体。"""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        self._output_path = os.path.join(self._tmpdir, "test_output.pptx")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _minimal_pages(self) -> list:
        return [{"id": "page1", "elements": []}]

    def test_write_without_font_meta_produces_valid_pptx(self):
        write(self._minimal_pages(), self._output_path)
        self.assertTrue(os.path.exists(self._output_path))
        fonts = extract_embedded_fonts(self._output_path)
        self.assertEqual(fonts, [])

    def test_write_with_font_meta_embeds_font(self):
        fake_ttf = _make_fake_ttf(256)
        font_meta = {
            "embedded_fonts": [
                {
                    "name": "TestFont",
                    "style": "normal",
                    "format": "truetype",
                    "data_base64": base64.b64encode(fake_ttf).decode(),
                },
            ],
            "theme_fonts": {},
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        extracted = extract_embedded_fonts(self._output_path)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0]["name"], "TestFont")
        self.assertEqual(extracted[0]["style"], "normal")
        self.assertEqual(extracted[0]["format"], "truetype")

        recovered = base64.b64decode(extracted[0]["data_base64"])
        self.assertEqual(recovered, fake_ttf)

    def test_write_with_multiple_styles(self):
        regular = _make_fake_ttf(128)
        bold = _make_fake_ttf(128)
        font_meta = {
            "embedded_fonts": [
                {"name": "MultiStyle", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(regular).decode()},
                {"name": "MultiStyle", "style": "bold", "format": "truetype",
                 "data_base64": base64.b64encode(bold).decode()},
            ],
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        extracted = extract_embedded_fonts(self._output_path)
        self.assertEqual(len(extracted), 2)
        names = {(f["name"], f["style"]) for f in extracted}
        self.assertIn(("MultiStyle", "normal"), names)
        self.assertIn(("MultiStyle", "bold"), names)

    def test_write_with_multiple_fonts(self):
        font_a = _make_fake_ttf(128)
        font_b = _make_fake_ttf(128)
        font_meta = {
            "embedded_fonts": [
                {"name": "FontA", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(font_a).decode()},
                {"name": "FontB", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(font_b).decode()},
            ],
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        extracted = extract_embedded_fonts(self._output_path)
        self.assertEqual(len(extracted), 2)
        font_names = {f["name"] for f in extracted}
        self.assertEqual(font_names, {"FontA", "FontB"})

    def test_write_skips_invalid_entries(self):
        good = _make_fake_ttf(128)
        font_meta = {
            "embedded_fonts": [
                {"name": "", "style": "normal", "data_base64": "bad"},
                {"name": "Good", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(good).decode()},
                {"name": "NoData", "style": "bold"},
                "not_a_dict",
            ],
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        extracted = extract_embedded_fonts(self._output_path)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0]["name"], "Good")

    def test_pptx_structure_after_embed(self):
        """验证 OOXML ZIP 结构中包含必需的字体声明。"""
        fake_ttf = _make_fake_ttf(256)
        font_meta = {
            "embedded_fonts": [
                {"name": "StructTest", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(fake_ttf).decode()},
            ],
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        with zipfile.ZipFile(self._output_path, "r") as zf:
            namelist = zf.namelist()

            font_files = [n for n in namelist if n.startswith("ppt/fonts/") and n.endswith(".fntdata")]
            self.assertEqual(len(font_files), 1)

            pres_xml = etree.parse(zf.open("ppt/presentation.xml"))
            nsmap = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main"}
            emb_fonts = pres_xml.findall(".//p:embeddedFontLst/p:embeddedFont", nsmap)
            self.assertEqual(len(emb_fonts), 1)

            font_elem = emb_fonts[0].find("p:font", nsmap)
            self.assertEqual(font_elem.get("typeface"), "StructTest")

            rels_xml = etree.parse(zf.open("ppt/_rels/presentation.xml.rels"))
            font_rels = [
                r for r in rels_xml.iter()
                if r.get("Type", "").endswith("/font")
            ]
            self.assertEqual(len(font_rels), 1)

            ct_xml = etree.parse(zf.open("[Content_Types].xml"))
            fntdata_defaults = [
                el for el in ct_xml.iter()
                if el.get("Extension") == "fntdata"
            ]
            self.assertGreaterEqual(len(fntdata_defaults), 1)

            # ：内嵌字体必须置 embedTrueTypeFonts="1"，否则包自相矛盾
            # （embeddedFontLst 存在但默认标志说未内嵌），打开方判定损坏/闪退。
            pres_root = pres_xml.getroot()
            self.assertEqual(pres_root.get("embedTrueTypeFonts"), "1")
            self.assertEqual(pres_root.get("saveSubsetFonts"), "0")

    def test_embedded_fntdata_is_raw_not_obfuscated(self):
        """ 回归：内嵌 .fntdata 必须是原始 TTF/OTF 字节，不得 XOR 混淆。

        此前对内嵌字体做 OOXML/Word 式 XOR 混淆，破坏 sfnt 头 32 字节，导致
        PowerPoint/Keynote/WPS 打开导出的 pptx 时解析内嵌字体崩溃。此处直接对比
        zip 内 fntdata 字节与原始字节应完全一致（尤其头部未被改写）。
        """
        raw = _make_fake_ttf(512)
        font_meta = {
            "embedded_fonts": [
                {"name": "RawCheck", "style": "normal", "format": "truetype",
                 "data_base64": base64.b64encode(raw).decode()},
            ],
        }

        write(self._minimal_pages(), self._output_path, font_meta=font_meta)

        with zipfile.ZipFile(self._output_path, "r") as zf:
            font_files = [n for n in zf.namelist() if n.startswith("ppt/fonts/")]
            self.assertEqual(len(font_files), 1)
            stored = zf.read(font_files[0])

        self.assertEqual(stored, raw)
        self.assertEqual(stored[:4], b"\x00\x01\x00\x00")

    def test_none_font_meta_is_noop(self):
        write(self._minimal_pages(), self._output_path, font_meta=None)
        fonts = extract_embedded_fonts(self._output_path)
        self.assertEqual(fonts, [])

    def test_empty_embedded_fonts_is_noop(self):
        write(self._minimal_pages(), self._output_path, font_meta={"embedded_fonts": []})
        fonts = extract_embedded_fonts(self._output_path)
        self.assertEqual(fonts, [])
