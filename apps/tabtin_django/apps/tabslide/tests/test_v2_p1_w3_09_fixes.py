"""
V2 Wave3-09 修复回归测试

P1 修复:
  - I3-02: restore_history / restore_pages_from_snapshot 调用 run_post_save_hooks
  - I3-10: cleanup_slide_history 保护全量 base_history 引用（不限非过期）
  - I4-04: editing/ 目录所有文件直接导入 defusedxml（无 ImportError 兜底）
  - I4-11: pack.py 使用 .validate 相对导入

P2 修复:
  - I2-04: save_pages_incremental 新页面 order 基于全局 max order
  - I2-10: changed_pages 与 deleted_page_ids 交集校验
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import logging
import textwrap
from pathlib import Path
from unittest import TestCase, mock

_BASE = Path(__file__).resolve().parents[1]
_SVC_PATH = _BASE / "services" / "slide_service.py"
_TASKS_PATH = _BASE / "tasks.py"
_EDITING_DIR = _BASE / "services" / "editing"


# ============================================================================
# I3-02: restore_history / restore_pages_from_snapshot 调用 run_post_save_hooks
# ============================================================================


class RestoreHistoryPostSaveHooksTests(TestCase):
    """I3-02: restore_history 路径应调用 run_post_save_hooks 统一入口。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = _SVC_PATH.read_text(encoding="utf-8")

    def test_restore_history_calls_run_post_save_hooks(self):
        """restore_history 方法体中必须调用 run_post_save_hooks。"""
        tree = ast.parse(self._source)
        found = False
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "restore_history":
                body_source = ast.get_source_segment(self._source, node)
                if body_source and "run_post_save_hooks" in body_source:
                    found = True
                    break
        self.assertTrue(found, "restore_history should call run_post_save_hooks")

    def test_restore_history_no_manual_record_change(self):
        """restore_history 不应再手动调用 _record_change（由 post_save 统一处理）。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "restore_history":
                body_source = ast.get_source_segment(self._source, node)
                self.assertNotIn(
                    "_record_change",
                    body_source or "",
                    "restore_history should not manually call _record_change",
                )
                break

    def test_restore_history_passes_create_history_true(self):
        """run_post_save_hooks 调用应含 create_history=True。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "restore_history":
                body_source = ast.get_source_segment(self._source, node) or ""
                self.assertIn("create_history=True", body_source)
                self.assertIn("force_history=True", body_source)
                break

    def test_restore_pages_from_snapshot_calls_run_post_save_hooks(self):
        """restore_pages_from_snapshot 也应调用 run_post_save_hooks。"""
        tree = ast.parse(self._source)
        found = False
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "restore_pages_from_snapshot":
                body_source = ast.get_source_segment(self._source, node)
                if body_source and "run_post_save_hooks" in body_source:
                    found = True
                    break
        self.assertTrue(found, "restore_pages_from_snapshot should call run_post_save_hooks")

    def test_restore_pages_from_snapshot_no_manual_record_change(self):
        """restore_pages_from_snapshot 不应手动调用 _record_change。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "restore_pages_from_snapshot":
                body_source = ast.get_source_segment(self._source, node)
                self.assertNotIn(
                    "_record_change",
                    body_source or "",
                )
                break


# ============================================================================
# I3-10: cleanup_slide_history 保护全量 base_history 引用
# ============================================================================


class CleanupHistoryProtectionTests(TestCase):
    """I3-10: 过期记录删除应保护所有被引用的 base_history，不限于未过期记录。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = _TASKS_PATH.read_text(encoding="utf-8")

    def test_no_status_filter_on_protection_query(self):
        """保护集查询不应包含 is_named/pinned/expired_at 过滤条件。

        旧代码仅保护「有效 diff」（非过期/命名/置顶）的 base_history，
        导致多级链中过期中间节点的 base 被误删。
        修复后应保护被任何 diff 引用的 base_history。
        """
        tree = ast.parse(self._source)
        func_node = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "cleanup_slide_history":
                func_node = node
                break
        self.assertIsNotNone(func_node, "cleanup_slide_history function should exist")

        body_src = ast.get_source_segment(self._source, func_node) or ""

        # 找到 protected_snapshot_ids 赋值后，不应有 is_named/pinned/expired_at 过滤
        # （它在 step 1 区域，referenced_snapshot_ids 在 step 2 区域同样无过滤）
        lines = body_src.split("\n")
        in_protected_block = False
        violation_found = False
        for line in lines:
            if "protected_snapshot_ids" in line and "=" in line:
                in_protected_block = True
            if in_protected_block:
                if "is_named" in line or "pinned" in line or "expired_at" in line:
                    # 允许在 filter(base_history__isnull=False) 行之外的 Q 条件
                    if "Q(" in line:
                        violation_found = True
                if ")" in line and "values_list" in line:
                    in_protected_block = False
                    break

        self.assertFalse(
            violation_found,
            "protected_snapshot_ids query should NOT filter by is_named/pinned/expired_at status",
        )

    def test_referenced_snapshot_ids_also_unfiltered(self):
        """step 2 的 referenced_snapshot_ids 同样不应有状态过滤。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "cleanup_slide_history":
                body_src = ast.get_source_segment(self._source, node) or ""
                # referenced_snapshot_ids 在 step 2 用，确保无状态过滤
                ref_idx = body_src.find("referenced_snapshot_ids")
                self.assertGreater(ref_idx, 0)
                ref_block = body_src[ref_idx:ref_idx + 300]
                self.assertNotIn("Q(is_named", ref_block)
                self.assertNotIn("Q(pinned", ref_block)
                break


# ============================================================================
# I4-04: editing/ 目录直接导入 defusedxml
# ============================================================================


class DefusedxmlDirectImportTests(TestCase):
    """I4-04: editing/ 下所有文件应直接导入 defusedxml，无 ImportError 兜底回退。"""

    _EDITING_FILES = [
        "validate.py",
        "clean.py",
        "pack.py",
        "unpack.py",
        "slide_ops.py",
        "template_fill.py",
    ]

    def test_no_importerror_fallback_for_defusedxml(self):
        """任何 editing 文件都不应有 `except ImportError` 回退到 stdlib xml。"""
        for fname in self._EDITING_FILES:
            fpath = _EDITING_DIR / fname
            if not fpath.exists():
                continue
            source = fpath.read_text(encoding="utf-8")
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler):
                    if node.type and isinstance(node.type, ast.Name) and node.type.id == "ImportError":
                        handler_src = ast.get_source_segment(source, node) or ""
                        self.assertNotIn(
                            "xml.etree.ElementTree",
                            handler_src,
                            f"{fname} should not fall back to stdlib ET on ImportError",
                        )

    def test_defusedxml_is_imported(self):
        """每个 editing 文件应有 defusedxml 导入。"""
        for fname in self._EDITING_FILES:
            fpath = _EDITING_DIR / fname
            if not fpath.exists():
                continue
            source = fpath.read_text(encoding="utf-8")
            self.assertIn(
                "defusedxml",
                source,
                f"{fname} should import from defusedxml",
            )


# ============================================================================
# I4-11: pack.py 使用相对导入
# ============================================================================


class PackRelativeImportTests(TestCase):
    """I4-11: pack.py validate 调用应使用包内相对导入。"""

    def test_pack_uses_relative_import_for_validate(self):
        """pack.py 应使用 `from .validate import` 而非 `from validate import`。"""
        fpath = _EDITING_DIR / "pack.py"
        if not fpath.exists():
            self.skipTest("pack.py not found")
        source = fpath.read_text(encoding="utf-8")
        self.assertIn("from .validate import", source)
        self.assertNotIn("\nfrom validate import", source)


# ============================================================================
# I2-04: save_pages_incremental 新页面 order 基于全局 max
# ============================================================================


class NewPageOrderTests(TestCase):
    """I2-04: 新页面 order 应基于项目全局 max order 而非局部变更行数。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = _SVC_PATH.read_text(encoding="utf-8")

    def test_new_page_order_uses_aggregate_max(self):
        """save_pages_incremental 中新页面 order 应使用 aggregate(Max('order'))。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "save_pages_incremental":
                body_src = ast.get_source_segment(self._source, node) or ""
                self.assertIn(
                    "Max",
                    body_src,
                    "Should use models.Max or Max aggregate for order calculation",
                )
                break
        else:
            self.fail("save_pages_incremental not found")

    def test_no_len_existing_rows_for_order(self):
        """order 计算不应再使用 len(existing_rows)。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "save_pages_incremental":
                body_src = ast.get_source_segment(self._source, node) or ""
                self.assertNotIn(
                    "len(existing_rows) + len(upsert_objects)",
                    body_src,
                    "Should not use len(existing_rows) for new page order",
                )
                break


# ============================================================================
# I2-10: changed_pages 与 deleted_page_ids 交集校验
# ============================================================================


class ChangedDeletedOverlapTests(TestCase):
    """I2-10: save_pages_incremental 应检测并处理交集页面。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = _SVC_PATH.read_text(encoding="utf-8")

    def test_overlap_detection_exists(self):
        """save_pages_incremental 应检查 changed_pages 与 deleted_page_ids 的交集。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "save_pages_incremental":
                body_src = ast.get_source_segment(self._source, node) or ""
                has_overlap_check = (
                    "overlap" in body_src.lower()
                    or ("changed_pages" in body_src and "deleted_page_ids" in body_src and "&" in body_src)
                )
                self.assertTrue(
                    has_overlap_check,
                    "Should detect overlap between changed_pages and deleted_page_ids",
                )
                break

    def test_overlap_removes_from_changed(self):
        """交集页面应从 changed_pages 中移除（delete 优先）。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "save_pages_incremental":
                body_src = ast.get_source_segment(self._source, node) or ""
                self.assertIn(
                    "del changed_pages",
                    body_src,
                    "Overlapping pages should be removed from changed_pages",
                )
                break

    def test_overlap_logs_warning(self):
        """交集应记录 warning 日志。"""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "save_pages_incremental":
                body_src = ast.get_source_segment(self._source, node) or ""
                self.assertIn(
                    "logger.warning",
                    body_src,
                    "Overlap should be logged as warning",
                )
                break
