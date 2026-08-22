"""``CliRuleSet`` / ``cli_rules.yaml`` 加载与匹配单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.services.agent_engine.cli.rules import (
    CliRule,
    CliRuleSet,
    load_default_rules,
    load_rules_from_file,
)
from apps.services.agent_engine.cli.spec import (
    DEFAULT_RISK_LEVEL,
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
)


# ── happy ────────────────────────────────────────────────────────


def test_happy_default_rules_loads_wildcard_delete_review():
    """PRD §5.1 第 3 项：``*.delete`` 通配规则必须命中 review。"""
    rs = load_default_rules()
    rule = rs.match("records.delete")
    assert rule.risk_level == RISK_REVIEW
    assert rule.pattern == "*.delete"
    assert rule.reason  # 必须有 reason 便于审计


def test_happy_default_rules_list_safe():
    """``*.list`` 应该走 safe 直通。"""
    rs = load_default_rules()
    rule = rs.match("records.list")
    assert rule.risk_level == RISK_SAFE
    assert rule.pattern == "*.list"


def test_happy_default_rules_wildcard_delete_two_segments_only():
    """二段 grammar_key 命中 ``*.delete``；三段不命中（段数不一致语义）。"""
    rs = load_default_rules()
    # 二段：parser 给出的 grammar_key 形如 ``table.delete``（tabtin 前缀已剥离）
    rule = rs.match("table.delete")
    assert rule.risk_level == RISK_REVIEW
    assert rule.pattern == "*.delete"
    # 三段：不应被 ``*.delete`` 命中（段数不同），落 default
    rule = rs.match("tabtin.table.delete")
    assert rule.pattern == ""  # 兜底
    assert rule.risk_level == DEFAULT_RISK_LEVEL


def test_happy_default_rules_create_in_prod_strict():
    rs = load_default_rules()
    rule = rs.match("tabdata.create_in_prod")
    assert rule.risk_level == RISK_STRICT


def test_happy_default_rules_default_review_fallback():
    """完全无规则匹配的 grammar_key 必须 fallback 到 ``default: review``。"""
    rs = load_default_rules()
    rule = rs.match("totally.unknown_verb")
    assert rule.risk_level == DEFAULT_RISK_LEVEL
    assert rule.pattern == ""  # 兜底 rule


def test_happy_phone_read_verbs_safe():
    """#2551 tabtin phone：读类动作（列表/截屏/数据浏览）safe 直通。"""
    rs = load_default_rules()
    for verb in ("list-devices", "list-emulators", "screenshot", "sms", "contacts", "call-log", "photos"):
        rule = rs.match(f"phone.{verb}")
        assert rule.risk_level == RISK_SAFE, f"phone.{verb} 应为 safe"
        assert rule.pattern == f"phone.{verb}"


def test_happy_phone_mutating_verbs_review():
    """#2551 tabtin phone：连接/模拟器起停/镜像/操控/导入命中 ``phone.*`` review。"""
    rs = load_default_rules()
    for verb in ("connect", "start-emulator", "stop-emulator", "start-mirror",
                 "stop-mirror", "tap", "key", "input-text", "import-media"):
        rule = rs.match(f"phone.{verb}")
        assert rule.risk_level == RISK_REVIEW, f"phone.{verb} 应为 review"
        assert rule.pattern == "phone.*"


# ── error ────────────────────────────────────────────────────────


def test_error_invalid_risk_level_raises(tmp_path: Path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "version: 1\n"
        "rules:\n"
        "  - pattern: foo.bar\n"
        "    risk_level: low\n"  # 'low' 不在词表内，必须拒绝
        "default: review\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="risk_level"):
        load_rules_from_file(bad)


def test_error_missing_pattern_raises(tmp_path: Path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "version: 1\n"
        "rules:\n"
        "  - pattern: ''\n"
        "    risk_level: safe\n"
        "default: review\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="pattern"):
        load_rules_from_file(bad)


def test_error_file_missing_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        load_rules_from_file(tmp_path / "nonexistent.yaml")


def test_error_root_not_mapping(tmp_path: Path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("- 1\n- 2\n", encoding="utf-8")
    with pytest.raises(ValueError, match="mapping"):
        load_rules_from_file(bad)


# ── edge ────────────────────────────────────────────────────────


def test_edge_first_match_wins(tmp_path: Path):
    """规则按声明顺序匹配；先声明的更具体规则覆盖后声明的通配规则。"""
    rules_yaml = tmp_path / "rules.yaml"
    rules_yaml.write_text(
        "version: 1\n"
        "rules:\n"
        "  - pattern: records.delete\n"
        "    risk_level: strict\n"
        "  - pattern: '*.delete'\n"
        "    risk_level: review\n"
        "default: review\n",
        encoding="utf-8",
    )
    rs = load_rules_from_file(rules_yaml)
    # 更具体的规则先声明，命中 strict
    assert rs.match("records.delete").risk_level == RISK_STRICT
    # 其它 domain 走通配规则
    assert rs.match("table.delete").risk_level == RISK_REVIEW


def test_edge_empty_rules_uses_default(tmp_path: Path):
    rules_yaml = tmp_path / "rules.yaml"
    rules_yaml.write_text(
        "version: 1\nrules: []\ndefault: strict\n",
        encoding="utf-8",
    )
    rs = load_rules_from_file(rules_yaml)
    assert rs.match("anything.at_all").risk_level == RISK_STRICT


def test_edge_rule_matches_unit():
    """``CliRule.matches`` 不跨段匹配：``records.*`` 不应匹配 ``records.thread.send``。"""
    r = CliRule(pattern="records.*", risk_level=RISK_SAFE)
    assert r.matches("records.send")
    assert r.matches("records.list")
    assert not r.matches("table.send")
    assert not r.matches("records.thread.send")


def test_edge_rule_matches_full_wildcard():
    r = CliRule(pattern="*.delete", risk_level=RISK_REVIEW)
    assert r.matches("table.delete")
    assert r.matches("doc.delete")
    assert not r.matches("delete")  # 必须有 domain
    assert not r.matches("a.b.delete")  # 段数不匹配


def test_edge_default_rules_yaml_smoke_load():
    """主仓打包的 default ``cli_rules.yaml`` 必须能直接加载、规则非空、版本号 ≥ 1。"""
    rs = load_default_rules()
    assert rs.version >= 1
    assert len(rs.rules) > 0
    assert rs.default_risk_level in {"safe", "review", "strict"}
