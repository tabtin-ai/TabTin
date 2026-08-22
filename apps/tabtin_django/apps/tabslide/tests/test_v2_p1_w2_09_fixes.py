"""
V2 P1 Wave2-09 修复回归测试

- F2-04: _read_pages_from_prs slide_width/slide_height None 防护
- F3-04: _embed_fonts_into_pptx 空字体节点不得写入
- F3-06: _embed_fonts_into_pptx 过滤非 TTF/OTF 字体（WOFF/WOFF2）
"""

from __future__ import annotations

import base64
import os
import struct
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

from lxml import etree

_BASE = Path(__file__).resolve().parents[1]


# ============================================================================
# F2-04: slide_width / slide_height None 防护
# ============================================================================


class SlideWidthHeightNoneGuardTests(TestCase):
    """prs.slide_width/slide_height 为 None 时不应 TypeError。"""

    def test_source_has_default_fallback(self):
        """_read_pages_from_prs 必须对 prs.slide_width/height 使用 DEFAULT_SLIDE_*_EMU 回退。"""
        source = (_BASE / "services" / "pptx_io.py").read_text(encoding="utf-8")
        start = source.find("def _read_pages_from_prs(")
        self.assertGreater(start, 0)
        end = source.find("\ndef ", start + 10)
        func_src = source[start:end]

        self.assertIn(
            "or DEFAULT_SLIDE_WIDTH_EMU",
            func_src,
            "slide_width_emu 缺少 None 回退",
        )
        self.assertIn(
            "or DEFAULT_SLIDE_HEIGHT_EMU",
            func_src,
            "slide_height_emu 缺少 None 回退",
        )

    def test_emu_to_px_zero_guard(self):
        """验证 emu_to_px 在 slide_emu=0 时返回 0 而非除零。"""
        source = (_BASE / "services" / "pptx_io.py").read_text(encoding="utf-8")
        start = source.find("def emu_to_px(")
        self.assertGreater(start, 0)
        end = source.find("\ndef ", start + 5)
        func_src = source[start:end]
        self.assertIn("slide_emu == 0", func_src)

    def test_malformed_pptx_without_slide_size(self):
        """无 sldSz 的畸形 PPTX 导入不应 TypeError。"""
        from unittest.mock import MagicMock, patch, PropertyMock

        class FakePrs:
            slide_width = None
            slide_height = None
            slides = []
            slide_masters = []

        source = (_BASE / "services" / "pptx_io.py").read_text(encoding="utf-8")
        start = source.find("def _read_pages_from_prs(")
        self.assertGreater(start, 0)
        func_body = source[start:source.find("\ndef ", start + 10)]
        self.assertIn("or DEFAULT_SLIDE_WIDTH_EMU", func_body)
        self.assertIn("or DEFAULT_SLIDE_HEIGHT_EMU", func_body)
        self.assertNotIn("prs.slide_width\n", func_body.replace(" ", ""),
                         "slide_width 赋值未加 None 防护")


# ============================================================================
# F3-04 / F3-06: 字体嵌入节点完整性 & 格式过滤
# ============================================================================


def _make_minimal_pptx(path: str) -> None:
    """创建包含必要 OOXML 结构的最小 PPTX 以供字体嵌入测试。"""
    p_ns = "http://schemas.openxmlformats.org/presentationml/2006/main"
    r_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"

    pres = etree.Element(f"{{{p_ns}}}presentation", nsmap={
        "p": p_ns, "r": r_ns, "a": a_ns,
    })
    etree.SubElement(pres, f"{{{p_ns}}}sldMasterIdLst")
    etree.SubElement(pres, f"{{{p_ns}}}sldIdLst")
    sz = etree.SubElement(pres, f"{{{p_ns}}}sldSz")
    sz.set("cx", "12192000")
    sz.set("cy", "6858000")

    rels = etree.Element(f"{{{rels_ns}}}Relationships", nsmap={None: rels_ns})

    ct = etree.Element(f"{{{ct_ns}}}Types", nsmap={None: ct_ns})
    etree.SubElement(ct, f"{{{ct_ns}}}Default", Extension="xml",
                     ContentType="application/xml")
    etree.SubElement(ct, f"{{{ct_ns}}}Default", Extension="rels",
                     ContentType="application/vnd.openxmlformats-package.relationships+xml")

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("ppt/presentation.xml", etree.tostring(
            pres, xml_declaration=True, encoding="UTF-8", standalone=True))
        zf.writestr("ppt/_rels/presentation.xml.rels", etree.tostring(
            rels, xml_declaration=True, encoding="UTF-8", standalone=True))
        zf.writestr("[Content_Types].xml", etree.tostring(
            ct, xml_declaration=True, encoding="UTF-8", standalone=True))


def _make_fake_ttf(size: int = 256) -> bytes:
    """生成以 TTF 魔数开头的伪字体数据。"""
    return b"\x00\x01\x00\x00" + os.urandom(size - 4)


def _make_fake_otf(size: int = 256) -> bytes:
    return b"OTTO" + os.urandom(size - 4)


def _make_fake_woff(size: int = 256) -> bytes:
    return b"wOFF" + os.urandom(size - 4)


def _make_fake_woff2(size: int = 256) -> bytes:
    return b"wOF2" + os.urandom(size - 4)


def _read_embedded_font_nodes(pptx_path: str):
    """读取 PPTX 中的 embeddedFont 节点列表。"""
    p_ns = "http://schemas.openxmlformats.org/presentationml/2006/main"
    with zipfile.ZipFile(pptx_path, "r") as zf:
        pres_xml = zf.read("ppt/presentation.xml")
    root = etree.fromstring(pres_xml)
    emb_lst = root.find(f"{{{p_ns}}}embeddedFontLst")
    if emb_lst is None:
        return []
    return emb_lst.findall(f"{{{p_ns}}}embeddedFont")


def _import_embed_function():
    """动态导入 _embed_fonts_into_pptx，避免完整 Django 启动。"""
    import importlib.util
    import sys
    import types
    import unittest.mock as mock

    stub_logger = mock.MagicMock()
    stub_apps = types.ModuleType("apps")
    stub_services = types.ModuleType("apps.services")
    stub_common = types.ModuleType("apps.services.common")
    stub_url = types.ModuleType("apps.services.common.url_security")
    stub_url.validate_url_ssrf = mock.MagicMock(return_value=False)
    stub_apps.services = stub_services
    stub_services.common = stub_common
    stub_common.url_security = stub_url

    saved = {}
    for k in list(sys.modules.keys()):
        if k.startswith("apps.services.common"):
            saved[k] = sys.modules[k]

    sys.modules["apps"] = stub_apps
    sys.modules["apps.services"] = stub_services
    sys.modules["apps.services.common"] = stub_common
    sys.modules["apps.services.common.url_security"] = stub_url

    spec = importlib.util.spec_from_file_location(
        "_pptx_io_embed_test", _BASE / "services" / "pptx_io.py",
    )
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        for k, v in saved.items():
            sys.modules[k] = v
        raise
    for k, v in saved.items():
        sys.modules[k] = v

    return mod._embed_fonts_into_pptx


class FontEmbedEmptyNodeTests(TestCase):
    """F3-04: 所有 variant 加载失败时不得产生空 <p:embeddedFont> 节点。"""

    def test_no_empty_embedded_font_node_when_all_variants_fail(self):
        """传入不可解析的字体数据 → PPTX 中无空 embeddedFont 节点。"""
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            bad_fonts = [
                {"name": "FakeFont", "style": "normal", "data_base64": base64.b64encode(b"short").decode()},
            ]
            embed_fn(path, bad_fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 0, "数据不足时不应产生 embeddedFont 节点")
        finally:
            os.unlink(path)

    def test_valid_ttf_creates_node(self):
        """合法 TTF 数据 → 正常嵌入。"""
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            fonts = [
                {"name": "TestTTF", "style": "normal",
                 "data_base64": base64.b64encode(_make_fake_ttf(256)).decode()},
            ]
            embed_fn(path, fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 1)
            p_ns = "http://schemas.openxmlformats.org/presentationml/2006/main"
            font_el = nodes[0].find(f"{{{p_ns}}}font")
            self.assertEqual(font_el.get("typeface"), "TestTTF")
        finally:
            os.unlink(path)


class FontEmbedFormatFilterTests(TestCase):
    """F3-06: WOFF/WOFF2 格式字体不得写入 .fntdata。"""

    def test_woff_rejected(self):
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            fonts = [
                {"name": "WoffFont", "style": "normal",
                 "data_base64": base64.b64encode(_make_fake_woff(256)).decode()},
            ]
            embed_fn(path, fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 0, "WOFF 字体不应被嵌入")
        finally:
            os.unlink(path)

    def test_woff2_rejected(self):
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            fonts = [
                {"name": "Woff2Font", "style": "normal",
                 "data_base64": base64.b64encode(_make_fake_woff2(256)).decode()},
            ]
            embed_fn(path, fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 0, "WOFF2 字体不应被嵌入")
        finally:
            os.unlink(path)

    def test_otf_accepted(self):
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            fonts = [
                {"name": "OtfFont", "style": "normal",
                 "data_base64": base64.b64encode(_make_fake_otf(256)).decode()},
            ]
            embed_fn(path, fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 1, "OTF 字体应被正常嵌入")
        finally:
            os.unlink(path)

    def test_mixed_woff_and_ttf_only_ttf_embedded(self):
        """同一字体族中 WOFF variant 被跳过，TTF variant 正常嵌入。"""
        embed_fn = _import_embed_function()
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            _make_minimal_pptx(path)
            fonts = [
                {"name": "MixFont", "style": "normal",
                 "data_base64": base64.b64encode(_make_fake_woff(256)).decode()},
                {"name": "MixFont", "style": "bold",
                 "data_base64": base64.b64encode(_make_fake_ttf(256)).decode()},
            ]
            embed_fn(path, fonts)
            nodes = _read_embedded_font_nodes(path)
            self.assertEqual(len(nodes), 1, "应只有一个 embeddedFont 节点")
            p_ns = "http://schemas.openxmlformats.org/presentationml/2006/main"
            children = [c for c in nodes[0] if c.tag != f"{{{p_ns}}}font"]
            self.assertEqual(len(children), 1, "只应有 bold variant 被嵌入")
        finally:
            os.unlink(path)
