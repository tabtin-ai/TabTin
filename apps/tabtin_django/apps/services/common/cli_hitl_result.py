"""HITL 决策 → Agent tool result 协议（PRD-v3 §5.1 第 6 项 — Wave A 启动包 A4）。

把"用户在 HITL UI 做的决策（allow / deny / timeout）"翻译成 Agent 在 tool result 中
看到的统一 JSON 结构，让 Agent 知道：

- ``allow``    → 后续正常 fork CLI 执行，本模块不构造 result（执行层负责）
- ``denied``   → ``{"status":"denied","reason":...,"retryable":false}``，Agent 必须终止
                  本意图任务（system prompt 强约束，见 ``prompts/base/cli_hitl_protocol.py``）
- ``timeout``  → ``{"status":"timeout","reason":...,"retryable":true}``，Agent 可重试
                  （重试将再次触发 HITL；不是"绕过 HITL 直接执行"）

设计纪律：

1. **协议字段固定**（消化 PRD §5.1 第 6 项）：``status`` / ``reason`` / ``retryable`` 是
   Agent 端 LLM 看到的字段，**任何调整必须升 PRD 版本**。``hitl_audit_event_id`` 是
   带外字段，仅审计追溯用，不进 LLM 视野（避免 LLM 把 UUID 当成"重试参数"）。

2. **不依赖 Django ORM**：``CliHitlResult`` / ``serialize_for_agent`` / 三个 helper
   全部纯 Python，可在 ``python -c`` 验证脚本中直接用。
   facade ``record_hitl_decision_and_build_result`` 才与 A2 ``update_hitl_decision`` 联动。

3. **fail-close**：facade 在 audit 写入失败（``CliAuditWriteError``）时**仍然返回**
   一个 denied result（``reason`` 标注审计失败）—— Agent 必须放弃任务，避免"audit 没写、
   Agent 误以为允许执行"的高风险窗口。这是 PRD §5.1 第 5/6 项 fail-close 与第 6 项
   denied 协议的合流：审计失效 = 风险等同于 deny，必须告知 Agent。

4. **A4 范围（不含）**：
   - ``allow`` 路径的 tool result 由执行层（A5 fork 第三方 CLI wrapper）构造，本模块不参与；
   - 真正在 NativeReactLoop / HITLCoordinator 中"把本 result 注入 messages 列表"
     由 A5/HITL resume 路径接入；本模块只负责"协议序列化 + helper"，不改 A1-A3 既有代码。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# 协议常量
# ─────────────────────────────────────────────────────────────────────


HitlStatus = Literal["allow", "denied", "timeout"]

ALLOWED_HITL_STATUSES: frozenset = frozenset({"allow", "denied", "timeout"})

# 默认 reason 文案（PRD §5.1 第 6 项；中文与既有 prompt 风格一致）。
DEFAULT_DENIED_REASON = "用户在审批中拒绝了该 CLI 调用"
DEFAULT_TIMEOUT_REASON = "用户未在审批超时窗口内做出决策（HITL timeout）"
AUDIT_FAILURE_REASON = (
    "HITL 审计写入失败，按 fail-close 协议拒绝执行；请告知用户并停止重试"
)


# ─────────────────────────────────────────────────────────────────────
# 数据结构
# ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CliHitlResult:
    """HITL 决策结果（构造给 Agent 看的协议封装）。

    字段：

    - ``status``               — ``"allow"`` / ``"denied"`` / ``"timeout"``
    - ``reason``               — 给 Agent / LLM 看的人类可读理由（必须中文清晰，
                                 让 LLM 转述给用户时不会丢语义）。``allow`` 时通常无需。
    - ``retryable``            — 是否可重试（PRD §5.1 第 6 项硬约束）：
                                 - ``denied`` 永远 ``False`` —— 防止 Agent 自动重试
                                   同一意图绕过用户决策
                                 - ``timeout`` 永远 ``True`` —— 重试只是再次触发 HITL，
                                   不是绕过
                                 - ``allow`` ``True`` 仅形式化（``allow`` 不需要重试）
    - ``hitl_audit_event_id``  — 关联的 ``CliAuditEvent.id``（A2 emit 时拿到的 UUID）；
                                 仅日志/审计用，**不**写入 ``serialize_for_agent`` 输出，
                                 避免 LLM 把 UUID 当作"重试参数"误解。可空，例如
                                 PG 不可达时未拿到 audit_event_id 仍能构造 denied result。
    - ``decided_at``           — 决策时间（带时区，UTC 优先）；可空。

    不可变（``frozen=True``）；Hashable（在测试中可用 set/dict key）。
    """

    status: HitlStatus
    reason: str
    retryable: bool
    hitl_audit_event_id: Optional[str] = None
    decided_at: Optional[datetime] = None
    extra: Dict[str, Any] = field(default_factory=dict)
    """可选附加字段；不进 ``serialize_for_agent`` 输出，仅供调用方追踪上下文（如
    ``decided_by``、``rule_decision``）。LLM 视野严格仅限协议三字段。"""

    def __post_init__(self) -> None:
        if self.status not in ALLOWED_HITL_STATUSES:
            raise ValueError(
                f"CliHitlResult.status must be one of {sorted(ALLOWED_HITL_STATUSES)}, "
                f"got {self.status!r}"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("CliHitlResult.reason must be a non-empty string")
        if not isinstance(self.retryable, bool):
            raise ValueError(
                f"CliHitlResult.retryable must be bool, got {type(self.retryable).__name__}"
            )
        # 协议硬约束：denied → retryable=False；timeout → retryable=True
        # （allow 不强约束 retryable，由调用方按场景决定，但通常无意义）
        if self.status == "denied" and self.retryable:
            raise ValueError(
                "Protocol violation: status='denied' must have retryable=False "
                "(防止 Agent 绕过用户决策)"
            )
        if self.status == "timeout" and not self.retryable:
            raise ValueError(
                "Protocol violation: status='timeout' must have retryable=True "
                "(重试只是再次触发 HITL)"
            )


# ─────────────────────────────────────────────────────────────────────
# 协议序列化
# ─────────────────────────────────────────────────────────────────────


def serialize_for_agent(result: CliHitlResult) -> Dict[str, Any]:
    """把 ``CliHitlResult`` 序列化成 Agent / LLM 看到的 dict。

    输出严格仅含 3 字段（``status`` / ``reason`` / ``retryable``），与 PRD §5.1 第 6 项
    完全一致；任何额外字段（``hitl_audit_event_id`` / ``decided_at`` / ``extra``）
    一律不进 LLM 视野，由调用方在 tool result content 之外通过 logger / state 携带。

    使用：

        result = hitl_denied(reason="用户拒绝向 200 人群体发送消息")
        tool_result_content = serialize_for_agent(result)   # → dict
        # 通常上层把 dict 用 json.dumps(..., ensure_ascii=False) 装到
        # ``{"role": "tool", "tool_call_id": ..., "content": ...}`` 里。
    """
    return {
        "status": result.status,
        "reason": result.reason,
        "retryable": result.retryable,
    }


def serialize_to_tool_result_content(result: CliHitlResult) -> str:
    """便利：把 ``CliHitlResult`` 序列化成 tool message 的 ``content`` 字符串。

    ``ensure_ascii=False`` 保留中文，便于审计页直接阅读。
    """
    return json.dumps(serialize_for_agent(result), ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────
# Helper 工厂
# ─────────────────────────────────────────────────────────────────────


def hitl_allow(
    *,
    reason: Optional[str] = None,
    hitl_audit_event_id: Optional[str] = None,
    decided_at: Optional[datetime] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> CliHitlResult:
    """构造 allow 决策结果（实际 tool result 由执行层在 fork 完成后构造，
    本 helper 仅在测试 / 显式 audit 联动场景使用）。"""
    return CliHitlResult(
        status="allow",
        reason=reason or "用户在审批中允许该 CLI 调用",
        retryable=True,
        hitl_audit_event_id=hitl_audit_event_id,
        decided_at=decided_at,
        extra=dict(extra or {}),
    )


def hitl_denied(
    *,
    reason: Optional[str] = None,
    hitl_audit_event_id: Optional[str] = None,
    decided_at: Optional[datetime] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> CliHitlResult:
    """构造 denied 决策结果。``retryable=False`` 协议强约束（dataclass __post_init__）。

    ``reason`` 缺省时使用 ``DEFAULT_DENIED_REASON``；建议调用方传入用户实际填写的
    拒绝理由（HITL UI 的 reason 输入），更利于 Agent 转述给用户。
    """
    return CliHitlResult(
        status="denied",
        reason=(reason or DEFAULT_DENIED_REASON).strip() or DEFAULT_DENIED_REASON,
        retryable=False,
        hitl_audit_event_id=hitl_audit_event_id,
        decided_at=decided_at,
        extra=dict(extra or {}),
    )


def hitl_timeout(
    *,
    reason: Optional[str] = None,
    hitl_audit_event_id: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    decided_at: Optional[datetime] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> CliHitlResult:
    """构造 timeout 决策结果。``retryable=True`` 协议强约束。

    ``timeout_seconds`` 给定时合并到默认 reason 文案中，让 Agent 可以告诉用户
    "在 X 分钟内未响应"。
    """
    if reason and reason.strip():
        final_reason = reason.strip()
    elif timeout_seconds:
        minutes = max(1, timeout_seconds // 60)
        final_reason = f"用户在 {minutes} 分钟内未响应 HITL 审批"
    else:
        final_reason = DEFAULT_TIMEOUT_REASON
    return CliHitlResult(
        status="timeout",
        reason=final_reason,
        retryable=True,
        hitl_audit_event_id=hitl_audit_event_id,
        decided_at=decided_at,
        extra=dict(extra or {}),
    )


# ─────────────────────────────────────────────────────────────────────
# Facade：与 A2 update_hitl_decision 联动
# ─────────────────────────────────────────────────────────────────────


def record_hitl_decision_and_build_result(
    *,
    audit_event_id: Optional[str],
    user_decision: HitlStatus,
    decided_by: Optional[str],
    decided_at: Optional[datetime] = None,
    reason: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    allow_override: bool = False,
) -> CliHitlResult:
    """同步：写 audit 回填（A2 ``update_hitl_decision``）+ 构造 Agent tool result。

    使用场景（A5 / HITL resume 路径接入时调用本 facade，A4 仅提供函数本身）：

        result = record_hitl_decision_and_build_result(
            audit_event_id=event.id,
            user_decision="denied",
            decided_by=request.user.id,
            reason=user_input_reason,
        )
        tool_message = {
            "role": "tool",
            "tool_call_id": tc.id,
            "content": serialize_to_tool_result_content(result),
        }

    协议联动语义（PRD §5.1 第 5+6 项 fail-close 合流）：

    1. ``user_decision`` 校验同 ``update_hitl_decision``（``allow`` / ``deny`` / ``timeout``）。
       本接口对外暴露 ``denied``（不是 ``deny``，与 PRD §5.1 第 6 项协议字面一致）；
       内部翻译成 A2 期望的 ``deny``。
    2. ``audit_event_id`` 缺失时直接构造结果（不调 audit）：用于 PG 不可达后由调用方
       用 stderr / Sentry 已经报警的兜底路径——Agent 仍要拿到 denied/timeout result。
    3. ``update_hitl_decision`` 抛 ``CliAuditWriteError``：
       - 业务态错误（非 review 路径 / 重复回填 / 词表非法等）→ 重抛，调用方修代码
       - DB 短时故障（``retryable=True``）→ 转换为 denied result（``reason`` 标注审计失败），
         **绝不**让 Agent 误以为允许执行（fail-close 合流）

    返回：``CliHitlResult``（用 ``serialize_to_tool_result_content`` 序列化进 tool message）。
    """
    if user_decision not in ALLOWED_HITL_STATUSES:
        raise ValueError(
            f"user_decision must be one of {sorted(ALLOWED_HITL_STATUSES)}, "
            f"got {user_decision!r}"
        )

    final_decided_at = decided_at or datetime.now(timezone.utc)

    # ── 先构造 result，方便 audit 失败时拿来兜底 ─────────────────────
    if user_decision == "denied":
        result = hitl_denied(
            reason=reason,
            hitl_audit_event_id=str(audit_event_id) if audit_event_id else None,
            decided_at=final_decided_at,
            extra={"decided_by": str(decided_by) if decided_by else None},
        )
    elif user_decision == "timeout":
        result = hitl_timeout(
            reason=reason,
            hitl_audit_event_id=str(audit_event_id) if audit_event_id else None,
            timeout_seconds=timeout_seconds,
            decided_at=final_decided_at,
            extra={"decided_by": str(decided_by) if decided_by else None},
        )
    else:  # allow
        result = hitl_allow(
            reason=reason,
            hitl_audit_event_id=str(audit_event_id) if audit_event_id else None,
            decided_at=final_decided_at,
            extra={"decided_by": str(decided_by) if decided_by else None},
        )

    # ── 无 audit_event_id：跳过 audit 联动（兜底/测试路径）────────────
    if not audit_event_id:
        logger.info(
            "[cli_hitl_result] 无 audit_event_id，跳过 update_hitl_decision: "
            "user_decision=%s decided_by=%s",
            user_decision,
            decided_by,
        )
        return result

    if not decided_by:
        # A2 update_hitl_decision 强制要求 decided_by 不能为 None；本 facade 提前拦截，
        # 给出更精确的错误信息（指明是 facade 调用方未提供 decided_by）。
        raise ValueError(
            "decided_by 不能为 None（HITL 决策必须能追溯到具体用户）"
        )

    # ── 调 A2 update_hitl_decision ──────────────────────────────────
    # lazy import：本模块顶层无 Django app load，让 serialize_for_agent / helper
    # 能在 non-Django 上下文（python -c smoke）中使用。
    from apps.services.agent_engine.cli.audit import (
        CliAuditWriteError,
        update_hitl_decision,
    )

    # 协议字面 denied → A2 词表 deny（PRD §5.1 第 6 项与 A2 词表的桥接）
    a2_decision = "deny" if user_decision == "denied" else user_decision

    try:
        update_hitl_decision(
            audit_event_id,
            user_decision=a2_decision,
            decided_by=decided_by,
            decided_at=final_decided_at,
            allow_override=allow_override,
        )
    except CliAuditWriteError as exc:
        if exc.retryable:
            # DB 短时故障：fail-close 合流到 denied result
            # extra.cause = "audit_unavailable"：机器可读标识，便于：
            #   1) AdminDash 审计页区分"用户主动 deny" vs "系统兜底 deny"
            #   2) 上层 UI 看到本字段时给用户提示"系统问题，请稍后再试"
            #   3) 监控告警按 cause 分桶（避免误把系统故障当成"用户拒绝率上升"）
            logger.error(
                "[cli_hitl_result] audit 写入失败（可重试），fail-close 转 denied: "
                "audit_event_id=%s user_decision=%s exc=%s",
                audit_event_id,
                user_decision,
                exc,
            )
            return hitl_denied(
                reason=AUDIT_FAILURE_REASON,
                hitl_audit_event_id=str(audit_event_id),
                decided_at=final_decided_at,
                extra={
                    "decided_by": str(decided_by) if decided_by else None,
                    "cause": "audit_unavailable",
                    "audit_failure_cause": f"{type(exc).__name__}: {exc}",
                    "original_decision": user_decision,
                },
            )
        # 业务态错误：重抛让上层修代码（重复回填 / 词表非法 / 非 review 路径等）
        raise

    return result


__all__ = [
    # protocol
    "HitlStatus",
    "ALLOWED_HITL_STATUSES",
    "DEFAULT_DENIED_REASON",
    "DEFAULT_TIMEOUT_REASON",
    "AUDIT_FAILURE_REASON",
    # data class
    "CliHitlResult",
    # serializers
    "serialize_for_agent",
    "serialize_to_tool_result_content",
    # helpers
    "hitl_allow",
    "hitl_denied",
    "hitl_timeout",
    # facade
    "record_hitl_decision_and_build_result",
]
