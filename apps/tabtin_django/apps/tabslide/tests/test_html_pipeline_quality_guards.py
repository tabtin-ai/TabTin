import importlib.util
import sys
import types
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace
import asyncio


_PREVIEW_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "preview_service.py"
_PREVIEW_SPEC = importlib.util.spec_from_file_location(
    "tabslide_preview_service_quality_test_module",
    _PREVIEW_MODULE_PATH,
)
if _PREVIEW_SPEC is None or _PREVIEW_SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_PREVIEW_MODULE_PATH}")

_SLIDE_SERVICE_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "slide_service.py"
_SLIDE_SERVICE_SPEC = importlib.util.spec_from_file_location(
    "tabslide_slide_service_quality_test_module",
    _SLIDE_SERVICE_MODULE_PATH,
)
if _SLIDE_SERVICE_SPEC is None or _SLIDE_SERVICE_SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_SLIDE_SERVICE_MODULE_PATH}")

_DOM_EXTRACTOR_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "dom_extractor.py"
_DOM_EXTRACTOR_SPEC = importlib.util.spec_from_file_location(
    "tabslide_dom_extractor_quality_test_module",
    _DOM_EXTRACTOR_MODULE_PATH,
)
if _DOM_EXTRACTOR_SPEC is None or _DOM_EXTRACTOR_SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_DOM_EXTRACTOR_MODULE_PATH}")

def _make_package(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []  # type: ignore[attr-defined]
    return module


class _FakeBaseService:
    def __init__(self, user=None):
        self.user = user


class _FakeResourceBridge:
    @staticmethod
    def on_create(resource, user=None):
        return None

    @staticmethod
    def on_update(resource, user=None):
        return None

    @staticmethod
    def on_archive(resource, user=None):
        return None


class TestPreviewServiceQualityGuards(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.preview_service_module = importlib.util.module_from_spec(_PREVIEW_SPEC)
        _PREVIEW_SPEC.loader.exec_module(cls.preview_service_module)

    def test_build_slide_html_includes_assets_and_pt_font_size(self):
        html = self.preview_service_module.build_slide_html(
            elements=[
                {
                    "id": "chart-1",
                    "type": "chart",
                    "x": 0,
                    "y": 0,
                    "width": 300,
                    "height": 200,
                    "chartType": "bar",
                    "data": {"labels": ["A"], "series": [{"name": "S1", "data": [1]}]},
                },
                {
                    "id": "latex-1",
                    "type": "latex",
                    "x": 0,
                    "y": 210,
                    "width": 300,
                    "height": 80,
                    "latex": "x^2+y^2=z^2",
                },
                {
                    "id": "text-1",
                    "type": "text",
                    "x": 0,
                    "y": 300,
                    "width": 300,
                    "height": 80,
                    "content": "Font pt check",
                    "defaultFontSize": 20,
                },
            ],
            background={"type": "solid", "color": "#ffffff"},
            canvas_width=1280,
            canvas_height=720,
        )
        self.assertIn("echarts.min.js", html)
        self.assertIn("tex-svg.min.js", html)
        self.assertIn("font-size: 20pt", html)

    def test_visual_lint_detects_low_contrast(self):
        problems = self.preview_service_module.run_visual_lint(
            elements=[
                {
                    "id": "text-low-contrast",
                    "type": "text",
                    "x": 20,
                    "y": 20,
                    "width": 360,
                    "height": 80,
                    "content": "Low contrast",
                    "defaultFontSize": 18,
                    "defaultColor": "#bbbbbb",
                }
            ],
            background={"type": "solid", "color": "#ffffff"},
            canvas_width=640,
            canvas_height=360,
        )
        self.assertTrue(any(p.get("type") == "low_contrast" for p in problems))

    def test_visual_lint_batch_returns_per_page_results(self):
        batch = self.preview_service_module.run_visual_lint_batch(
            pages=[
                {
                    "elements": [
                        {
                            "id": "bad",
                            "type": "text",
                            "x": 20,
                            "y": 20,
                            "width": 300,
                            "height": 80,
                            "content": "Bad contrast",
                            "defaultFontSize": 18,
                            "defaultColor": "#bbbbbb",
                        }
                    ],
                    "background": {"type": "solid", "color": "#ffffff"},
                },
                {
                    "elements": [
                        {
                            "id": "good",
                            "type": "text",
                            "x": 20,
                            "y": 20,
                            "width": 300,
                            "height": 80,
                            "content": "Good contrast",
                            "defaultFontSize": 18,
                            "defaultColor": "#111111",
                        }
                    ],
                    "background": {"type": "solid", "color": "#ffffff"},
                },
            ],
            canvas_width=640,
            canvas_height=360,
        )
        self.assertEqual(len(batch), 2)
        self.assertTrue(any(p.get("type") == "low_contrast" for p in batch[0]))


class TestCreateSlidesInputGuards(TestCase):
    @classmethod
    def setUpClass(cls):
        fake_apps = _make_package("apps")
        fake_tabslide = _make_package("apps.tabslide")
        fake_tabslide_models = types.ModuleType("apps.tabslide.models")
        fake_tabslide_models.HISTORY_MIN_INTERVAL = 1
        fake_tabslide_models.HISTORY_SNAPSHOT_INTERVAL = 1
        fake_tabslide_models.HISTORY_SNAPSHOT_MAX_AGE = 1
        fake_tabslide_models.HISTORY_TTL_FREE = 1
        fake_tabslide_models.SlideChange = type("SlideChange", (), {})
        fake_tabslide_models.SlideElementChange = type("SlideElementChange", (), {})
        fake_tabslide_models.SlideHistory = type("SlideHistory", (), {})
        fake_tabslide_models.SlidePage = type("SlidePage", (), {})
        fake_tabslide_models.SlideProject = type("SlideProject", (), {})

        fake_field_mapping = types.ModuleType("apps.tabslide.field_mapping")
        fake_field_mapping.MODEL_CONTENT_UPDATE_FIELDS = []
        fake_field_mapping.frontend_page_to_defaults = lambda *args, **kwargs: {}
        fake_field_mapping.frontend_page_to_full_defaults = lambda *args, **kwargs: {}
        fake_field_mapping.model_row_to_frontend_page = lambda *args, **kwargs: {}
        fake_field_mapping.model_row_to_full_frontend_page = lambda *args, **kwargs: {}

        fake_tabtinspace = _make_package("apps.tabtinspace")
        fake_tabtinspace_services = _make_package("apps.tabtinspace.services")
        fake_tabtinspace_base = types.ModuleType("apps.tabtinspace.services.base")
        fake_tabtinspace_base.BaseService = _FakeBaseService
        fake_tabtinspace_bridge = types.ModuleType("apps.tabtinspace.services.resource_bridge")
        fake_tabtinspace_bridge.ResourceBridge = _FakeResourceBridge

        cls._patcher = patch.dict(
            sys.modules,
            {
                "apps": fake_apps,
                "apps.tabslide": fake_tabslide,
                "apps.tabslide.models": fake_tabslide_models,
                "apps.tabslide.field_mapping": fake_field_mapping,
                "apps.tabtinspace": fake_tabtinspace,
                "apps.tabtinspace.services": fake_tabtinspace_services,
                "apps.tabtinspace.services.base": fake_tabtinspace_base,
                "apps.tabtinspace.services.resource_bridge": fake_tabtinspace_bridge,
            },
            clear=False,
        )
        cls._patcher.start()

        cls.slide_service_module = importlib.util.module_from_spec(_SLIDE_SERVICE_SPEC)
        _SLIDE_SERVICE_SPEC.loader.exec_module(cls.slide_service_module)

    @classmethod
    def tearDownClass(cls):
        if cls._patcher is not None:
            cls._patcher.stop()

    def setUp(self):
        self.service = self.slide_service_module.SlideService.__new__(
            self.slide_service_module.SlideService
        )

    def test_create_slides_rejects_empty_html(self):
        with self.assertRaises(ValueError) as cm:
            self.service.create_slides("project-1", html="   ", mode="direct")
        self.assertIn("HTML 内容不能为空", str(cm.exception))

    def test_create_slides_rejects_oversized_html(self):
        oversized = "A" * (2 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError) as cm:
            self.service.create_slides("project-1", html=oversized, mode="direct")
        self.assertIn("HTML 内容过大", str(cm.exception))

    def test_create_slides_rejects_invalid_mode(self):
        with self.assertRaises(ValueError) as cm:
            self.service.create_slides("project-1", html="<div class='ppt-slide'></div>", mode="invalid")
        self.assertIn("不支持的模式", str(cm.exception))


class TestCreateSlidesApiErrorMapping(TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib

        cls.api_module = importlib.import_module("apps.tabslide.api")

    def test_create_slides_value_error_returns_validation_error(self):
        fake_request = SimpleNamespace(auth=SimpleNamespace(id=1))
        fake_body = SimpleNamespace(html="<div class='ppt-slide'></div>", title=None, mode="direct")

        fake_svc = SimpleNamespace(create_slides=lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("No .ppt-slide elements found in HTML")))
        with patch.object(self.api_module, "_build_service", return_value=fake_svc), \
                patch.object(self.api_module, "validation_error_response", side_effect=lambda msg: {"kind": "validation", "msg": msg}), \
                patch.object(self.api_module, "not_found_response", side_effect=lambda msg: {"kind": "not_found", "msg": msg}):
            result = self.api_module.create_slides(fake_request, "project-1", fake_body)

        self.assertEqual(result.get("kind"), "validation")
        self.assertIn("ppt-slide", result.get("msg", ""))

    def test_create_slides_project_missing_returns_not_found(self):
        fake_request = SimpleNamespace(auth=SimpleNamespace(id=1))
        fake_body = SimpleNamespace(html="<div class='ppt-slide'></div>", title=None, mode="direct")

        fake_svc = SimpleNamespace(create_slides=lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("演示文稿项目不存在")))
        with patch.object(self.api_module, "_build_service", return_value=fake_svc), \
                patch.object(self.api_module, "validation_error_response", side_effect=lambda msg: {"kind": "validation", "msg": msg}), \
                patch.object(self.api_module, "not_found_response", side_effect=lambda msg: {"kind": "not_found", "msg": msg}):
            result = self.api_module.create_slides(fake_request, "project-1", fake_body)

        self.assertEqual(result.get("kind"), "not_found")


class TestDomExtractorCanvasScreenshot(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dom_extractor_module = importlib.util.module_from_spec(_DOM_EXTRACTOR_SPEC)
        _DOM_EXTRACTOR_SPEC.loader.exec_module(cls.dom_extractor_module)

    def test_canvas_screenshot_uses_correct_clip_coordinates(self):
        """Verify that canvas elements detected via _DETECT_CANVAS_JS are
        screenshotted with the correct absolute clip coordinates."""
        calls = {}
        self_module = self.dom_extractor_module

        class _FakeSlideEl:
            async def evaluate(self, script, *args):
                if "offsetWidth" in script:
                    return {"w": 1280, "h": 720}
                if "querySelectorAll" in script:
                    return [{"x": 100, "y": 80, "width": 300, "height": 160}]
                if "getBoundingClientRect" in script:
                    return {"left": 40, "top": 20}
                return {}

            async def scroll_into_view_if_needed(self):
                return None

        class _FakePage:
            async def set_content(self, *_args, **_kwargs):
                return None

            async def wait_for_timeout(self, *_args, **_kwargs):
                return None

            async def add_script_tag(self, **_kwargs):
                return None

            async def evaluate(self, script):
                if "canvas" in script:
                    return True
                return None

            async def query_selector_all(self, _selector):
                return [_FakeSlideEl()]

            async def screenshot(self, *, type, clip):
                calls["clip"] = clip
                return b"png-bytes"

        class _FakeBrowser:
            async def new_page(self, **_kwargs):
                return _FakePage()

            async def close(self):
                return None

        class _FakeChromium:
            async def launch(self, **_kwargs):
                return _FakeBrowser()

        class _FakePlaywright:
            chromium = _FakeChromium()

        class _AsyncPlaywrightCtx:
            async def __aenter__(self):
                return _FakePlaywright()

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                return False

        def _fake_async_playwright():
            return _AsyncPlaywrightCtx()

        fake_async_api = types.ModuleType("playwright.async_api")
        fake_async_api.async_playwright = _fake_async_playwright

        with patch.dict(sys.modules, {"playwright.async_api": fake_async_api}, clear=False):
            pages = asyncio.run(
                self_module._extract_async(
                    html="<div class='ppt-slide'></div>",
                    canvas_w=1920,
                    canvas_h=1080,
                    image_handler=lambda b, _mime: f"mock://{len(b)}",
                )
            )

        self.assertEqual(len(pages), 1)
        img_els = [e for e in pages[0]["elements"] if e.get("type") == "image"]
        self.assertTrue(len(img_els) > 0, "Expected at least one canvas screenshot image")
        self.assertTrue(img_els[0]["src"].startswith("mock://"))
        self.assertEqual(calls["clip"]["x"], 140)
        self.assertEqual(calls["clip"]["y"], 100)
        self.assertEqual(calls["clip"]["width"], 300)
        self.assertEqual(calls["clip"]["height"], 160)
