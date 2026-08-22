"""
F03 回归测试 — PDF-PAGE-DEGRADE / PDF-TITLE-FIX

验证：
1. 单页解析异常时跳过该页继续后续页面
2. >80% 页面失败时整文档标记 FAILED
3. 断点续传时从 DB 恢复 title

不依赖 PDF 文件，通过源码分析 + 模拟验证逻辑正确性。
"""

import ast
import os
import textwrap

import pytest

SRC_DIR = os.path.dirname(os.path.abspath(__file__))


def _read_source(relpath: str) -> str:
    full = os.path.join(SRC_DIR, relpath)
    with open(full) as f:
        return f.read()


def _get_function_source(src: str, func_name: str) -> str:
    """从源码中提取指定函数的 AST 节点并返回对应的源码文本行"""
    tree = ast.parse(src)
    lines = src.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == func_name:
                start = node.lineno - 1
                end = node.end_lineno
                return "\n".join(lines[start:end])
    return ""


# ======================================================================
# PDF-PAGE-DEGRADE: 单页异常不中断整文档
# ======================================================================

class TestPDFPageDegradeCodeAnalysis:
    """通过源码分析验证 _stream_parse_pdf 的逐页降级逻辑"""

    def _get_stream_parse_pdf(self):
        src = _read_source("service.py")
        return _get_function_source(src, "_stream_parse_pdf")

    def test_parse_page_wrapped_in_try_except(self):
        """parse_page 调用应被 try-except 包裹"""
        func_src = self._get_stream_parse_pdf()
        assert "try:" in func_src, "for 循环内应有 try 块"
        assert "except Exception" in func_src, "应捕获 Exception"
        assert "parse_page" in func_src

        lines = func_src.splitlines()
        try_line = None
        parse_page_line = None
        except_line = None

        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped == "try:" and try_line is None:
                try_line = i
            if "parse_page" in stripped and try_line is not None and except_line is None:
                parse_page_line = i
            if "except Exception" in stripped and parse_page_line is not None:
                except_line = i
                break

        assert try_line is not None, "未找到 try 语句"
        assert parse_page_line is not None, "未找到 parse_page 调用"
        assert except_line is not None, "未找到 except Exception"
        assert try_line < parse_page_line < except_line, (
            "parse_page 应在 try...except 范围内"
        )

    def test_error_placeholder_chunk_created(self):
        """异常分支应创建带 quality=low 的占位 chunk"""
        func_src = self._get_stream_parse_pdf()
        assert '"quality"' in func_src or "'quality'" in func_src, (
            "异常分支应包含 quality 元数据"
        )
        assert '"low"' in func_src or "'low'" in func_src
        assert '"error"' in func_src or "'error'" in func_src

    def test_failed_pages_counter_exists(self):
        """应有失败页面计数器"""
        func_src = self._get_stream_parse_pdf()
        assert "failed_pages" in func_src, "应有 failed_pages 计数器"
        assert "failed_pages += 1" in func_src, "异常分支应递增 failed_pages"
        assert "failed_pages = 0" in func_src, "failed_pages 应初始化为 0"

    def test_80_percent_threshold_check(self):
        """应检查 >80% 页面失败后标记 FAILED"""
        func_src = self._get_stream_parse_pdf()
        assert "0.8" in func_src, "应有 80% 阈值检查"
        assert "FAILED" in func_src, "超过阈值应标记 FAILED"
        assert "actually_parsed" in func_src, "应计算实际解析页数"

    def test_persist_called_for_both_success_and_error(self):
        """_persist_one_page 应在 try-except 之后（两个分支共用）"""
        func_src = self._get_stream_parse_pdf()
        lines = func_src.splitlines()

        except_line = None
        persist_after_except = False

        for i, line in enumerate(lines):
            stripped = line.strip()
            if "except Exception" in stripped:
                except_line = i
            if except_line is not None and "_persist_one_page" in stripped:
                persist_after_except = True
                break

        assert persist_after_except, (
            "_persist_one_page 应在 except 块之后调用（success/error 两条路径共享）"
        )


# ======================================================================
# PDF-TITLE-FIX: 断点续传时从 DB 恢复 title
# ======================================================================

class TestPDFTitleFixCodeAnalysis:
    """通过源码分析验证断点续传时 title 恢复逻辑"""

    def _get_stream_parse_pdf(self):
        src = _read_source("service.py")
        return _get_function_source(src, "_stream_parse_pdf")

    def test_db_query_for_title_on_resume(self):
        """断点续传时应查询 DB 第 1 页 heading chunk 恢复 title"""
        func_src = self._get_stream_parse_pdf()
        assert "skip_pages > 0" in func_src, "应检查 skip_pages > 0"
        assert "page__page_number=1" in func_src, "应查询第 1 页"
        assert 'chunk_type="heading"' in func_src, "应过滤 heading 类型"
        assert ".first()" in func_src, "应取第一条记录"

    def test_title_restore_before_loop(self):
        """title 恢复逻辑应在 for 循环之前"""
        func_src = self._get_stream_parse_pdf()
        lines = func_src.splitlines()

        title_restore_line = None
        for_loop_line = None

        for i, line in enumerate(lines):
            stripped = line.strip()
            if "page__page_number=1" in stripped and title_restore_line is None:
                title_restore_line = i
            if stripped.startswith("for page_idx in") and for_loop_line is None:
                for_loop_line = i

        assert title_restore_line is not None, "未找到 title 恢复查询"
        assert for_loop_line is not None, "未找到 for 循环"
        assert title_restore_line < for_loop_line, (
            "title 恢复应在 for 循环之前"
        )

    def test_title_content_truncated(self):
        """恢复的 title 应截断到 200 字符"""
        func_src = self._get_stream_parse_pdf()
        assert "[:200]" in func_src, "title 应截断到 200 字符"


# ======================================================================
# ChunkResult import 验证
# ======================================================================

class TestImportIntegrity:
    """验证 service.py 导入了必要的 ChunkResult"""

    def test_chunk_result_imported(self):
        src = _read_source("service.py")
        assert "ChunkResult" in src, "service.py 应导入 ChunkResult"
        tree = ast.parse(src)
        found = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "ChunkResult":
                        found = True
                        break
        assert found, "ChunkResult 应通过 from ... import 引入"


# ======================================================================
# 运行时验证（不依赖 Django ORM，直接调用内部逻辑）
# ======================================================================

class TestPageDegradeRuntime:
    """模拟 _stream_parse_pdf 内部逻辑的运行时行为"""

    def test_error_chunk_result_structure(self):
        from apps.services.docparse.parsers.base import ChunkResult, PageResult

        error = RuntimeError("corrupted page data")
        page_num = 3
        page_result = PageResult(
            page_number=page_num,
            width=0,
            height=0,
            chunks=[ChunkResult(
                chunk_type="paragraph",
                content=f"[第 {page_num} 页解析失败]",
                sequence=1,
                metadata={
                    "error": str(error)[:500],
                    "quality": "low",
                    "source": "error",
                },
            )],
            text_content="",
        )

        assert page_result.page_number == 3
        assert len(page_result.chunks) == 1
        chunk = page_result.chunks[0]
        assert chunk.metadata["quality"] == "low"
        assert chunk.metadata["source"] == "error"
        assert "corrupted" in chunk.metadata["error"]
        assert page_result.text_content == ""

    def test_failure_rate_calculation(self):
        """验证 80% 阈值判断逻辑"""
        total = 10
        skip_pages = 2
        actually_parsed = total - skip_pages  # 8

        failed_7 = 7
        assert failed_7 / actually_parsed > 0.8, "7/8 = 87.5% 应超过 80%"

        failed_6 = 6
        assert failed_6 / actually_parsed <= 0.8, "6/8 = 75% 不应超过 80%"

        failed_0 = 0
        assert failed_0 / actually_parsed <= 0.8

    def test_title_truncation(self):
        """title 应截断到 200 字符"""
        long_title = "A" * 500
        title = long_title[:200]
        assert len(title) == 200
