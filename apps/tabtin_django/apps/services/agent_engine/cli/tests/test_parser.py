"""``CliInvocationParser`` 单元测试。

覆盖：
- happy: tabtin 通用查询 / 通配规则命中
- error: 未知 binary / 空字符串 / shlex 解析失败
- edge:  PII 脱敏（=value 与 space-value 两种形式）/ resource 提取 / 默认规则匹配
"""

from __future__ import annotations

from apps.services.agent_engine.cli.parser import (
    CliInvocationParser,
    redact_sensitive_args,
)
from apps.services.agent_engine.cli.spec import (
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
)


# ── happy ────────────────────────────────────────────────────────


def test_happy_tabtin_table_query_safe():
    parser = CliInvocationParser()
    spec = parser.parse('tabtin table query --name="订单表"')
    assert spec.binary == "tabtin"
    assert spec.domain == "table"
    assert spec.verb == "query"
    assert spec.risk_level == RISK_SAFE
    # ：`table query` 是已登记的 tabtin 命令，风险档来源切换为
    # Go CommandDef.Risk SSoT 生成表（值与原 `*.query` yaml 规则一致）。
    assert spec.matched_rule_pattern == "tabtin-commands:table query"
    assert spec.matched_rule_reason  # reason 必须非空，便于审计反查


def test_happy_tabtin_records_list_safe():
    """``records.list`` 命中 ``*.list`` 通配规则 → safe。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records list")
    assert spec.binary == "tabtin"
    assert spec.domain == "records"
    assert spec.verb == "list"
    assert spec.risk_level == RISK_SAFE
    assert spec.matched_rule_pattern == "*.list"


def test_happy_tabtin_records_delete_review():
    """``records.delete`` 命中 ``*.delete`` 通配规则 → review。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records delete --table=tbl_demo")
    assert spec.binary == "tabtin"
    assert spec.domain == "records"
    assert spec.verb == "delete"
    assert spec.risk_level == RISK_REVIEW
    assert spec.matched_rule_pattern == "*.delete"


def test_happy_tabtin_records_create_safe():
    """``*.create`` 通配规则非生产环境直通 → safe。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records create --name=新记录")
    assert spec.risk_level == RISK_SAFE
    assert spec.matched_rule_pattern == "*.create"


# ── error ────────────────────────────────────────────────────────


def test_error_unknown_binary_strict():
    parser = CliInvocationParser()
    spec = parser.parse("foo bar baz")
    assert spec.binary == "foo"
    assert spec.risk_level == RISK_STRICT


def test_error_empty_command_review():
    parser = CliInvocationParser()
    spec = parser.parse("")
    assert spec.risk_level == RISK_REVIEW
    assert spec.binary == "<unparsed>"


def test_error_unbalanced_quotes_review():
    """shlex 解析失败必须 fail-safe 到 review，而不是抛异常。"""
    parser = CliInvocationParser()
    spec = parser.parse('tabtin records create --text="缺右引号 password=secret123')
    assert spec.risk_level == RISK_REVIEW
    assert spec.binary == "<unparsed>"
    # P0-2 修复：原文不能进入 raw_args，否则 A2 落库会造成 PII 泄漏
    joined = " ".join(spec.raw_args)
    assert "secret123" not in joined
    assert "缺右引号" not in joined
    assert "<unparsed:" in joined


def test_error_tabtin_missing_verb_review():
    """``tabtin table`` 无 verb 时不能放行，必须 fail-safe 到 review。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin table")
    assert spec.risk_level == RISK_REVIEW
    assert spec.verb == "<missing>"


# ── edge ────────────────────────────────────────────────────────


def test_edge_pii_redaction_inline_value():
    redacted = redact_sensitive_args(["--table=tbl_xxx", "--text=hello world"])
    assert redacted[0] == "--table=tbl_xxx"
    assert redacted[1].startswith("--text=<redacted len=11 hash=")
    # hash 是稳定的（同输入同输出）
    again = redact_sensitive_args(["--text=hello world"])
    assert again[0] == redacted[1]


def test_edge_pii_redaction_space_value():
    redacted = redact_sensitive_args(["--password", "secret123", "--other", "foo"])
    assert redacted[0] == "--password"
    assert redacted[1].startswith("<redacted len=9 hash=")
    assert redacted[2] == "--other"
    assert redacted[3] == "foo"


def test_edge_pii_redaction_short_flag_passthrough():
    """A1 不识别短选项（``-t value``），保持原样并写入交付报告遗留项。"""
    redacted = redact_sensitive_args(["-t", "secret"])
    assert redacted == ["-t", "secret"]


def test_edge_pii_redaction_flag_at_eol():
    """末尾的 ``--text`` 没有 value 时不能崩，保持原样。"""
    redacted = redact_sensitive_args(["--text"])
    assert redacted == ["--text"]


def test_edge_parser_pii_in_full_pipeline():
    """端到端：parser 必须把 raw_args 中的敏感 value 脱敏。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records create --table=tbl_x --text=hello")
    text_arg = next(arg for arg in spec.raw_args if arg.startswith("--text="))
    assert "hello" not in text_arg
    assert "<redacted len=5 hash=" in text_arg


def test_edge_resource_extraction_from_table_flag():
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records list --table tbl_xxx")
    assert spec.resource == "table:tbl_xxx"


def test_edge_resource_fallback_typed_id():
    """没有 ``--table`` flag 但裸出现 ``tbl_xxx`` 也能识别为 table。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records list tbl_xxx")
    # ``records.list`` 命中 ``*.list`` → safe，且 resource 被识别
    assert spec.risk_level == RISK_SAFE
    assert spec.resource == "table:tbl_xxx"
    assert spec.matched_rule_pattern == "*.list"


def test_edge_resource_doc_prefix_no_false_positive():
    """P0-3 修复：普通词 ``doctor``/``document``/``docker`` 不应被误识别为 doc resource。

    fallback 规则只接受严格的 ``doc_`` 前缀（或其它 typed id 前缀）。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin records list doctor")
    assert spec.resource is None  # `doctor` 不是 typed doc id
    spec = parser.parse("tabtin records list document")
    assert spec.resource is None
    # 真正 typed doc id 应当被识别
    spec = parser.parse("tabtin records list doc_abc123")
    assert spec.resource == "doc:doc_abc123"


def test_edge_strict_wildcard_delete():
    """已登记 tabtin 命令走 SSoT 表；风险值与原 ``*.delete`` 规则一致。

    ``*.delete`` 通配规则仍由 ``test_tabtin_command_risk.py`` 的
    fallback 用例（未登记 domain）覆盖。
    """
    parser = CliInvocationParser()
    spec = parser.parse("tabtin table delete --table-id=tbl_x")
    assert spec.risk_level == RISK_REVIEW
    assert spec.resource == "table:tbl_x"
    assert spec.matched_rule_pattern == "tabtin-commands:table delete"


def test_edge_strict_create_in_prod():
    """``*.create_in_prod`` 强制 strict（PRD §5.1 第 3 项）。"""
    parser = CliInvocationParser()
    spec = parser.parse("tabtin table create_in_prod --name=订单")
    assert spec.risk_level == RISK_STRICT
