"""
User-context wrapper type 双端 contract test。

TS SSoT: packages/agent-prompt/src/user-context-wrapper.ts
  VALID_USER_CONTEXT_WRAPPER_TYPES

Python mirror: apps/services/agent_execution/user_context_wrapper.py
  VALID_TYPES

Contract JSON: packages/agent-prompt/user-context-wrapper-types.contract.json
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from apps.services.agent_execution.user_context_wrapper import VALID_TYPES

_REPO_ROOT = Path(__file__).resolve().parents[6]
_CONTRACT_JSON = (
    _REPO_ROOT
    / "packages"
    / "agent-prompt"
    / "user-context-wrapper-types.contract.json"
)


class TestUserContextWrapperTypeContract(unittest.TestCase):
    def test_python_valid_types_match_contract_json(self):
        raw = json.loads(_CONTRACT_JSON.read_text(encoding="utf-8"))
        self.assertIsInstance(raw, list)
        self.assertEqual(sorted(VALID_TYPES), sorted(raw))

    def test_mode_reminder_present(self):
        self.assertIn("mode-reminder", VALID_TYPES)


class TestAgentModeContractDeadCodeGuard(unittest.TestCase):
    """
    TD-4 (Phase 4)：守门测试，防止生产代码意外引用已声明 DEAD 的 contract API。

    `is_tool_allowed_for_mode` / `filter_tool_names_for_mode` /
    `explain_tool_mode_decision` 在软拒架构落地后 Django 生产 0 调用。
    保留实现作 audit / 未来 server-side enforcement 预留入口，但禁止 apps/services/
    下非 test 文件引用——避免悄悄复活死代码后再次和 TS 端漂移。
    """

    DEAD_NAMES = (
        "is_tool_allowed_for_mode",
        "filter_tool_names_for_mode",
        "explain_tool_mode_decision",
    )
    # 守门 root：覆盖所有 Django 子包；过滤掉 tests/ 目录、本文件本身、
    # 以及 agent_mode_contract.py 自身（声明 + DEAD 注释里包含这些名字）。
    SCAN_ROOT = (
        _REPO_ROOT
        / "apps"
        / "tabtin_django"
        / "apps"
        / "services"
    )

    def _iter_python_files(self):
        for path in self.SCAN_ROOT.rglob("*.py"):
            # 跳过测试目录
            if any(part == "tests" or part.startswith("test_") for part in path.parts):
                continue
            # 跳过本死代码定义文件
            if path.name == "agent_mode_contract.py":
                continue
            yield path

    def test_no_production_consumer_imports_dead_apis(self):
        offenders = []
        for path in self._iter_python_files():
            text = path.read_text(encoding="utf-8")
            for name in self.DEAD_NAMES:
                # 简单子串匹配：import / 调用 / 字符串引用都视为命中——
                # 守门测试宁可严格，让违规者必须显式取消守门（在 test 里加白名单）。
                if name in text:
                    offenders.append((path.relative_to(_REPO_ROOT), name))
        self.assertEqual(
            offenders,
            [],
            msg=(
                "TD-4 守门：以下生产文件引用了已声明 DEAD 的 agent_mode_contract API。"
                " 软拒架构后这些 API 在 Django 生产 0 调用，新加引用属于退化。"
                " 如果确实需要复活，请先在总控 §7.6 TD-4 改决策并移除本测试。"
                f" Offenders: {offenders}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
