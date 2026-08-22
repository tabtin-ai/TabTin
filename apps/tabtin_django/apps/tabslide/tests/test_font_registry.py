"""font_registry 纯函数测试

font_registry 设计为零依赖纯模块（只用 stdlib），所以测试不依赖 Django。
"""

import importlib.util
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


# 直接 spec_from_file_location 加载，避免依赖 apps.tabslide.services.__init__ 中的 Django 引入
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "font_registry.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_font_registry_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")

font_registry = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = font_registry
_SPEC.loader.exec_module(font_registry)  # type: ignore[union-attr]


class ResolveFontAliasTests(TestCase):
    def test_alimamashuheiti_lowercase(self):
        self.assertEqual(font_registry.resolve_font_alias("alimamashuheiti"), "AlibabaPuHuiTi")

    def test_alibaba_puhuiti_chinese(self):
        self.assertEqual(font_registry.resolve_font_alias("阿里妈妈数黑体"), "AlibabaPuHuiTi")

    def test_alibaba_puhuiti_versioned(self):
        self.assertEqual(font_registry.resolve_font_alias("AlibabaPuHuiTi3.0Bold"), "AlibabaPuHuiTi")

    def test_misans_chinese_alias(self):
        self.assertEqual(font_registry.resolve_font_alias("小米兰亭"), "MiSans")

    def test_noto_sans_sc(self):
        self.assertEqual(font_registry.resolve_font_alias("Noto Sans SC"), "NotoSansSC")

    def test_system_font_returns_none(self):
        for name in ("Arial", "Helvetica", "PingFang SC", "Microsoft YaHei", "微软雅黑"):
            with self.subTest(name=name):
                self.assertIsNone(font_registry.resolve_font_alias(name))

    def test_unknown_font_returns_none(self):
        self.assertIsNone(font_registry.resolve_font_alias("UnknownFont"))

    def test_empty_returns_none(self):
        self.assertIsNone(font_registry.resolve_font_alias(""))
        self.assertIsNone(font_registry.resolve_font_alias("   "))

    def test_css_font_stack_takes_first(self):
        self.assertEqual(font_registry.resolve_font_alias("MiSans, sans-serif"), "MiSans")

    def test_strip_quotes(self):
        self.assertEqual(font_registry.resolve_font_alias("'MiSans'"), "MiSans")
        self.assertEqual(font_registry.resolve_font_alias('"MiSans"'), "MiSans")

    def test_case_insensitive_fallback(self):
        # 别名表里没 "misans"，但有 "MiSans"；走二次 lower 命中
        self.assertEqual(font_registry.resolve_font_alias("MISANS"), "MiSans")


class GetFontEmbedInfoTests(TestCase):
    def test_registered_with_oss_url_returns_info(self):
        # 临时注入一条 OSS URL 验证返回结构
        with patch.dict(
            font_registry._FONT_OSS_URLS,
            {
                "MiSans": {
                    "url": "https://example.com/fonts/MiSans-Regular.ttf",
                    "style": "normal",
                    "format": "truetype",
                }
            },
            clear=False,
        ):
            info = font_registry.get_font_embed_info("alimamashuheiti")  # canonical → AlibabaPuHuiTi
            self.assertIsNone(info)  # AlibabaPuHuiTi 这条还没注入

            info = font_registry.get_font_embed_info("MiSans")
            self.assertEqual(info, {
                "name": "MiSans",
                "oss_url": "https://example.com/fonts/MiSans-Regular.ttf",
                "style": "normal",
                "format": "truetype",
            })

    def test_system_font_returns_none(self):
        self.assertIsNone(font_registry.get_font_embed_info("Arial"))

    def test_unregistered_returns_none(self):
        self.assertIsNone(font_registry.get_font_embed_info("UnknownFont"))

    def test_registered_without_oss_url_returns_none(self):
        # 注册表里 alias 命中 AlibabaPuHuiTi，但 _FONT_OSS_URLS 默认是空的
        self.assertIsNone(font_registry.get_font_embed_info("阿里妈妈数黑体"))


class CollectUsedFontsTests(TestCase):
    def _page_with(self, *elements):
        return [{"elements": list(elements)}]

    def test_text_element_default_font_name(self):
        pages = self._page_with(
            {"type": "text", "props": {"defaultFontName": "MiSans"}},
        )
        self.assertEqual(font_registry.collect_used_fonts(pages), ["MiSans"])

    def test_default_font_family_fallback(self):
        pages = self._page_with(
            {"type": "text", "props": {"defaultFontFamily": "Inter"}},
        )
        self.assertEqual(font_registry.collect_used_fonts(pages), ["Inter"])

    def test_non_text_elements_skipped(self):
        pages = self._page_with(
            {"type": "image", "props": {"defaultFontName": "MiSans"}},
            {"type": "shape", "props": {"defaultFontName": "Inter"}},
        )
        self.assertEqual(font_registry.collect_used_fonts(pages), [])

    def test_dedup_and_sort(self):
        pages = [
            {"elements": [
                {"type": "text", "props": {"defaultFontName": "MiSans"}},
                {"type": "text", "props": {"defaultFontName": "Inter"}},
            ]},
            {"elements": [
                {"type": "text", "props": {"defaultFontName": "MiSans"}},  # dup
            ]},
        ]
        self.assertEqual(font_registry.collect_used_fonts(pages), ["Inter", "MiSans"])

    def test_inline_font_family_from_content(self):
        pages = self._page_with(
            {
                "type": "text",
                "props": {
                    "defaultFontName": "Inter",
                    "content": '<p><span style="font-family: MiSans;">你好</span></p>',
                },
            },
        )
        self.assertEqual(font_registry.collect_used_fonts(pages), ["Inter", "MiSans"])

    def test_flat_element_format_supported(self):
        # 兼容未经 _flat_element_to_props_wrapped 包装的 flat 格式
        pages = self._page_with(
            {"type": "text", "defaultFontName": "Inter"},
        )
        self.assertEqual(font_registry.collect_used_fonts(pages), ["Inter"])

    def test_empty_pages(self):
        self.assertEqual(font_registry.collect_used_fonts([]), [])
        self.assertEqual(font_registry.collect_used_fonts(None), [])

    def test_malformed_pages_safe(self):
        # 不应抛异常
        pages = [None, "not a dict", {"elements": None}, {"elements": [None, "x"]}]
        self.assertEqual(font_registry.collect_used_fonts(pages), [])


class BuildFontMetaForPagesTests(TestCase):
    def test_no_used_fonts_returns_none(self):
        self.assertIsNone(font_registry.build_font_meta_for_pages([]))

    def test_only_system_fonts_returns_none(self):
        pages = [{"elements": [
            {"type": "text", "props": {"defaultFontName": "Arial"}},
            {"type": "text", "props": {"defaultFontName": "PingFang SC"}},
        ]}]
        self.assertIsNone(font_registry.build_font_meta_for_pages(pages))

    def test_unregistered_fonts_returns_none(self):
        pages = [{"elements": [
            {"type": "text", "props": {"defaultFontName": "FooBarBaz"}},
        ]}]
        self.assertIsNone(font_registry.build_font_meta_for_pages(pages))

    def test_registered_without_oss_url_returns_none(self):
        # alias 命中但 _FONT_OSS_URLS 没有对应条目
        pages = [{"elements": [
            {"type": "text", "props": {"defaultFontName": "MiSans"}},
        ]}]
        self.assertIsNone(font_registry.build_font_meta_for_pages(pages))

    def test_registered_with_oss_url_returns_meta(self):
        pages = [{"elements": [
            {"type": "text", "props": {"defaultFontName": "MiSans"}},
            {"type": "text", "props": {"defaultFontName": "Arial"}},
            {"type": "text", "props": {"defaultFontName": "alimamashuheiti"}},
        ]}]
        with patch.dict(
            font_registry._FONT_OSS_URLS,
            {
                "MiSans": {
                    "url": "https://example.com/MiSans.ttf",
                    "style": "normal",
                    "format": "truetype",
                },
                "AlibabaPuHuiTi": {
                    "url": "https://example.com/AlibabaPuHuiTi.ttf",
                    "style": "normal",
                    "format": "truetype",
                },
            },
            clear=False,
        ):
            meta = font_registry.build_font_meta_for_pages(pages)
            self.assertIsNotNone(meta)
            names = sorted(e["name"] for e in meta["embedded_fonts"])
            self.assertEqual(names, ["AlibabaPuHuiTi", "MiSans"])
            for entry in meta["embedded_fonts"]:
                self.assertIn("oss_url", entry)
                self.assertEqual(entry["style"], "normal")
                self.assertEqual(entry["format"], "truetype")

    def test_canonical_dedup(self):
        # 同一个 canonical 不同写法（alimamashuheiti / 阿里妈妈数黑体 / AlibabaPuHuiTi）应去重为 1 条
        pages = [{"elements": [
            {"type": "text", "props": {"defaultFontName": "alimamashuheiti"}},
            {"type": "text", "props": {"defaultFontName": "阿里妈妈数黑体"}},
            {"type": "text", "props": {"defaultFontName": "AlibabaPuHuiTi"}},
        ]}]
        with patch.dict(
            font_registry._FONT_OSS_URLS,
            {
                "AlibabaPuHuiTi": {
                    "url": "https://example.com/AlibabaPuHuiTi.ttf",
                    "style": "normal",
                    "format": "truetype",
                },
            },
            clear=False,
        ):
            meta = font_registry.build_font_meta_for_pages(pages)
            self.assertIsNotNone(meta)
            self.assertEqual(len(meta["embedded_fonts"]), 1)
            self.assertEqual(meta["embedded_fonts"][0]["name"], "AlibabaPuHuiTi")
