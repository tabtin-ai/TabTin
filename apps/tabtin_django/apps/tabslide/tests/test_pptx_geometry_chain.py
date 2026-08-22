import importlib.util
import sys
import types
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "slide_service.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_slide_service_geometry_test_module", _MODULE_PATH)
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
    def on_create(resource, user=None):
        return None

    @staticmethod
    def on_update(resource, user=None):
        return None

    @staticmethod
    def on_archive(resource, user=None):
        return None


class _DummyProject:
    def __init__(self, project_id: str, theme: dict, canvas_width: int, canvas_height: int):
        self.id = project_id
        self.theme = theme
        self.canvas_width = canvas_width
        self.canvas_height = canvas_height
        self.saved_update_fields = None

    def save(self, update_fields=None):
        self.saved_update_fields = update_fields


class TestPptxGeometryChain(TestCase):
    @classmethod
    def setUpClass(cls):
        fake_apps = _make_package("apps")
        fake_tabslide = _make_package("apps.tabslide")
        fake_tabslide_models = types.ModuleType("apps.tabslide.models")
        fake_tabslide_models.HISTORY_MIN_INTERVAL = 5
        fake_tabslide_models.HISTORY_SNAPSHOT_INTERVAL = 20
        fake_tabslide_models.HISTORY_SNAPSHOT_MAX_AGE = 7 * 24 * 3600
        fake_tabslide_models.HISTORY_TTL_FREE = 30 * 24 * 3600
        fake_tabslide_models.SlideChange = type("SlideChange", (), {})
        fake_tabslide_models.SlideElementChange = type("SlideElementChange", (), {})
        fake_tabslide_models.SlideHistory = type("SlideHistory", (), {})
        fake_tabslide_models.SlidePage = type("SlidePage", (), {})
        fake_tabslide_models.SlideProject = type("SlideProject", (), {})

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
                "apps.tabtinspace": fake_tabtinspace,
                "apps.tabtinspace.services": fake_tabtinspace_services,
                "apps.tabtinspace.services.base": fake_tabtinspace_base,
                "apps.tabtinspace.services.resource_bridge": fake_tabtinspace_bridge,
            },
            clear=False,
        )
        cls._patcher.start()

        cls._slide_service_module = importlib.util.module_from_spec(_SPEC)
        _SPEC.loader.exec_module(cls._slide_service_module)

    @classmethod
    def tearDownClass(cls):
        if cls._patcher is not None:
            cls._patcher.stop()

    def test_detect_pptx_geometry_uses_emu_physical_px_mapping_for_16_9(self):
        class _FakePresentation:
            def __init__(self, _path):
                self.slide_width = 12192000
                self.slide_height = 6858000

        fake_pptx = types.ModuleType("pptx")
        fake_pptx.Presentation = _FakePresentation
        with patch.dict(sys.modules, {"pptx": fake_pptx}, clear=False):
            geometry = self._slide_service_module.SlideService._detect_pptx_geometry("/tmp/mock.pptx")
        self.assertEqual(geometry["canvas_width"], 1280)
        self.assertEqual(geometry["canvas_height"], 720)
        self.assertEqual(geometry["slide_width_emu"], 12192000)
        self.assertEqual(geometry["slide_height_emu"], 6858000)

    def test_detect_pptx_geometry_uses_emu_physical_px_mapping_for_4_3(self):
        class _FakePresentation:
            def __init__(self, _path):
                self.slide_width = 9144000
                self.slide_height = 6858000

        fake_pptx = types.ModuleType("pptx")
        fake_pptx.Presentation = _FakePresentation
        with patch.dict(sys.modules, {"pptx": fake_pptx}, clear=False):
            geometry = self._slide_service_module.SlideService._detect_pptx_geometry("/tmp/mock.pptx")
        self.assertEqual(geometry["canvas_width"], 960)
        self.assertEqual(geometry["canvas_height"], 720)
        self.assertEqual(geometry["slide_width_emu"], 9144000)
        self.assertEqual(geometry["slide_height_emu"], 6858000)

    def test_maybe_fix_legacy_import_canvas_updates_only_legacy_mapping(self):
        source_key = self._slide_service_module.SOURCE_SLIDE_EMU_KEY
        project = _DummyProject(
            project_id="ppt-legacy",
            theme={source_key: {"width": 12192000, "height": 6858000}},
            canvas_width=1920,
            canvas_height=1080,
        )
        service = self._slide_service_module.SlideService.__new__(self._slide_service_module.SlideService)

        changed = service._maybe_fix_legacy_import_canvas(project)
        self.assertTrue(changed)
        self.assertEqual((project.canvas_width, project.canvas_height), (1280, 720))
        self.assertEqual(project.saved_update_fields, ["canvas_width", "canvas_height", "updated_at"])

    def test_maybe_fix_legacy_import_canvas_skips_custom_canvas(self):
        source_key = self._slide_service_module.SOURCE_SLIDE_EMU_KEY
        project = _DummyProject(
            project_id="ppt-custom",
            theme={source_key: {"width": 12192000, "height": 6858000}},
            canvas_width=1400,
            canvas_height=788,
        )
        service = self._slide_service_module.SlideService.__new__(self._slide_service_module.SlideService)

        changed = service._maybe_fix_legacy_import_canvas(project)
        self.assertFalse(changed)
        self.assertEqual((project.canvas_width, project.canvas_height), (1400, 788))
        self.assertIsNone(project.saved_update_fields)
