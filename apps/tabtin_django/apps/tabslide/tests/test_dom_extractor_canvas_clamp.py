"""dom_extractor 画布视口对齐回归测试（方案 A /  后续）。

锁定 `_clamp_elements_to_canvas` 的行为契约：
- 完全在画布外的元素丢弃（浏览器 overflow:hidden 下本来就不可见）
- 部分越界的任意类型元素保留原 bbox（交给 PPT 视口裁切 + structural lint）
- 画布内元素几何零变化
"""

from __future__ import annotations

from unittest import TestCase

CANVAS_W = 1280.0
CANVAS_H = 720.0


def _el(etype: str, x: float, y: float, w: float, h: float, **extra) -> dict:
    return {"id": f"{etype}-{x}-{y}", "type": etype, "x": x, "y": y, "width": w, "height": h, **extra}


class ClampElementsToCanvasTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.dom_extractor import _clamp_elements_to_canvas
        cls.clamp = staticmethod(_clamp_elements_to_canvas)

    def test_inside_elements_untouched(self):
        els = [_el("shape", 80, 272, 262, 256), _el("text", 80, 101, 319, 70)]
        out = self.clamp([dict(e) for e in els], CANVAS_W, CANVAS_H)
        self.assertEqual(len(out), 2)
        for orig, got in zip(els, out):
            for k in ("x", "y", "width", "height"):
                self.assertEqual(got[k], orig[k], f"画布内元素 {k} 不应变化")

    def test_fully_offscreen_dropped(self):
        els = [
            _el("shape", 80, 862, 1120, 61),   # y=862 > 720，完全在下方外
            _el("text", 1300, 100, 200, 50),   # x=1300 > 1280，完全在右侧外
            _el("line", 80, 862, 262, 1),      # 完全出画的 connector
        ]
        out = self.clamp(els, CANVAS_W, CANVAS_H)
        self.assertEqual(out, [], "完全出画的元素应全部丢弃")

    def test_partial_shape_keeps_original_geometry(self):
        """方案 A：部分越界 shape 不再 clamp，保留原始几何（装饰圆探边）。"""
        orig = _el("shape", 80, 588, 548, 218)  # 底部越界 86px
        out = self.clamp([dict(orig)], CANVAS_W, CANVAS_H)
        self.assertEqual(len(out), 1)
        el = out[0]
        for k in ("x", "y", "width", "height"):
            self.assertEqual(el[k], orig[k], f"部分越界 shape 的 {k} 应原样保留")

    def test_negative_origin_shape_keeps_geometry(self):
        """封面装饰圆：left/top 为负，应保留负坐标 bbox。"""
        orig = _el("shape", -40, -20, 200, 100)
        out = self.clamp([dict(orig)], CANVAS_W, CANVAS_H)
        self.assertEqual(len(out), 1)
        el = out[0]
        self.assertEqual((el["x"], el["y"]), (-40.0, -20.0))
        self.assertEqual((el["width"], el["height"]), (200.0, 100.0))

    def test_text_image_line_partial_overflow_kept(self):
        els = [
            _el("text", 218, 705, 270, 50),    # 底部越界 35px
            _el("image", 1200, 600, 200, 200),  # 右下越界
            _el("line", 82, 700, 1, 61),        # 底部越界的竖线
        ]
        out = self.clamp([dict(e) for e in els], CANVAS_W, CANVAS_H)
        self.assertEqual(len(out), 3, "部分越界的 text/image/line 应保留")
        for orig, got in zip(els, out):
            for k in ("x", "y", "width", "height"):
                self.assertEqual(got[k], orig[k], f"{orig['type']} 不应被改几何")

    def test_rotated_shape_partial_overflow_kept(self):
        el = _el("shape", 1200, 600, 200, 200, rotate=45)
        out = self.clamp([dict(el)], CANVAS_W, CANVAS_H)
        self.assertEqual(out[0]["width"], 200)
        self.assertEqual(out[0]["x"], 1200)

    def test_top_edge_zero_height_line_kept(self):
        # y=0 且 h≈0 的顶边 connector 不应被"完全出画"误杀
        out = self.clamp([_el("line", 80, 0, 262, 0)], CANVAS_W, CANVAS_H)
        self.assertEqual(len(out), 1)

    def test_zero_canvas_noop(self):
        els = [_el("shape", 80, 862, 1120, 61)]
        self.assertEqual(self.clamp(els, 0, 0), els, "非法画布尺寸时不做任何处理")
