"""#5441 — tabtin 命令风险表（Go CommandDef.Risk SSoT）测试。

覆盖：
- 生成表 schema 合法（存在、非空、词表三档）
- lookup 最长前缀匹配（2 段 / 3 段命令、flags 截断）
- parser 集成：tabtin 已登记命令走 SSoT 表；未登记命令 fallback yaml
- fail-safe：表不可用时 lookup 返回 None（parser 行为退回 yaml）
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.services.agent_engine.cli import tabtin_command_risk as tcr
from apps.services.agent_engine.cli.parser import CliInvocationParser
from apps.services.agent_engine.cli.spec import RISK_LEVELS

GENERATED_PATH = (
    Path(tcr.__file__).parent / "tabtin_command_risk.generated.json"
)


@pytest.fixture(autouse=True)
def _reset_cache():
    tcr.reset_cache_for_tests()
    yield
    tcr.reset_cache_for_tests()


# ── 生成表 schema ────────────────────────────────────────────────


def test_generated_table_exists_and_valid():
    assert GENERATED_PATH.exists(), (
        "生成表缺失——复跑 `node scripts/gen-tabtin-cli-risk.mjs`"
    )
    data = json.loads(GENERATED_PATH.read_text(encoding="utf-8"))
    commands = data["commands"]
    assert isinstance(commands, dict) and len(commands) > 100
    assert data["command_count"] == len(commands)
    bad = {p: r for p, r in commands.items() if r not in RISK_LEVELS}
    assert not bad, f"生成表含非法风险档: {bad}"
    # 命令路径不应带 tabtin 前缀（codegen 已剥）
    prefixed = [p for p in commands if p.startswith("tabtin ")]
    assert not prefixed, f"命令路径未剥 tabtin 前缀: {prefixed[:3]}"


# ── lookup 前缀匹配 ──────────────────────────────────────────────


def test_lookup_two_segment_command():
    hit = tcr.lookup_tabtin_command_risk(["table", "delete", "--table=tbl_x"])
    assert hit is not None
    risk, path = hit
    assert path == "table delete"
    assert risk == "review"


def test_lookup_three_segment_longest_prefix_wins():
    # `agent db info` 是 3 段命令；最长前缀应命中 3 段而不是 2 段的 `agent db`（若存在）
    hit = tcr.lookup_tabtin_command_risk(["agent", "db", "info"])
    assert hit is not None
    risk, path = hit
    assert path == "agent db info"
    assert risk == "safe"


def test_lookup_stops_at_flags():
    hit = tcr.lookup_tabtin_command_risk(["table", "list", "--format", "json"])
    assert hit is not None
    assert hit[1] == "table list"


def test_lookup_unknown_command_returns_none():
    assert tcr.lookup_tabtin_command_risk(["no-such-domain", "no-such-verb"]) is None


def test_lookup_table_missing_fail_safe(monkeypatch, tmp_path):
    monkeypatch.setattr(tcr, "_GENERATED_PATH", tmp_path / "missing.json")
    tcr.reset_cache_for_tests()
    assert tcr.lookup_tabtin_command_risk(["table", "delete"]) is None


def test_lookup_table_corrupt_fail_safe(monkeypatch, tmp_path):
    bad = tmp_path / "corrupt.json"
    bad.write_text('{"commands": {"x y": "not-a-level"}}', encoding="utf-8")
    monkeypatch.setattr(tcr, "_GENERATED_PATH", bad)
    tcr.reset_cache_for_tests()
    assert tcr.lookup_tabtin_command_risk(["x", "y"]) is None


# ── parser 集成 ──────────────────────────────────────────────────


def test_parser_registered_command_uses_ssot():
    spec = CliInvocationParser().parse("tabtin table delete --table=tbl_demo")
    assert spec.risk_level == "review"
    assert spec.matched_rule_pattern == "tabtin-commands:table delete"
    assert "SSoT" in spec.matched_rule_reason


def test_parser_ssot_overrides_yaml_pattern():
    """`table archive` 在 Go 侧是 RiskWrite(review)；即便 yaml 也有 *.archive 规则，
    来源必须标 SSoT 表而非 yaml 模式。"""
    spec = CliInvocationParser().parse("tabtin table archive --table=tbl_demo")
    assert spec.risk_level == "review"
    assert spec.matched_rule_pattern.startswith("tabtin-commands:")


def test_parser_unregistered_tabtin_command_falls_back_to_yaml():
    spec = CliInvocationParser().parse("tabtin records delete --table=tbl_demo")
    assert spec.risk_level == "review"
    assert spec.matched_rule_pattern == "*.delete"


def test_parser_non_tabtin_binary_untouched():
    spec = CliInvocationParser().parse("foo bar baz")
    assert spec.risk_level == "strict"
