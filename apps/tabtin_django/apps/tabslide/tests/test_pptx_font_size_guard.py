"""
IE-014 回归测试 — extract_embedded_fonts 大文件预检

验证：在 ZipInfo.file_size 阶段即拦截超限字体，不读入内存。
"""

import base64
import importlib.util
import os
import tempfile
import uuid
import zipfile
from pathlib import Path
from unittest import TestCase, mock

from lxml import etree

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_font_size_guard_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

extract_embedded_fonts = _PPTX_IO.extract_embedded_fonts
MAX_SINGLE_FONT_RAW_SIZE = _PPTX_IO.MAX_SINGLE_FONT_RAW_SIZE

_P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


def _make_fake_ttf(size: int = 256) -> bytes:
    header = b"\x00\x01\x00\x00"
    return header + os.urandom(max(0, size - 4))


def _build_pptx_with_embedded_font(
    output_path: str,
    font_name: str,
    font_data: bytes,
    *,
    style_tag: str = "p:regular",
) -> None:
    """构造一个含嵌入字体的最小合法 PPTX ZIP。"""
    guid = str(uuid.uuid4()).upper()
    fntdata_path = f"ppt/fonts/{{{guid}}}.fntdata"
    rid = "rId100"

    pres_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:presentation xmlns:p="{_P_NS}" xmlns:a="{_A_NS}" xmlns:r="{_R_NS}">'
        f'<p:embeddedFontLst>'
        f'<p:embeddedFont>'
        f'<p:font typeface="{font_name}"/>'
        f'<{style_tag} r:embed="{rid}"/>'
        f'</p:embeddedFont>'
        f'</p:embeddedFontLst>'
        f'</p:presentation>'
    )

    rels_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{_REL_NS}">'
        f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/{{{guid}}}.fntdata"/>'
        f'</Relationships>'
    )

    ct_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Types xmlns="{_CT_NS}">'
        f'<Default Extension="xml" ContentType="application/xml"/>'
        f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        f'<Default Extension="fntdata" ContentType="application/x-fontdata"/>'
        f'</Types>'
    )

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("ppt/presentation.xml", pres_xml)
        zf.writestr("ppt/_rels/presentation.xml.rels", rels_xml)
        zf.writestr("[Content_Types].xml", ct_xml)
        zf.writestr(fntdata_path, font_data)


class TestFontSizeGuard(TestCase):
    """IE-014: 超限字体在读入内存前即被拦截。"""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_normal_font_extracted(self):
        """正常大小字体应正常提取。"""
        pptx_path = os.path.join(self._tmpdir, "normal.pptx")
        font_data = _make_fake_ttf(512)
        _build_pptx_with_embedded_font(pptx_path, "NormalFont", font_data)

        fonts = extract_embedded_fonts(pptx_path)
        self.assertEqual(len(fonts), 1)
        self.assertEqual(fonts[0]["name"], "NormalFont")

    def test_oversized_font_skipped(self):
        """超过 MAX_SINGLE_FONT_RAW_SIZE 的字体不读入内存，直接跳过。"""
        pptx_path = os.path.join(self._tmpdir, "big.pptx")
        oversized = _make_fake_ttf(MAX_SINGLE_FONT_RAW_SIZE + 1024)
        _build_pptx_with_embedded_font(pptx_path, "HugeFont", oversized)

        fonts = extract_embedded_fonts(pptx_path)
        self.assertEqual(len(fonts), 0, "超限字体应被跳过")

    def test_oversized_font_not_read_into_memory(self):
        """确认超限字体不调用 zf.read()，避免内存峰值。"""
        pptx_path = os.path.join(self._tmpdir, "big2.pptx")
        oversized = _make_fake_ttf(MAX_SINGLE_FONT_RAW_SIZE + 2048)
        _build_pptx_with_embedded_font(pptx_path, "MemTest", oversized)

        original_open = zipfile.ZipFile

        class TrackedZipFile(zipfile.ZipFile):
            read_calls: list = []

            def read(self, name, pwd=None):
                TrackedZipFile.read_calls.append(name)
                return super().read(name, pwd)

        TrackedZipFile.read_calls = []

        with mock.patch("zipfile.ZipFile", TrackedZipFile):
            fonts = extract_embedded_fonts(pptx_path)

        font_data_reads = [
            c for c in TrackedZipFile.read_calls if "fntdata" in str(c)
        ]
        self.assertEqual(font_data_reads, [], "不应读取超限字体的 fntdata 文件")

    def test_boundary_size_font_accepted(self):
        """恰好等于上限的字体应能提取。"""
        pptx_path = os.path.join(self._tmpdir, "boundary.pptx")
        boundary = _make_fake_ttf(MAX_SINGLE_FONT_RAW_SIZE)
        _build_pptx_with_embedded_font(pptx_path, "BoundaryFont", boundary)

        fonts = extract_embedded_fonts(pptx_path)
        self.assertEqual(len(fonts), 1)
        self.assertEqual(fonts[0]["name"], "BoundaryFont")
