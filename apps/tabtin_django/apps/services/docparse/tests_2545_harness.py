"""
#2545 acceptance harness —— 云端 xlsx 解析路径 (openpyxl, read_only=True)。

目的：用真实 .xlsx fixture 跑 ExcelParser.parse，提取每个 sheet 的行列维度，
对比本地 SheetJS 路径（见 xlsx-2545-harness.test.ts），定位"偶现 1×1"根因。

为什么用 SimpleTestCase：ExcelParser 是纯解析器（openpyxl + dataclass），
不碰 DB；用 SimpleTestCase 避免 PG 测试库依赖，worktree 自包含可跑。

核心复现 fixture：wrong_dimension.xlsx（实际 3×4 数据，但 <dimension ref="A1"/>）。
预期（当前 buggy 行为）：openpyxl read_only 信任 <dimension> 截断 iter_rows → 1×1。
该断言故意锁定 buggy 现状；fix PR 落地后翻转断言为 3×4。

复跑：
  USE_SQLITE_FOR_TESTS=0 python apps/tabtin_django/manage.py test \\
      apps.services.docparse.tests_2545_harness --verbosity=2

结果 JSON 写到 apps/tabtin-electron/fixtures/poc-xlsx/_harness-results/cloud.json
（_harness-results/ 已 gitignore，仅中间产物；最终对比表落档到
 docs/agent/xlsx-parse-acceptance-harness.md）。
"""
from __future__ import annotations

import json
import os

from django.test import SimpleTestCase

from apps.services.docparse.parsers.xlsx_parser import ExcelParser

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
# apps/tabtin_django/apps/services/docparse -> apps/tabtin-electron/fixtures/poc-xlsx
FIXTURES_DIR = os.path.abspath(
    os.path.join(_THIS_DIR, "..", "..", "..", "..", "tabtin-electron", "fixtures", "poc-xlsx")
)
RESULTS_DIR = os.path.join(FIXTURES_DIR, "_harness-results")
RESULTS_JSON = os.path.join(RESULTS_DIR, "cloud.json")

# (fixture, 期望 sheet 数, 期望 (rows, cols) of 第一个 sheet, 说明)
# 期望维度 = 修复后正确行为（wrong_dimension 经 reset_dimensions 重扫得 3×4）。
FIXTURE_EXPECTATIONS = [
    ("normal_3x4.xlsx", 1, (3, 4), "基线：3×4 普通数据，两条路径都应得 3×4"),
    ("inf_nan.xlsx", 1, (3, 4), "含 inf/nan：维度保留，DP-007 已修 inf/nan 不崩"),
    ("empty_sheet.xlsx", 1, (3, 4), "空 sheet 被 _read_sheet_rows 跳过（if not rows: continue），只剩 HasData"),
    ("merged_cell.xlsx", 1, (3, 4), "合并单元格：只有左上角持值，但维度仍 3×4"),
    ("wrong_dimension.xlsx", 1, (3, 4), "修复后：<dimension ref=A1/> 经 reset_dimensions 重扫得 3×4"),
    ("missing_dimension.xlsx", 1, (3, 4), "无 <dimension>：max_row=None → 全扫，不受影响"),
    ("formula_no_cache.xlsx", 1, (3, 4), "公式无缓存：data_only 下公式格 None；首行 header 撑住维度"),
]


def _extract_dims(parse_result) -> list[dict]:
    """从 ParseResult.pages[].chunks[0].metadata 抽 rows/cols。"""
    sheets = []
    for page in parse_result.pages:
        if not page.chunks:
            continue
        md = page.chunks[0].metadata or {}
        sheets.append({
            "sheet_name": md.get("sheet_name", ""),
            "rows": md.get("rows", 0),
            "cols": md.get("cols", 0),
            "chunk_type": page.chunks[0].chunk_type,
        })
    return sheets


class Xlsx2545CloudHarness(SimpleTestCase):
    """云端 openpyxl 路径 fixture 对比。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        os.makedirs(RESULTS_DIR, exist_ok=True)
        cls._results: dict[str, dict] = {}

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        with open(RESULTS_JSON, "w", encoding="utf-8") as f:
            json.dump(cls._results, f, ensure_ascii=False, indent=2)
        print(f"\n[#2545 cloud] results → {RESULTS_JSON}")

    def _run_fixture(self, fixture_name: str):
        path = os.path.join(FIXTURES_DIR, fixture_name)
        self.assertTrue(os.path.exists(path), f"fixture 缺失: {path}")
        parser = ExcelParser()
        result = parser.parse(path)
        sheets = _extract_dims(result)
        self._results[fixture_name] = {
            "path": path,
            "page_count": len(result.pages),
            "sheets": sheets,
            "title": result.title,
        }
        return sheets

    def test_normal_3x4(self):
        sheets = self._run_fixture("normal_3x4.xlsx")
        self.assertEqual(len(sheets), 1)
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4))

    def test_inf_nan(self):
        sheets = self._run_fixture("inf_nan.xlsx")
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4))

    def test_empty_sheet_skipped(self):
        sheets = self._run_fixture("empty_sheet.xlsx")
        # 空 sheet 被 _read_sheet_rows 跳过 → 只剩 1 个 sheet (HasData)
        self.assertEqual(len(sheets), 1)
        self.assertEqual(sheets[0]["sheet_name"], "HasData")
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4))

    def test_merged_cell(self):
        sheets = self._run_fixture("merged_cell.xlsx")
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4))

    def test_wrong_dimension_rescanned_to_3x4(self):
        """修复后回归：openpyxl read_only 经 reset_dimensions 不再被 <dimension ref=A1/> 截断。

        fix  落地后，_read_sheet_rows 入口调 ws.reset_dimensions()，
        iter_rows 按实际单元格全扫 → 3×4。
        """
        sheets = self._run_fixture("wrong_dimension.xlsx")
        self.assertEqual(len(sheets), 1)
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4),
                         "reset_dimensions 后 wrong dimension 不再截断，应得 3×4")

    def test_missing_dimension_unaffected(self):
        sheets = self._run_fixture("missing_dimension.xlsx")
        self.assertEqual((sheets[0]["rows"], sheets[0]["cols"]), (3, 4))

    def test_formula_no_cache(self):
        sheets = self._run_fixture("formula_no_cache.xlsx")
        self.assertGreaterEqual(sheets[0]["rows"], 1)
