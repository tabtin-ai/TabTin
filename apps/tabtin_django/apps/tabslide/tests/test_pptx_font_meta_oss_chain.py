"""
TabSlide font_meta DB 存储测试

验证 font_meta 直接通过 SlideProject.font_meta JSONField 读写，
不再经过 OSS 或本地文件。
"""

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch


_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "slide_service.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_slide_service_font_meta_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")


def _make_package(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []  # type: ignore[attr-defined]
    return module


class _FakeBaseService:
    def __init__(self, user=None):
        self.user = user

    def check_space_permission(self, space_id: str, required_role: str = "viewer") -> bool:
        return True


class _FakeResourceBridge:
    @staticmethod
    def on_create(project, user=None):
        pass

    @staticmethod
    def on_update(project, user=None):
        pass

    @staticmethod
    def on_archive(project, user=None):
        pass


class _FakeSlideProject:
    pass


class _FakeSlideHistory:
    pass


class _FakeSlideChange:
    pass


class _FakeTransaction:
    """Fake django.db.transaction for importlib-based tests."""

    @staticmethod
    def atomic(using=None):
        from contextlib import contextmanager

        @contextmanager
        def _noop():
            yield

        return _noop()


class _FakeTimezone:
    """Fake django.utils.timezone for importlib-based tests."""

    @staticmethod
    def now():
        from datetime import datetime, timezone as _tz
        return datetime.now(_tz.utc)


class TestFontMetaDbStorage(TestCase):
    """font_meta 直接读写 DB 字段的测试"""

    _sys_patch = None
    _slide_service_module = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        fake_apps = _make_package("apps")
        fake_tabslide = _make_package("apps.tabslide")
        fake_tabslide_models = types.ModuleType("apps.tabslide.models")
        fake_tabslide_models.SlideProject = _FakeSlideProject
        fake_tabslide_models.SlideHistory = _FakeSlideHistory
        fake_tabslide_models.SlideChange = _FakeSlideChange
        fake_tabslide_models.HISTORY_TTL_FREE = 7 * 24 * 3600
        fake_tabslide_models.HISTORY_MIN_INTERVAL = 5
        fake_tabslide_models.HISTORY_SNAPSHOT_INTERVAL = 20
        fake_tabslide_models.HISTORY_SNAPSHOT_MAX_AGE = 7 * 24 * 3600
        fake_tabslide_models.SlideElementChange = type("SlideElementChange", (), {})
        fake_tabslide_models.SlidePage = type("SlidePage", (), {})

        fake_tabtinspace = _make_package("apps.tabtinspace")
        fake_tabtinspace_services = _make_package("apps.tabtinspace.services")
        fake_tabtinspace_base = types.ModuleType("apps.tabtinspace.services.base")
        fake_tabtinspace_base.BaseService = _FakeBaseService
        fake_tabtinspace_bridge = types.ModuleType("apps.tabtinspace.services.resource_bridge")
        fake_tabtinspace_bridge.ResourceBridge = _FakeResourceBridge

        fake_services = _make_package("apps.services")
        fake_services_oss = _make_package("apps.services.oss")
        fake_services_oss_services = _make_package("apps.services.oss.services")
        fake_services_oss_factory = types.ModuleType("apps.services.oss.services.factory")
        fake_services_oss_factory.get_oss_service = lambda: None

        # Django stubs needed by the service module
        fake_django = _make_package("django")
        fake_django_db = _make_package("django.db")
        fake_django_db_module = types.ModuleType("django.db")
        fake_django_db_module.transaction = _FakeTransaction()
        fake_django_utils = _make_package("django.utils")
        fake_django_utils_timezone = types.ModuleType("django.utils.timezone")
        fake_django_utils_timezone.now = _FakeTimezone.now

        cls._sys_patch = patch.dict(
            sys.modules,
            {
                "apps": fake_apps,
                "apps.tabslide": fake_tabslide,
                "apps.tabslide.models": fake_tabslide_models,
                "apps.tabtinspace": fake_tabtinspace,
                "apps.tabtinspace.services": fake_tabtinspace_services,
                "apps.tabtinspace.services.base": fake_tabtinspace_base,
                "apps.tabtinspace.services.resource_bridge": fake_tabtinspace_bridge,
                "apps.services": fake_services,
                "apps.services.oss": fake_services_oss,
                "apps.services.oss.services": fake_services_oss_services,
                "apps.services.oss.services.factory": fake_services_oss_factory,
                "django": fake_django,
                "django.db": fake_django_db_module,
                "django.utils": fake_django_utils,
                "django.utils.timezone": fake_django_utils_timezone,
            },
            clear=False,
        )
        cls._sys_patch.start()

        cls._slide_service_module = importlib.util.module_from_spec(_SPEC)
        _SPEC.loader.exec_module(cls._slide_service_module)

    @classmethod
    def tearDownClass(cls):
        cls._sys_patch.stop()

    def setUp(self):
        self.service = self._slide_service_module.SlideService.__new__(self._slide_service_module.SlideService)
        self.project = SimpleNamespace(
            id="ppt-1",
            organization_id="ws-1",
            space_id="proj-1",
            font_meta=None,
        )
        self._saved_fields = []

        def fake_save(update_fields=None, **kwargs):
            if update_fields:
                self._saved_fields.extend(update_fields)

        self.project.save = fake_save

    def test_save_font_meta_to_db(self):
        """保存字体元数据直接写入 project.font_meta"""
        self.service._save_font_meta(
            self.project,
            embedded_fonts=[
                {
                    "name": "Mock Font",
                    "style": "BOLD",
                    "format": "TRUETYPE",
                    "data_base64": "QUJDRA==",
                }
            ],
            theme_fonts={"minor_ea": "等线"},
            provided=True,
        )

        self.assertIsNotNone(self.project.font_meta)
        self.assertEqual(len(self.project.font_meta["embedded_fonts"]), 1)
        self.assertEqual(self.project.font_meta["embedded_fonts"][0]["name"], "Mock Font")
        self.assertEqual(self.project.font_meta["embedded_fonts"][0]["style"], "bold")
        self.assertEqual(self.project.font_meta["theme_fonts"]["minor_ea"], "等线")
        self.assertIn("font_meta", self._saved_fields)

    def test_get_font_meta_from_db(self):
        """读取字体元数据直接从 project.font_meta"""
        self.project.font_meta = {
            "embedded_fonts": [{"name": "DB Font", "style": "normal", "format": "truetype", "data_base64": "QUJDRA=="}],
            "theme_fonts": {"major_latin": "Arial"},
        }

        result = self.service.get_font_meta(self.project)
        self.assertEqual(len(result["embedded_fonts"]), 1)
        self.assertEqual(result["embedded_fonts"][0]["name"], "DB Font")
        self.assertEqual(result["theme_fonts"]["major_latin"], "Arial")

    def test_get_font_meta_empty(self):
        """font_meta 为空时返回默认值"""
        self.project.font_meta = None
        result = self.service.get_font_meta(self.project)
        self.assertEqual(result, {"embedded_fonts": [], "theme_fonts": {}})

    def test_clear_font_meta(self):
        """清空字体元数据将 font_meta 设为 None"""
        self.project.font_meta = {
            "embedded_fonts": [{"name": "Old Font", "style": "normal", "format": "truetype", "data_base64": "X"}],
            "theme_fonts": {},
        }

        self.service._save_font_meta(
            self.project,
            embedded_fonts=[],
            theme_fonts={},
            provided=True,
        )

        self.assertIsNone(self.project.font_meta)

    def test_save_font_meta_defer_save(self):
        """defer_save=True 时不调用 project.save()"""
        self.service._save_font_meta(
            self.project,
            embedded_fonts=[{"name": "F", "style": "normal", "format": "truetype", "data_base64": "QQ=="}],
            theme_fonts={},
            provided=True,
            defer_save=True,
        )

        self.assertIsNotNone(self.project.font_meta)
        self.assertEqual(self._saved_fields, [])

    def test_save_font_meta_not_provided(self):
        """provided=False 时不修改 font_meta"""
        self.project.font_meta = {"embedded_fonts": [], "theme_fonts": {}}

        self.service._save_font_meta(
            self.project,
            embedded_fonts=[{"name": "X", "style": "normal", "format": "truetype", "data_base64": "QQ=="}],
            theme_fonts={},
            provided=False,
        )

        self.assertEqual(self.project.font_meta, {"embedded_fonts": [], "theme_fonts": {}})

    def test_legacy_font_meta_extracted_from_theme(self):
        """兼容旧前端将 font_meta 塞进 theme 的写法"""
        theme = {
            "colors": {"primary": "#000"},
            "_tabslideFontEmbedding": {
                "embeddedFonts": [{"name": "Legacy", "style": "normal", "format": "truetype", "data_base64": "QQ=="}],
                "themeFonts": {"minor_ea": "黑体"},
            },
        }

        clean_theme, embedded, theme_fonts, found = self.service._extract_legacy_font_meta_from_theme(theme)

        self.assertTrue(found)
        self.assertNotIn("_tabslideFontEmbedding", clean_theme)
        self.assertEqual(embedded[0]["name"], "Legacy")
        self.assertEqual(theme_fonts["minor_ea"], "黑体")
