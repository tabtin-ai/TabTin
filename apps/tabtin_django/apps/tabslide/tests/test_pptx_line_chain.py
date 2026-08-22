import importlib.util
from pathlib import Path
from unittest import TestCase

from lxml import etree

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_line_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_map_line_point_to_ooxml_arrow = _PPTX_IO._map_line_point_to_ooxml_arrow
_extract_custom_geom_line_shape = _PPTX_IO._extract_custom_geom_line_shape
_extract_connector_shape = _PPTX_IO._extract_connector_shape
_write_line_element = _PPTX_IO._write_line_element
EMU_PER_PT = _PPTX_IO.EMU_PER_PT


class _DummyColor:
    def __init__(self, rgb: str):
        self.rgb = rgb
        self.theme_color = None


class _DummyLine:
    def __init__(self, rgb: str = "112233", width_px: float = 2.0, dash_style=1):
        self.color = _DummyColor(rgb)
        self.width = int(width_px * EMU_PER_PT)
        self.dash_style = dash_style


class _DummyShape:
    def __init__(self, xml: str, line: _DummyLine):
        self._element = etree.fromstring(xml.encode("utf-8"))
        self.line = line


class _DummyShapes:
    def __init__(self):
        self._spTree = etree.fromstring(
            """
            <p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" />
            """
        )


class _DummySlide:
    def __init__(self):
        self.shapes = _DummyShapes()


class TestPptxLineChain(TestCase):
    def test_map_line_point_handles_none_and_unknown(self):
        self.assertEqual(_map_line_point_to_ooxml_arrow(""), "none")
        self.assertEqual(_map_line_point_to_ooxml_arrow("none"), "none")
        self.assertEqual(_map_line_point_to_ooxml_arrow("legacy-unknown"), "arrow")

    def test_extract_custom_geom_line_keeps_dash_and_merges_alpha_into_opacity(self):
        xml = """
        <p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:spPr>
            <a:custGeom>
              <a:pathLst>
                <a:path w="100000" h="100000">
                  <a:moveTo><a:pt x="0" y="0" /></a:moveTo>
                  <a:lnTo><a:pt x="50000" y="25000" /></a:lnTo>
                  <a:lnTo><a:pt x="100000" y="100000" /></a:lnTo>
                </a:path>
              </a:pathLst>
            </a:custGeom>
            <a:ln>
              <a:solidFill>
                <a:srgbClr val="112233">
                  <a:alpha val="40000" />
                </a:srgbClr>
              </a:solidFill>
            </a:ln>
          </p:spPr>
        </p:sp>
        """
        shape = _DummyShape(xml, _DummyLine(dash_style=6))
        base = {
            "id": "line-cg",
            "x": 0,
            "y": 0,
            "width": 200,
            "height": 100,
            "zIndex": 0,
        }

        extracted = _extract_custom_geom_line_shape(shape, base, None)
        self.assertIsNotNone(extracted)
        assert extracted is not None
        self.assertEqual(extracted["type"], "line")
        self.assertEqual(extracted["props"]["style"], "longDash")
        self.assertEqual(extracted["props"]["color"], "#112233")
        self.assertEqual(extracted["opacity"], 0.4)
        self.assertEqual(extracted["props"]["broken"], [100.0, 25.0])

    def test_write_line_element_uses_connector4_for_broken2_and_respects_none_arrow(self):
        slide = _DummySlide()
        element = {
            "id": "line-broken2",
            "type": "line",
            "x": 10,
            "y": 20,
            "width": 160,
            "height": 60,
            "props": {
                "start": [0, 0],
                "end": [160, 60],
                "style": "solid",
                "color": "#445566",
                "lineWidth": 2,
                "points": ["none", "diamond"],
                "broken2": [60, 20],
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        cxn = slide.shapes._spTree.find("p:cxnSp", ns)
        self.assertIsNotNone(cxn)
        assert cxn is not None

        prst_geom = cxn.find(".//a:prstGeom", ns)
        self.assertIsNotNone(prst_geom)
        assert prst_geom is not None
        self.assertEqual(prst_geom.get("prst"), "bentConnector4")

        gd_nodes = cxn.findall(".//a:prstGeom/a:avLst/a:gd", ns)
        self.assertEqual(len(gd_nodes), 2)
        self.assertEqual(gd_nodes[0].get("name"), "adj1")
        self.assertEqual(gd_nodes[1].get("name"), "adj2")

        head_end = cxn.find(".//a:ln/a:headEnd", ns)
        tail_end = cxn.find(".//a:ln/a:tailEnd", ns)
        self.assertIsNone(head_end)
        self.assertIsNotNone(tail_end)
        assert tail_end is not None
        self.assertEqual(tail_end.get("type"), "diamond")

    def test_write_line_element_scales_line_width_for_export_slide_size(self):
        slide = _DummySlide()
        element = {
            "id": "line-width-scaled",
            "type": "line",
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 0,
            "props": {
                "start": [0, 0],
                "end": [100, 0],
                "style": "solid",
                "color": "#445566",
                "lineWidth": 3,
                "points": ["", ""],
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=12192000,
            slide_height_emu=6858000,
            canvas_width=1920,
            canvas_height=1080,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        line = slide.shapes._spTree.find("p:cxnSp/p:spPr/a:ln", ns)
        self.assertIsNotNone(line)
        assert line is not None
        self.assertAlmostEqual(int(line.get("w", "0")), int(2 * EMU_PER_PT), delta=2)

    def test_write_line_element_keeps_line_width_at_native_96dpi(self):
        slide = _DummySlide()
        element = {
            "id": "line-width-native",
            "type": "line",
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 0,
            "props": {
                "start": [0, 0],
                "end": [100, 0],
                "style": "solid",
                "color": "#445566",
                "lineWidth": 3,
                "points": ["", ""],
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=9144000,
            slide_height_emu=5143500,
            canvas_width=960,
            canvas_height=540,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        line = slide.shapes._spTree.find("p:cxnSp/p:spPr/a:ln", ns)
        self.assertIsNotNone(line)
        assert line is not None
        self.assertEqual(int(line.get("w", "0")), int(3 * EMU_PER_PT))

    def test_write_line_element_uses_connector4_for_cubic(self):
        slide = _DummySlide()
        element = {
            "id": "line-cubic",
            "type": "line",
            "x": 30,
            "y": 30,
            "width": 200,
            "height": 120,
            "props": {
                "start": [0, 0],
                "end": [200, 120],
                "style": "solid",
                "color": "#333333",
                "lineWidth": 2,
                "points": ["arrow", "none"],
                "cubic": [[60, 10], [150, 100]],
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        cxn = slide.shapes._spTree.find("p:cxnSp", ns)
        self.assertIsNotNone(cxn)
        assert cxn is not None
        prst_geom = cxn.find(".//a:prstGeom", ns)
        self.assertIsNotNone(prst_geom)
        assert prst_geom is not None
        self.assertEqual(prst_geom.get("prst"), "curvedConnector4")

    def test_write_line_element_uses_control_points_for_geometry_bounds(self):
        slide = _DummySlide()
        element = {
            "id": "line-curve-negative",
            "type": "line",
            "x": 120,
            "y": 200,
            "width": 200,
            "height": 0,
            "props": {
                "start": [0, 0],
                "end": [200, 0],
                "style": "solid",
                "color": "#333333",
                "lineWidth": 2,
                "points": ["", ""],
                "curve": [100, -80],
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        cxn = slide.shapes._spTree.find("p:cxnSp", ns)
        self.assertIsNotNone(cxn)
        assert cxn is not None

        off = cxn.find(".//a:xfrm/a:off", ns)
        ext = cxn.find(".//a:xfrm/a:ext", ns)
        self.assertIsNotNone(off)
        self.assertIsNotNone(ext)
        assert off is not None and ext is not None

        top_emu = int(off.get("y", "0"))
        cy_emu = int(ext.get("cy", "0"))

        # curve 控制点在 y=-80，写回应将包围盒上移并拉高，而不是退化成 1px 高度。
        self.assertLess(top_emu, 200 * 12700)
        self.assertGreater(cy_emu, 1)

    def test_write_line_element_writes_shadow_from_rgba_color(self):
        slide = _DummySlide()
        element = {
            "id": "line-shadow-rgba",
            "type": "line",
            "x": 20,
            "y": 30,
            "width": 180,
            "height": 40,
            "props": {
                "start": [0, 0],
                "end": [180, 40],
                "style": "solid",
                "color": "#445566",
                "lineWidth": 2,
                "points": ["arrow", "arrow"],
                "shadow": {
                    "h": 4,
                    "v": 6,
                    "blur": 8,
                    "color": "rgba(10,20,30,0.25)",
                },
            },
        }
        _write_line_element(
            slide,
            element,
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )

        ns = {
            "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
            "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        }
        cxn = slide.shapes._spTree.find("p:cxnSp", ns)
        self.assertIsNotNone(cxn)
        assert cxn is not None

        outer = cxn.find(".//a:effectLst/a:outerShdw", ns)
        self.assertIsNotNone(outer)
        assert outer is not None

        srgb = outer.find("a:srgbClr", ns)
        self.assertIsNotNone(srgb)
        assert srgb is not None
        self.assertEqual(srgb.get("val"), "0a141e")

        alpha = srgb.find("a:alpha", ns)
        self.assertIsNotNone(alpha)
        assert alpha is not None
        self.assertEqual(alpha.get("val"), "25000")

    def test_extract_connector_shape_maps_dash_arrow_and_opacity(self):
        xml = """
        <p:cxnSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:spPr>
            <a:xfrm />
            <a:prstGeom prst="bentConnector4">
              <a:avLst>
                <a:gd name="adj1" fmla="val 25000" />
                <a:gd name="adj2" fmla="val 60000" />
              </a:avLst>
            </a:prstGeom>
            <a:ln>
              <a:solidFill>
                <a:srgbClr val="112233">
                  <a:alpha val="50000" />
                </a:srgbClr>
              </a:solidFill>
              <a:prstDash val="sysDot" />
              <a:headEnd type="oval" />
              <a:tailEnd type="diamond" />
            </a:ln>
          </p:spPr>
        </p:cxnSp>
        """
        shape = _DummyShape(xml, _DummyLine(rgb="112233", width_px=3.0, dash_style=None))
        base = {
            "id": "line-conn-style",
            "x": 100,
            "y": 120,
            "width": 200,
            "height": 100,
            "opacity": 0.8,
            "zIndex": 1,
        }
        extracted = _extract_connector_shape(
            shape,
            base,
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )

        self.assertEqual(extracted["type"], "line")
        self.assertAlmostEqual(float(extracted["opacity"]), 0.4, delta=0.001)

        props = extracted["props"]
        self.assertEqual(props["style"], "dotted")
        self.assertEqual(props["color"], "#112233")
        self.assertAlmostEqual(float(props["lineWidth"]), 3.0, delta=0.2)
        self.assertEqual(props["points"], ["dot", "diamond"])
        self.assertIn("broken2", props)
        self.assertAlmostEqual(float(props["broken2"][0]), 50.0, delta=0.2)
        self.assertAlmostEqual(float(props["broken2"][1]), 60.0, delta=0.2)

    def test_extract_connector_shape_maps_curve_and_cubic(self):
        curve_xml = """
        <p:cxnSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:spPr>
            <a:prstGeom prst="curvedConnector3">
              <a:avLst>
                <a:gd name="adj1" fmla="val 30000" />
                <a:gd name="adj2" fmla="val 70000" />
              </a:avLst>
            </a:prstGeom>
            <a:ln />
          </p:spPr>
        </p:cxnSp>
        """
        cubic_xml = """
        <p:cxnSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:spPr>
            <a:prstGeom prst="curvedConnector4">
              <a:avLst>
                <a:gd name="adj1" fmla="val 20000" />
                <a:gd name="adj2" fmla="val 80000" />
              </a:avLst>
            </a:prstGeom>
            <a:ln />
          </p:spPr>
        </p:cxnSp>
        """
        base = {
            "id": "line-conn-curve",
            "x": 0,
            "y": 0,
            "width": 200,
            "height": 100,
            "zIndex": 0,
        }

        curve = _extract_connector_shape(
            _DummyShape(curve_xml, _DummyLine()),
            dict(base),
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )
        self.assertIn("curve", curve["props"])
        self.assertAlmostEqual(float(curve["props"]["curve"][0]), 60.0, delta=0.2)
        self.assertAlmostEqual(float(curve["props"]["curve"][1]), 70.0, delta=0.2)

        cubic = _extract_connector_shape(
            _DummyShape(cubic_xml, _DummyLine()),
            dict(base),
            slide_width_emu=9144000,
            slide_height_emu=6858000,
            canvas_width=960,
            canvas_height=540,
        )
        self.assertIn("cubic", cubic["props"])
        ctrl = cubic["props"]["cubic"]
        self.assertEqual(len(ctrl), 2)
        self.assertAlmostEqual(float(ctrl[0][0]), 40.0, delta=0.2)
        self.assertAlmostEqual(float(ctrl[0][1]), 20.0, delta=0.2)
        self.assertAlmostEqual(float(ctrl[1][0]), 160.0, delta=0.2)
        self.assertAlmostEqual(float(ctrl[1][1]), 80.0, delta=0.2)
