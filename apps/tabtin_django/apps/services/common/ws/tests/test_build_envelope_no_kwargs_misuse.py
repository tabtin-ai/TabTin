"""
R6-CROSS-1（Wave 7）lint 防回归：禁止 ``build_envelope(message_type=...)``
kwargs 误用。

背景：
  Wave 7 之前，5 处生产代码用 ``build_envelope(message_type=..., request_id=...,
  payload=...)`` 调用，其中前 3 个参数被 protocol.py PEP 570 ``/`` 标记为
  positional-only，触发 TypeError 被外层 ``except Exception`` 静默吞，导致：
    - agent runtime 事件转发失败
    - Daemon 离线通知失败
    - Checkpoint dispatch 失败
    - notification step 失败
    - SSH streaming 输出整体崩溃

  test_build_envelope_positional_contract.py 在 callsite 级别测试时已经能挡住，
  但只在测试覆盖到的场景才发现；本 lint 测试做静态 AST 扫描兜底，让任何位置的
  真实 callsite 用 kwargs 调用 message_type / request_id / payload 都能在 CI
  期就 fail，避免回归。

实现选择 AST 而不是正则：
  - 正则会误命中 docstring / 注释里的反例描述（已踩坑：
    历史 docstring 写 "build_envelope(message_type=..."
    作为反例就被命中）；
  - AST 只解析真实 Call 节点的 keywords，docstring 字符串字面量天然忽略。

扫描范围：
  apps/tabtin_django/apps + packages 下的所有 .py 源文件。
"""
from __future__ import annotations

import ast
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402


# 仓库根：apps/tabtin_django/apps/services/common/ws/tests/<file>
#                                                              ^0  ^1 ^2     ^3      ^4   ^5             ^6   ^7=TabTinAgent
_REPO_ROOT = Path(__file__).resolve().parents[7]
_SCAN_DIRS = [
    _REPO_ROOT / "apps" / "tabtin_django" / "apps",
    _REPO_ROOT / "packages",
]

# build_envelope 前 3 个 positional-only 参数名
_FORBIDDEN_KW = frozenset({"message_type", "request_id", "payload"})

# 允许在以下文件出现 kwargs 误用（反向回归测试本身需要演示违规会抛 TypeError）。
# 必须 .resolve() 与 _iter_py_files 内的 p.resolve() 比较一致。
_ALLOWED_FILES = {
    Path(__file__).resolve(),
    (Path(__file__).resolve().parent / "test_build_envelope_positional_contract.py").resolve(),
}


def _iter_py_files():
    for base in _SCAN_DIRS:
        if not base.exists():
            continue
        for p in base.rglob("*.py"):
            if any(part in {"node_modules", ".venv", "venv", "__pycache__", "migrations"}
                   for part in p.parts):
                continue
            if p.resolve() in _ALLOWED_FILES:
                continue
            yield p


def _violations_in_file(path: Path) -> list[str]:
    """AST 扫描单个 .py，返回 ``[file:line  -> kw_name]`` 字符串列表。"""
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    if "build_envelope" not in text:
        return []
    try:
        tree = ast.parse(text, filename=str(path))
    except SyntaxError:
        # 损坏的 .py（极少见）跳过，让独立 syntax check 工具去抓
        return []

    violations: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # 函数调用名形态：``build_envelope(...)`` 或 ``mod.build_envelope(...)``
        func = node.func
        if isinstance(func, ast.Name) and func.id == "build_envelope":
            pass
        elif isinstance(func, ast.Attribute) and func.attr == "build_envelope":
            pass
        else:
            continue
        for kw in node.keywords:
            if kw.arg in _FORBIDDEN_KW:
                rel = path.relative_to(_REPO_ROOT)
                violations.append(f"{rel}:{node.lineno}  -> {kw.arg}=...")
    return violations


class TestBuildEnvelopeNoKwargsMisuse(SimpleTestCase):
    """AST 扫描所有 .py，禁止 ``build_envelope(message_type=...)`` 等 kwargs 误用。"""

    def test_no_callsite_uses_kwargs_for_positional_only_args(self):
        all_violations: list[str] = []
        for path in _iter_py_files():
            all_violations.extend(_violations_in_file(path))

        self.assertFalse(
            all_violations,
            msg=(
                "build_envelope 前 3 个参数（message_type/request_id/payload）"
                "必须 positional 调用。下列 callsite 违规会触发 R6-CROSS-1 类 "
                "silent broken：\n  " + "\n  ".join(all_violations)
            ),
        )

    def test_allowed_files_must_be_test_files_only(self):
        """W7-Review-F5（技术 Reviewer P1 修复）：守卫 ``_ALLOWED_FILES`` 不被
        滥用绕过 lint。

        防御场景：
          - 未来 contributor 想"快速过 CI"把生产文件加进 _ALLOWED_FILES
          - PR 评审者漏看 _ALLOWED_FILES 变更
          - R6-CROSS-1 类 silent broken 灾难复发

        强约束：_ALLOWED_FILES 只允许同目录下 ``test_build_envelope_*.py``
        测试文件（contract 测试自身需要演示反例）。任何生产路径 / 非测试 /
        其他目录都视为 lint 后门，必须 fail。
        """
        # 解析后的 _ALLOWED_FILES 必须只包含本目录下 test_build_envelope_*.py
        allowed_dir = Path(__file__).resolve().parent
        for p in _ALLOWED_FILES:
            self.assertTrue(
                p.name.startswith("test_build_envelope_") and p.name.endswith(".py"),
                msg=(
                    f"_ALLOWED_FILES 只允许 test_build_envelope_*.py 例外，"
                    f"违规路径：{p}\n"
                    "禁止把生产文件 / 其他测试加入白名单（这会架空 R6-CROSS-1 防回归）。"
                ),
            )
            self.assertEqual(
                p.parent.resolve(), allowed_dir,
                msg=(
                    f"_ALLOWED_FILES 路径必须在 {allowed_dir} 目录下，"
                    f"违规路径：{p}（跨目录例外不允许）"
                ),
            )

    def test_allowed_files_size_capped_to_prevent_silent_growth(self):
        """W7-Review-F5：硬上限 4，防止 _ALLOWED_FILES 静默膨胀。

        当前合法例外：
          - 本 lint 测试自身（test_build_envelope_no_kwargs_misuse.py）
          - contract 测试（test_build_envelope_positional_contract.py）

        留 2 条余量给未来必要扩展（如 test_build_envelope_perf.py 等），
        但任何超过 4 条都视为可疑——必须先评估是否在用 lint 例外掩盖真实违规。
        """
        self.assertLessEqual(
            len(_ALLOWED_FILES), 4,
            msg=(
                f"_ALLOWED_FILES 当前 {len(_ALLOWED_FILES)} 条已超过硬上限 4。"
                "若确实需要扩展，请先在 PR 描述中说明每条例外的合法性，"
                "并同步更新本测试的硬上限值。"
            ),
        )


if __name__ == "__main__":
    unittest.main()
