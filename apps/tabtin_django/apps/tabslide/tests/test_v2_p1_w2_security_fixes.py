"""
V2 P1 Wave-2 安全修复回归测试

- I4-04: defusedxml 硬依赖（XXE 防护）
- I4-05: _sanitize_slide_html 阻断 vbscript: 协议
- I4-06: _sanitize_slide_html 阻断 data: URI 脚本
- I4-07: _sanitize_slide_html 阻断内嵌 SVG 脚本
- I4-08: _sanitize_elements_data 净化 URL 类字段
- I4-09: _sanitize_elements_data 移除 type=='text' 门控
- I4-11: pack.py 相对导入修复
"""

from __future__ import annotations

import copy
import importlib
import importlib.util
import sys
import types
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]


def _load_module(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ============================================================================
# I4-04: defusedxml 硬依赖
# ============================================================================


class DefusedxmlHardDependencyTests(TestCase):
    """所有 editing 模块必须直接 import defusedxml，不允许 fallback。"""

    EDITING_DIR = _BASE / "services" / "editing"

    MODULES = [
        "validate.py",
        "clean.py",
        "pack.py",
        "unpack.py",
        "slide_ops.py",
        "template_fill.py",
    ]

    def test_no_importerror_fallback(self):
        """确认所有 editing 模块源码中不含 defusedxml ImportError 回退。"""
        for mod_name in self.MODULES:
            path = self.EDITING_DIR / mod_name
            source = path.read_text(encoding="utf-8")
            self.assertNotIn(
                "except ImportError",
                source,
                f"{mod_name} 仍包含 'except ImportError' 回退到 stdlib XML",
            )

    def test_defusedxml_importable(self):
        """defusedxml 必须已安装。"""
        import defusedxml  # noqa: F401
        import defusedxml.minidom  # noqa: F401

    def test_defusedxml_in_requirements(self):
        """requirements.txt 必须声明 defusedxml。"""
        req_path = _BASE.parents[1] / "requirements.txt"
        content = req_path.read_text(encoding="utf-8")
        self.assertIn("defusedxml", content)

    def test_editing_modules_use_defusedxml(self):
        """加载 editing 模块应成功且使用 defusedxml 而非 stdlib。"""
        import defusedxml
        mod = _load_module(
            "test_validate_defused",
            self.EDITING_DIR / "validate.py",
        )
        ET = getattr(mod, "ET", None)
        if ET is not None:
            self.assertTrue(
                ET.__name__.startswith("defusedxml")
                or getattr(ET, "__module__", "").startswith("defusedxml"),
                "validate.py 的 ET 不是来自 defusedxml",
            )


# ============================================================================
# I4-05: vbscript: 协议阻断
# ============================================================================


class SanitizeVbscriptTests(TestCase):
    """_sanitize_slide_html 必须阻断 vbscript: 协议。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_slide_html
        cls.sanitize = staticmethod(_sanitize_slide_html)

    def test_vbscript_double_quote(self):
        result = self.sanitize('<a href="vbscript:MsgBox(1)">click</a>')
        self.assertNotIn("vbscript:", result.lower())

    def test_vbscript_single_quote(self):
        result = self.sanitize("<a href='vbscript:MsgBox(1)'>click</a>")
        self.assertNotIn("vbscript:", result.lower())

    def test_vbscript_no_quote(self):
        result = self.sanitize('<a href=vbscript:MsgBox(1)>click</a>')
        self.assertNotIn("vbscript:", result.lower())

    def test_vbscript_mixed_case(self):
        result = self.sanitize('<a href="VbScript:MsgBox(1)">click</a>')
        self.assertNotIn("vbscript:", result.lower())

    def test_vbscript_src_attr(self):
        result = self.sanitize('<img src="vbscript:run()">')
        self.assertNotIn("vbscript:", result.lower())


# ============================================================================
# I4-06: data: URI 脚本阻断
# ============================================================================


class SanitizeDataUriTests(TestCase):
    """_sanitize_slide_html 必须阻断 data: URI 脚本注入。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_slide_html
        cls.sanitize = staticmethod(_sanitize_slide_html)

    def test_data_uri_html_script(self):
        result = self.sanitize(
            '<a href="data:text/html,<script>alert(1)</script>">x</a>'
        )
        self.assertNotIn("data:", result.lower())

    def test_data_uri_iframe(self):
        result = self.sanitize(
            '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'
        )
        self.assertNotIn("data:", result.lower())

    def test_data_uri_single_quote(self):
        result = self.sanitize(
            "<a href='data:text/html,<script>alert(1)</script>'>x</a>"
        )
        self.assertNotIn("data:", result.lower())

    def test_data_uri_no_quote(self):
        result = self.sanitize(
            '<a href=data:text/html,<script>alert(1)</script>>x</a>'
        )
        self.assertNotIn("data:text/html", result.lower())

    def test_data_image_preserved_in_safe_context(self):
        """data:image/png base64 不在属性中时应保留原文（不匹配 attr= 模式）。"""
        text = "Image data:image/png;base64,abc123 here"
        result = self.sanitize(text)
        self.assertIn("data:image/png", result)


# ============================================================================
# I4-07: SVG 内嵌脚本阻断
# ============================================================================


class SanitizeSvgScriptTests(TestCase):
    """_sanitize_slide_html 必须阻断内嵌 SVG 中的脚本。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_slide_html
        cls.sanitize = staticmethod(_sanitize_slide_html)

    def test_svg_script_block(self):
        result = self.sanitize('<svg><script>alert(1)</script></svg>')
        self.assertNotIn("<script>", result)
        self.assertNotIn("<svg", result)

    def test_svg_with_event_handler(self):
        result = self.sanitize(
            '<svg onload="alert(1)"><circle r="10"/></svg>'
        )
        self.assertNotIn("<svg", result)

    def test_svg_with_xlink_href(self):
        result = self.sanitize(
            '<svg><a xlink:href="javascript:alert(1)">x</a></svg>'
        )
        self.assertNotIn("<svg", result)

    def test_nested_svg_removed(self):
        result = self.sanitize(
            '<div>Before<svg xmlns="http://www.w3.org/2000/svg">'
            '<script>document.cookie</script></svg>After</div>'
        )
        self.assertNotIn("<svg", result)
        self.assertNotIn("<script>", result)
        self.assertIn("Before", result)
        self.assertIn("After", result)

    def test_safe_html_preserved(self):
        safe = '<p><strong>Bold</strong> and <em>italic</em></p>'
        result = self.sanitize(safe)
        self.assertEqual(result, safe)


# ============================================================================
# I4-08: URL 字段净化
# ============================================================================


class SanitizeElementsUrlFieldsTests(TestCase):
    """_sanitize_elements_data 必须净化 URL 类字段中的危险协议。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_elements_data
        cls.sanitize = staticmethod(_sanitize_elements_data)

    def test_javascript_src_neutralized(self):
        elements = [{"type": "image", "src": "javascript:alert(1)"}]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["src"], "#")

    def test_vbscript_href_neutralized(self):
        elements = [{"type": "text", "href": "vbscript:MsgBox(1)"}]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["href"], "#")

    def test_data_uri_link_neutralized(self):
        elements = [{"type": "shape", "link": "data:text/html,<script>alert(1)</script>"}]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["link"], "#")

    def test_safe_url_preserved(self):
        elements = [{"type": "image", "src": "https://cdn.example.com/img.png"}]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["src"], "https://cdn.example.com/img.png")

    def test_props_url_fields_sanitized(self):
        elements = [{"type": "image", "props": {"src": "javascript:alert(1)"}}]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["props"]["src"], "#")

    def test_nested_group_url_sanitized(self):
        elements = [{
            "type": "group",
            "elements": [
                {"type": "image", "src": "javascript:evil()"}
            ],
        }]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["elements"][0]["src"], "#")


# ============================================================================
# I4-09: 移除 type=='text' 门控
# ============================================================================


class SanitizeNonTextContentTests(TestCase):
    """_sanitize_elements_data 必须对所有元素类型的 content 做净化。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_elements_data
        cls.sanitize = staticmethod(_sanitize_elements_data)

    def test_html_type_content_sanitized(self):
        elements = [{
            "type": "html",
            "content": '<script>alert(1)</script><p>OK</p>',
        }]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertNotIn("<script>", result[0]["content"])
        self.assertIn("OK", result[0]["content"])

    def test_code_type_content_sanitized(self):
        elements = [{
            "type": "code",
            "content": '<img onerror="alert(1)" src=x>',
        }]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertNotIn("onerror", result[0]["content"])

    def test_shape_type_content_sanitized(self):
        elements = [{
            "type": "shape",
            "content": '<svg><script>alert(1)</script></svg>',
        }]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertNotIn("<script>", result[0]["content"])
        self.assertNotIn("<svg", result[0]["content"])

    def test_text_type_still_sanitized(self):
        elements = [{
            "type": "text",
            "content": '<script>alert(1)</script>OK',
        }]
        result = self.sanitize(copy.deepcopy(elements))
        self.assertNotIn("<script>", result[0]["content"])
        self.assertIn("OK", result[0]["content"])

    def test_type_without_content_untouched(self):
        elements = [{"type": "image", "src": "https://img.com/a.png"}]
        original = copy.deepcopy(elements)
        result = self.sanitize(copy.deepcopy(elements))
        self.assertEqual(result[0]["type"], original[0]["type"])
        self.assertEqual(result[0]["src"], original[0]["src"])


# ============================================================================
# I4-11: pack.py 相对导入修复
# ============================================================================


class PackRelativeImportTests(TestCase):
    """pack.py 必须使用 .validate 相对导入，不能用脚本级 bare import。"""

    def test_no_bare_validate_import(self):
        path = _BASE / "services" / "editing" / "pack.py"
        source = path.read_text(encoding="utf-8")
        self.assertNotIn(
            "from validate import",
            source,
            "pack.py 仍包含 bare 'from validate import'",
        )
        self.assertIn(".validate", source)

    def test_no_silent_importerror_swallow(self):
        path = _BASE / "services" / "editing" / "pack.py"
        source = path.read_text(encoding="utf-8")
        self.assertNotIn(
            "except ImportError",
            source,
            "pack.py 仍静默吞掉 ImportError",
        )
