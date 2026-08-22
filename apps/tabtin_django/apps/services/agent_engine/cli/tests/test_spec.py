"""``CliInvocationSpec`` 单元测试 — 覆盖 happy / error / edge 各 ≥1 例。"""

from __future__ import annotations

import pytest

from apps.services.agent_engine.cli.spec import (
    DEFAULT_RISK_LEVEL,
    KNOWN_BINARIES,
    REDACTED_FLAGS,
    RISK_LEVELS,
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
)


# ── happy ────────────────────────────────────────────────────────


def test_happy_full_fields():
    spec = CliInvocationSpec(
        binary="tabtin",
        domain="records",
        verb="delete",
        risk_level=RISK_REVIEW,
        resource="table:tbl_demo",
        resource_label="演示表",
        raw_args=["--table=tbl_demo", "--text=<redacted len=5 hash=2cf24dba>"],
        matched_rule_pattern="*.delete",
        matched_rule_reason="删除动作可能不可逆，HITL 确认",
    )
    assert spec.binary == "tabtin"
    assert spec.domain == "records"
    assert spec.verb == "delete"
    assert spec.risk_level == RISK_REVIEW
    # 统一二段 grammar_key（消化 A1 Review P0-1）
    assert spec.grammar_key == "records.delete"
    assert spec.resource == "table:tbl_demo"
    assert spec.resource_label == "演示表"
    assert spec.raw_args[0] == "--table=tbl_demo"
    assert spec.matched_rule_pattern == "*.delete"


def test_happy_grammar_key_two_segments():
    """grammar_key 统一返回 ``<domain>.<verb>``（匹配 ``*.delete`` 等通配规则）。"""
    spec = CliInvocationSpec(
        binary="tabtin",
        domain="table",
        verb="delete",
        risk_level=RISK_REVIEW,
    )
    assert spec.grammar_key == "table.delete"


def test_happy_minimal_fields_with_defaults():
    spec = CliInvocationSpec(
        binary="tabtin",
        domain="table",
        verb="query",
        risk_level=RISK_SAFE,
    )
    assert spec.resource is None
    assert spec.resource_label is None
    assert spec.raw_args == []
    assert spec.grammar_key == "table.query"


def test_happy_to_dict_roundtrip():
    spec = CliInvocationSpec(
        binary="tabtin",
        domain="table",
        verb="query",
        risk_level=RISK_SAFE,
        raw_args=["--name", "订单表"],
        matched_rule_pattern="*.query",
        matched_rule_reason="查询类直通",
    )
    payload = spec.to_dict()
    assert payload == {
        "binary": "tabtin",
        "domain": "table",
        "verb": "query",
        "resource": None,
        "resource_label": None,
        "raw_args": ["--name", "订单表"],
        "risk_level": RISK_SAFE,
        "matched_rule_pattern": "*.query",
        "matched_rule_reason": "查询类直通",
    }
    # raw_args 必须是新 list（避免外部修改影响 spec 内部状态）
    payload["raw_args"].append("MUTATED")
    assert spec.raw_args == ["--name", "订单表"]


# ── error ────────────────────────────────────────────────────────


def test_error_invalid_risk_level_rejected():
    with pytest.raises(ValueError, match="risk_level"):
        CliInvocationSpec(
            binary="tabtin",
            domain="records",
            verb="create",
            risk_level="low",  # 'low' 是 K8 决议要清理的旧词表，必须拒绝
        )


def test_error_empty_binary_rejected():
    with pytest.raises(ValueError, match="binary"):
        CliInvocationSpec(
            binary="",
            domain="records",
            verb="create",
            risk_level=RISK_SAFE,
        )


def test_error_empty_domain_rejected():
    with pytest.raises(ValueError, match="domain"):
        CliInvocationSpec(
            binary="tabtin",
            domain="",
            verb="create",
            risk_level=RISK_SAFE,
        )


def test_error_empty_verb_rejected():
    with pytest.raises(ValueError, match="verb"):
        CliInvocationSpec(
            binary="tabtin",
            domain="records",
            verb="",
            risk_level=RISK_SAFE,
        )


# ── edge ────────────────────────────────────────────────────────


def test_edge_frozen_dataclass_immutable():
    spec = CliInvocationSpec(
        binary="tabtin",
        domain="table",
        verb="query",
        risk_level=RISK_SAFE,
    )
    with pytest.raises(Exception):
        spec.binary = "evil"  # type: ignore[misc]


def test_edge_risk_levels_word_list_aligned():
    """K8 决议：本模块词表必须严格只包含 safe/review/strict 三档。

    防回归：未来若有人补 'low'/'medium'/'critical'，本测试立即失败。
    """
    assert RISK_LEVELS == ("safe", "review", "strict")
    assert DEFAULT_RISK_LEVEL == "review"
    assert RISK_SAFE == "safe"
    assert RISK_REVIEW == "review"
    assert RISK_STRICT == "strict"


def test_edge_known_binaries_baseline_only_tabtin():
    """H1 治理范围 binary 白名单 baseline 仅含平台自身的 ``tabtin``。

    第三方 marketplace App 的 binary 由 ``compute_known_binaries()`` 在运行时从
    ``packages/apps/<id>/app.json`` 动态合并；本常量不再静态列举它们。
    """
    assert KNOWN_BINARIES == frozenset({"tabtin"})


def test_edge_redacted_flags_covers_sensitive_payload():
    """敏感参数（``--text`` / ``--password`` / ``--secret`` / ``--token``）必须被脱敏（PRD §5.1 第 5 项）。"""
    assert "--text" in REDACTED_FLAGS
    assert "--password" in REDACTED_FLAGS
    assert "--secret" in REDACTED_FLAGS
    assert "--token" in REDACTED_FLAGS
