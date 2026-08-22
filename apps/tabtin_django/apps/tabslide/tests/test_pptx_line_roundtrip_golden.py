import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_line_roundtrip_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write


def _make_line_element(
    *,
    name: str,
    start: List[float],
    end: List[float],
    style: str,
    color: str,
    line_width: float,
    points: List[str],
    x: float = 80,
    y: float = 80,
    opacity: float = 1.0,
    rotate: Optional[float] = None,
    flip_h: bool = False,
    flip_v: bool = False,
    broken: Optional[List[float]] = None,
    broken2: Optional[List[float]] = None,
    curve: Optional[List[float]] = None,
    cubic: Optional[List[List[float]]] = None,
    shadow: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    width = abs(end[0] - start[0]) or 240
    height = abs(end[1] - start[1]) or 1
    element: Dict[str, Any] = {
        "id": f"id-{name}",
        "name": name,
        "type": "line",
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "opacity": opacity,
        "locked": False,
        "props": {
            "start": list(start),
            "end": list(end),
            "style": style,
            "color": color,
            "lineWidth": line_width,
            "points": list(points),
        },
    }
    if rotate is not None:
        element["rotate"] = rotate
    if flip_h:
        element["flipH"] = True
    if flip_v:
        element["flipV"] = True
    if shadow:
        element["shadow"] = shadow
    if broken is not None:
        element["props"]["broken"] = list(broken)
    if broken2 is not None:
        element["props"]["broken2"] = list(broken2)
    if curve is not None:
        element["props"]["curve"] = list(curve)
    if cubic is not None:
        element["props"]["cubic"] = [list(cubic[0]), list(cubic[1])]
    return element


def _find_by_name(elements: List[Dict[str, Any]], name: str) -> Dict[str, Any]:
    for el in elements:
        if el.get("name") == name:
            return el
    raise AssertionError(f"Element with name '{name}' not found")


class TestPptxLineRoundTripGolden(TestCase):
    maxDiff = None

    def _roundtrip(self, line_elements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        pages = [
            {
                "id": "page-1",
                "elements": line_elements,
                "background": {"type": "color", "value": "#ffffff"},
                "notes": "",
            }
        ]
        with TemporaryDirectory() as tmpdir:
            output_path = str(Path(tmpdir) / "line-roundtrip-golden.pptx")
            write(
                pages=pages,
                output_path=output_path,
                canvas_width=960,
                canvas_height=540,
            )
            out_pages = read(
                pptx_path=output_path,
                canvas_width=960,
                canvas_height=540,
            )
        self.assertEqual(len(out_pages), 1)
        return out_pages[0].get("elements", [])

    def _assert_point_close(self, got: List[float], expect: List[float], tol: float = 2.0) -> None:
        self.assertEqual(len(got), 2)
        self.assertAlmostEqual(float(got[0]), float(expect[0]), delta=tol)
        self.assertAlmostEqual(float(got[1]), float(expect[1]), delta=tol)

    def test_line_roundtrip_golden_matrix(self):
        source_lines = [
            _make_line_element(
                name="golden-straight",
                start=[0, 0],
                end=[240, 80],
                style="solid",
                color="#336699",
                line_width=2.4,
                points=["", "arrow"],
                rotate=18,
                flip_h=True,
                shadow={"h": 3, "v": 4, "blur": 6, "color": "#000000", "opacity": 0.35},
            ),
            _make_line_element(
                name="golden-broken",
                start=[0, 0],
                end=[240, 80],
                style="dashed",
                color="#cc5500",
                line_width=3,
                points=["triangle", "dot"],
                broken=[120, 20],
            ),
            _make_line_element(
                name="golden-broken2",
                start=[0, 0],
                end=[240, 80],
                style="dotted",
                color="#008866",
                line_width=2,
                points=["none", "diamond"],
                broken2=[90, 30],
            ),
            _make_line_element(
                name="golden-curve-alpha",
                start=[0, 0],
                end=[240, 80],
                style="dashed",
                color="rgba(34,68,102,0.5)",
                line_width=2,
                points=["dot", "triangle"],
                curve=[140, 25],
                opacity=0.8,
            ),
            _make_line_element(
                name="golden-cubic",
                start=[0, 0],
                end=[240, 144],
                style="solid",
                color="#7744aa",
                line_width=2.5,
                points=["arrow", ""],
                cubic=[[60, 36], [180, 108]],
            ),
        ]

        result_elements = self._roundtrip(source_lines)

        straight = _find_by_name(result_elements, "golden-straight")
        self.assertEqual(straight["type"], "line")
        self.assertEqual(straight["props"]["style"], "solid")
        self.assertEqual(straight["props"]["points"], ["", "arrow"])
        self.assertEqual(str(straight["props"]["color"]).lower(), "#336699")
        self.assertAlmostEqual(float(straight["props"]["lineWidth"]), 2.4, delta=0.3)
        self.assertAlmostEqual(float(straight.get("rotate", 0)), 18.0, delta=0.8)
        # connector 读取时会将 flip 语义折叠到 start/end，避免前端二次翻转
        self.assertNotIn("flipH", straight)
        self.assertNotIn("flipV", straight)
        self._assert_point_close(straight["props"]["start"], [240, 0], tol=2.0)
        self._assert_point_close(straight["props"]["end"], [0, 80], tol=2.0)
        self.assertIn("shadow", straight)

        broken = _find_by_name(result_elements, "golden-broken")
        self.assertEqual(broken["props"]["style"], "dashed")
        self.assertEqual(broken["props"]["points"], ["triangle", "dot"])
        self.assertIn("broken", broken["props"])
        self._assert_point_close(broken["props"]["broken"], [120, 20], tol=3.0)

        broken2 = _find_by_name(result_elements, "golden-broken2")
        self.assertEqual(broken2["props"]["style"], "dotted")
        # 输入 "none" 端点应归一化为空字符串
        self.assertEqual(broken2["props"]["points"], ["", "diamond"])
        self.assertIn("broken2", broken2["props"])
        self._assert_point_close(broken2["props"]["broken2"], [90, 30], tol=3.0)

        curve_alpha = _find_by_name(result_elements, "golden-curve-alpha")
        self.assertEqual(curve_alpha["props"]["style"], "dashed")
        self.assertEqual(curve_alpha["props"]["points"], ["dot", "triangle"])
        self.assertEqual(str(curve_alpha["props"]["color"]).lower(), "#224466")
        self.assertIn("curve", curve_alpha["props"])
        self._assert_point_close(curve_alpha["props"]["curve"], [140, 25], tol=4.0)
        # rgba alpha(0.5) × element opacity(0.8) => 0.4
        self.assertAlmostEqual(float(curve_alpha.get("opacity", 1.0)), 0.4, delta=0.06)

        cubic = _find_by_name(result_elements, "golden-cubic")
        self.assertEqual(cubic["props"]["style"], "solid")
        self.assertEqual(cubic["props"]["points"], ["arrow", ""])
        self.assertIn("cubic", cubic["props"])
        cubic_ctrl = cubic["props"]["cubic"]
        self.assertEqual(len(cubic_ctrl), 2)
        self._assert_point_close(cubic_ctrl[0], [60, 36], tol=4.0)
        self._assert_point_close(cubic_ctrl[1], [180, 108], tol=4.0)
