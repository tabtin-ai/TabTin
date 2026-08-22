"""
Wave 5b 场景验证修复回归测试

SP1-05: canvas_width/canvas_height 负值/零值校验
SP1-13: batch_update_elements 部分跳过时返回 skipped 列表
SP1-14: batch_update_elements 元素不存在时记录到 skipped（与单元素 404 对齐）
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from unittest import TestCase

from pydantic import BaseModel, Field, ValidationError
from typing import Any, Dict, List, Optional


_BASE = Path(__file__).resolve().parent.parent


# ============================================================================
# SP1-05: 镜像 Schema 验证（避免 Django import 链）
# ============================================================================

class _ProjectCreateRequestMirror(BaseModel):
    """Mirror of ProjectCreateRequest with the same validation rules."""
    organization_id: str
    space_id: str
    name: str = "未命名演示文稿"
    preset: str = "ppt"
    canvas_width: Optional[int] = Field(default=None, ge=1)
    canvas_height: Optional[int] = Field(default=None, ge=1)


class _ProjectUpdateRequestMirror(BaseModel):
    """Mirror of ProjectUpdateRequest with the same validation rules."""
    name: Optional[str] = None
    preset: Optional[str] = None
    canvas_width: Optional[int] = Field(default=None, ge=1)
    canvas_height: Optional[int] = Field(default=None, ge=1)


class CanvasDimensionValidationTests(TestCase):
    """SP1-05: canvas_width/canvas_height 必须 >= 1。"""

    def test_create_negative_canvas_width_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            _ProjectCreateRequestMirror(
                organization_id="ws1", space_id="sp1", name="test",
                canvas_width=-1, canvas_height=540,
            )
        errors = ctx.exception.errors()
        field_names = [e["loc"][-1] for e in errors]
        self.assertIn("canvas_width", field_names)

    def test_create_zero_canvas_width_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            _ProjectCreateRequestMirror(
                organization_id="ws1", space_id="sp1", name="test",
                canvas_width=0, canvas_height=540,
            )
        errors = ctx.exception.errors()
        field_names = [e["loc"][-1] for e in errors]
        self.assertIn("canvas_width", field_names)

    def test_create_negative_canvas_height_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            _ProjectCreateRequestMirror(
                organization_id="ws1", space_id="sp1", name="test",
                canvas_width=960, canvas_height=-100,
            )
        errors = ctx.exception.errors()
        field_names = [e["loc"][-1] for e in errors]
        self.assertIn("canvas_height", field_names)

    def test_create_valid_dimensions_accepted(self):
        req = _ProjectCreateRequestMirror(
            organization_id="ws1", space_id="sp1", name="test",
            canvas_width=960, canvas_height=540,
        )
        self.assertEqual(req.canvas_width, 960)
        self.assertEqual(req.canvas_height, 540)

    def test_create_none_dimensions_accepted(self):
        req = _ProjectCreateRequestMirror(organization_id="ws1", space_id="sp1", name="test")
        self.assertIsNone(req.canvas_width)
        self.assertIsNone(req.canvas_height)

    def test_create_min_value_1_accepted(self):
        req = _ProjectCreateRequestMirror(
            organization_id="ws1", space_id="sp1", name="test",
            canvas_width=1, canvas_height=1,
        )
        self.assertEqual(req.canvas_width, 1)
        self.assertEqual(req.canvas_height, 1)

    def test_update_negative_canvas_width_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            _ProjectUpdateRequestMirror(canvas_width=-5)
        errors = ctx.exception.errors()
        field_names = [e["loc"][-1] for e in errors]
        self.assertIn("canvas_width", field_names)

    def test_update_zero_canvas_height_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            _ProjectUpdateRequestMirror(canvas_height=0)
        errors = ctx.exception.errors()
        field_names = [e["loc"][-1] for e in errors]
        self.assertIn("canvas_height", field_names)

    def test_update_valid_dimensions_accepted(self):
        req = _ProjectUpdateRequestMirror(canvas_width=1920, canvas_height=1080)
        self.assertEqual(req.canvas_width, 1920)
        self.assertEqual(req.canvas_height, 1080)


# ============================================================================
# SP1-05: 源码验证 — 确保实际 Schema 文件也有 ge=1 约束
# ============================================================================


class CanvasDimensionSourceValidationTests(TestCase):
    """SP1-05: schemas.py 源码中 canvas_width/canvas_height 必须有 ge=1 约束。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = (_BASE / "schemas.py").read_text(encoding="utf-8")

    def test_create_schema_canvas_width_has_ge_1(self):
        pattern = r"canvas_width.*Field\(.*ge\s*=\s*1"
        self.assertRegex(self._source, pattern)

    def test_create_schema_canvas_height_has_ge_1(self):
        pattern = r"canvas_height.*Field\(.*ge\s*=\s*1"
        self.assertRegex(self._source, pattern)


# ============================================================================
# SP1-13 / SP1-14: batch_update_elements skipped 字段的结构验证（代码级）
# ============================================================================


class BatchUpdateSkippedFieldTests(TestCase):
    """SP1-13/SP1-14: slide_service.batch_update_elements 必须返回 skipped 列表。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        svc_path = _BASE / "services" / "slide_service.py"
        cls._source = svc_path.read_text(encoding="utf-8")

    def test_batch_update_returns_skipped_key(self):
        self.assertIn('"skipped"', self._source)

    def test_skipped_list_initialized(self):
        self.assertIn("skipped = []", self._source)

    def test_page_not_found_records_skipped(self):
        self.assertIn('"reason": "page_not_found"', self._source)

    def test_element_not_found_records_skipped(self):
        self.assertIn('"reason": "element_not_found"', self._source)

    def test_return_dict_includes_skipped(self):
        tree = ast.parse(self._source)
        found_skipped_in_return = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
                for key in node.value.keys:
                    if isinstance(key, ast.Constant) and key.value == "skipped":
                        found_skipped_in_return = True
                        break
        self.assertTrue(
            found_skipped_in_return,
            "batch_update_elements 的 return dict 必须包含 'skipped' 键",
        )
