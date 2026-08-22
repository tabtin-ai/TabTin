"""PRD-v3 §5.1 第 6 项 "Wave A 验收必含" 端到端协议锚点测试。

PRD §5.1 第 6 项原文：
    "Wave A 验收必含：``pytest tests/cli/test_hitl_deny_protocol.py``，覆盖
     ① denied tool result 格式正确 ② Agent prompt 含上述约束 ③ timeout 路径返回正确。"

本文件作为该 PRD 验收锚点，不重复 ``test_cli_hitl_result.py`` 的字段级单测，
而是聚焦三件 PRD 点名的端到端事实：

1. **``denied`` tool result 格式正确**：调 ``hitl_denied`` + ``serialize_for_agent``
   产出与 PRD §5.1 第 6 项字面一致的 JSON 结构（含 ``status="denied"`` /
   ``retryable=false``，且不含审计相关字段污染 LLM 视野）。
2. **Agent prompt 含上述约束**：`SECTION_CLI_HITL_PROTOCOL` 实际被 ``PromptBuilder``
   装入 system prompt，且包含 PRD §5.1 第 6 项要求的关键短语（"任务必须终止" /
   "不要尝试改换参数后重试" / ``retryable`` 字段说明 / 审计 fail-close 兜底）。
3. **``timeout`` 路径返回正确**：调 ``hitl_timeout`` 产出 ``status="timeout"`` /
   ``retryable=true`` 的 JSON；与 ``denied`` 的硬约束区分清晰。

本文件运行无需 Django ORM（只读 prompt 常量 + 调纯函数 helper），
但走 ``cli/tests/conftest.py`` 的 django.setup 以兼容 pytest 采集顺序。
"""

from __future__ import annotations

import json

import pytest

from apps.services.common.cli_hitl_result import (
    AUDIT_FAILURE_REASON,
    DEFAULT_DENIED_REASON,
    DEFAULT_TIMEOUT_REASON,
    hitl_denied,
    hitl_timeout,
    serialize_for_agent,
    serialize_to_tool_result_content,
)
from ...prompts.base.cli_hitl_protocol import (
    SECTION_CLI_HITL_PROTOCOL,
)


# =====================================================================
# PRD §5.1.6 ① — denied tool result 格式正确
# =====================================================================


def test_denied_tool_result_matches_prd_schema_fields():
    """PRD §5.1 第 6 项 denied 路径字面 schema：
    ``{"status":"denied","reason":"<user_input or default>","retryable":false}``。"""
    result = hitl_denied(reason="向 200 人群体发送被人工拒绝")
    out = serialize_for_agent(result)

    # 字段集严格三键
    assert set(out.keys()) == {"status", "reason", "retryable"}
    assert out["status"] == "denied"
    assert out["retryable"] is False
    assert isinstance(out["reason"], str) and out["reason"].strip()


def test_denied_default_reason_is_human_readable_chinese():
    """``hitl_denied()`` 不传 reason 时使用中文默认文案，避免 LLM 转述给用户时夹英文。"""
    out = serialize_for_agent(hitl_denied())
    assert out["reason"] == DEFAULT_DENIED_REASON
    assert any("\u4e00" <= ch <= "\u9fff" for ch in out["reason"])


def test_denied_serialized_content_keeps_unicode():
    """tool message 的 ``content`` 字符串不能 escape 中文（UI / 审计页直接读）。"""
    result = hitl_denied(reason="向 200 人群体发送被人工拒绝")
    content = serialize_to_tool_result_content(result)
    assert "向 200 人群体发送被人工拒绝" in content
    assert "\\u" not in content
    parsed = json.loads(content)
    assert parsed["status"] == "denied"
    assert parsed["retryable"] is False


def test_denied_excludes_audit_fields_from_llm_view():
    """audit_event_id / decided_at / extra 不可进入 LLM 视野，否则模型可能把 UUID
    当成"重试参数"。"""
    result = hitl_denied(
        reason="x",
        hitl_audit_event_id="abc-123",
        extra={"decided_by": "u-1", "cause": "audit_unavailable"},
    )
    out = serialize_for_agent(result)
    for forbidden in ("hitl_audit_event_id", "decided_at", "extra", "decided_by", "cause"):
        assert forbidden not in out


# =====================================================================
# PRD §5.1.6 ② — Agent prompt 含上述约束
# =====================================================================


def test_section_cli_hitl_protocol_is_registered_in_prompt_builder():
    """``cli_hitl_protocol`` 实际被装入 ``PromptBuilder`` 默认 system prompt。"""
    from ...prompts.registry import (
        DEFAULT_ORDER,
        PromptBuilder,
        PromptRegistry,
    )

    assert "cli_hitl_protocol" in DEFAULT_ORDER
    PromptRegistry.reset()
    builder = PromptBuilder()
    out = builder.build()

    assert "<cli_hitl_protocol>" in out
    assert "</cli_hitl_protocol>" in out


@pytest.mark.parametrize(
    "required_phrase",
    [
        # 三种状态名（denied / timeout 必出现；allow 在文案里说明 "不会收到本协议 JSON"）
        '"denied"',
        '"timeout"',
        # PRD 关键约束语：denied = 任务终止，不重试同意图
        "任务必须终止",
        "不要尝试改换参数后重试",
        # PRD 关键约束语：retryable 字段语义
        "retryable=false",
        "retryable=true",
        # 审计兜底（fail-close）路径
        "审计写入失败",
        "fail-close",
        # 反例 / 正例都覆盖
        "协议反例",
        "协议正例",
    ],
)
def test_section_contains_required_protocol_phrases(required_phrase):
    assert required_phrase in SECTION_CLI_HITL_PROTOCOL, (
        f"PRD §5.1 第 6 项要求的关键短语 {required_phrase!r} "
        f"未出现在 SECTION_CLI_HITL_PROTOCOL 中"
    )


def test_section_does_not_describe_allow_as_protocol_json():
    """allow 路径不通过本协议 JSON 返回（执行层直接给真实工具输出），
    本 section 必须明确告知 LLM "schema 里没有 allow 状态"，避免误解析。"""
    # 显式说明
    assert "schema 里没有" in SECTION_CLI_HITL_PROTOCOL or "schema 中没有" in SECTION_CLI_HITL_PROTOCOL
    # JSON schema 块本身不含 allow 状态字面
    schema_block_start = SECTION_CLI_HITL_PROTOCOL.find("```json")
    schema_block_end = SECTION_CLI_HITL_PROTOCOL.find("```", schema_block_start + 6)
    assert schema_block_start >= 0 and schema_block_end > schema_block_start
    schema_block = SECTION_CLI_HITL_PROTOCOL[schema_block_start:schema_block_end]
    assert '"allow"' not in schema_block, (
        "schema 块不应含 allow 状态——allow 路径直接走真实工具输出，不走本协议"
    )


# =====================================================================
# PRD §5.1.6 ③ — timeout 路径返回正确
# =====================================================================


def test_timeout_tool_result_matches_prd_schema_fields():
    """PRD §5.1 第 6 项 timeout 路径：
    ``{"status":"timeout","reason":"用户未在 X 时间内决策","retryable":true}``。"""
    result = hitl_timeout(timeout_seconds=300)
    out = serialize_for_agent(result)

    assert set(out.keys()) == {"status", "reason", "retryable"}
    assert out["status"] == "timeout"
    assert out["retryable"] is True
    assert "5 分钟" in out["reason"]


def test_timeout_default_reason_present():
    out = serialize_for_agent(hitl_timeout())
    assert out["reason"] == DEFAULT_TIMEOUT_REASON


def test_timeout_protocol_constraint_blocks_retryable_false():
    """协议硬约束：timeout 不能 retryable=false（重试只是再次触发 HITL）。"""
    from apps.services.common.cli_hitl_result import CliHitlResult

    with pytest.raises(ValueError, match="timeout"):
        CliHitlResult(status="timeout", reason="x", retryable=False)


# =====================================================================
# 协议互斥验证：denied 与 timeout 的硬约束不会冲撞
# =====================================================================


def test_denied_and_timeout_have_opposite_retryable():
    """协议设计意图：denied 永远不可重试，timeout 永远可重试。"""
    denied = serialize_for_agent(hitl_denied(reason="x"))
    timeout = serialize_for_agent(hitl_timeout())
    assert denied["retryable"] is False
    assert timeout["retryable"] is True


def test_audit_failure_fallback_uses_denied_protocol():
    """PRD §5.1 第 5+6 项合流：审计 fail-close 必须以 denied 协议返回，
    标准 reason 文案确保 Agent prompt 能识别 "审计写入失败" 关键词触发兜底处理。"""
    out = serialize_for_agent(hitl_denied(reason=AUDIT_FAILURE_REASON))
    assert out["status"] == "denied"
    assert out["retryable"] is False
    # AUDIT_FAILURE_REASON 含 "审计" 关键词，与 prompt 中的 "审计写入失败" 处理段对齐
    assert "审计" in out["reason"]
