"""S16: AI 分类器智能审批。

在 PermissionRuleEngine 返回 ASK（需确认）后，对需确认的操作用轻量模型判断风险：
- 快速路径（不需 AI）：白名单操作直接放行
- AI 分类器：调轻量模型判断风险
- 连续拒绝追踪

A3 扩展（PRD-v3 §5.1 第 3 项）：新增 ``try_uplift_safe_to_review``，
仅对 ``CliInvocationSpec.risk_level == 'safe'`` 的 spec 调 AI **加严**到 ``review``
（绝不放宽，单调合并由 ``cli_engine.merge_decisions`` 兜底）。

Django settings 开关：AGENT_ENGINE_AI_CLASSIFIER_ENABLED（默认 False，需显式开启；
legacy 名 ORCHESTRATION_AI_CLASSIFIER_ENABLED 仍兼容）
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

from apps.services.agent_engine.permissions.rule_engine import (
    PermissionAction,
    PermissionRuleEngine,
)
from apps.services.agent_engine.utils.shell_safety import is_safe_shell_command

if TYPE_CHECKING:
    from apps.services.agent_engine.cli.spec import CliInvocationSpec
    from apps.services.agent_engine.permissions.cli_engine import Decision

logger = logging.getLogger(__name__)


# ── 数据结构 ─────────────────────────────────────────────────


@dataclass
class ClassifierResult:
    should_allow: bool
    confidence: str  # "high" | "medium" | "low"
    reason: str


# ── 快速路径白名单 ────────────────────────────────────────────


_FastAllowPredicate = Callable[[dict], bool]

_FAST_ALLOW_PATTERNS: List[Tuple[str, _FastAllowPredicate]] = [
    # 安装 tabtin 自家包
    (
        "package_install",
        lambda args: all(
            p.startswith("@tabtin/") for p in (args.get("packages") or [])
        )
        and len(args.get("packages") or []) > 0,
    ),
    # 只读安全命令（基于 shlex token 分析）
    (
        "execute_in_terminal",
        lambda args: is_safe_shell_command((args.get("command") or "").strip()),
    ),
]


# ── 结果缓存 ─────────────────────────────────────────────────
# 相同 tool_name + args 内容哈希 → 复用结果

_cache: Dict[str, ClassifierResult] = {}
_cache_ts: Dict[str, float] = {}
_cache_lock = threading.Lock()
_MAX_CACHE = 100
def _cache_ttl() -> int:
    from apps.services.agent_engine.configuration import OrchestrationConfiguration
    return OrchestrationConfiguration.from_settings().classifier_cache_ttl


def _cache_key(tool_name: str, tool_args: dict) -> str:
    args_str = json.dumps(tool_args, sort_keys=True, default=str)
    args_hash = hashlib.sha256(args_str.encode()).hexdigest()[:16]
    return f"{tool_name}:{args_hash}"


# ── 快速路径 ─────────────────────────────────────────────────


def check_fast_path(
    tool_name: str, tool_args: dict
) -> Optional[ClassifierResult]:
    """快速路径：不需要 AI 的白名单检查。

    匹配白名单中的 (tool_name, predicate) 对——命中则直接放行。
    """
    for pattern_name, predicate in _FAST_ALLOW_PATTERNS:
        if tool_name != pattern_name:
            continue
        try:
            if predicate(tool_args):
                return ClassifierResult(
                    should_allow=True,
                    confidence="high",
                    reason=f"快速路径白名单: {tool_name}",
                )
        except Exception:
            logger.debug(
                "[AIClassifier] 快速路径 predicate 异常, tool=%s", tool_name,
                exc_info=True,
            )
    return None


# ── AI 分类器 ────────────────────────────────────────────────




def _summarize_args(tool_args: dict, max_len: int = 300) -> str:
    """将工具参数压缩为简短摘要。"""
    raw = json.dumps(tool_args, ensure_ascii=False, default=str)
    if len(raw) <= max_len:
        return raw
    return raw[:max_len] + "..."


def _summarize_messages(recent_messages: list, max_entries: int = 3) -> str:
    """将最近消息压缩为上下文摘要。"""
    parts: list[str] = []
    for msg in recent_messages[-max_entries:]:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
        if isinstance(content, str) and content:
            parts.append(f"{role}: {content[:150]}")
    return "\n".join(parts) if parts else "(no context)"


def classify_risk(
    tool_name: str,
    tool_args: dict,
    recent_messages: list,
    state: dict,
) -> ClassifierResult:
    """AI 分类器：调轻量模型判断风险。

    高置信 + safe=True → should_allow=True
    否则 → should_allow=False（走人工确认）
    """
    key = _cache_key(tool_name, tool_args)
    now = time.monotonic()

    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            if now - _cache_ts.get(key, 0) < _cache_ttl():
                logger.debug("[AIClassifier] 缓存命中: %s", key)
                return cached
            del _cache[key]
            _cache_ts.pop(key, None)

    args_summary = _summarize_args(tool_args)
    context_summary = _summarize_messages(recent_messages)

    user_prompt = (
        f"Operation: {tool_name}({args_summary})\n"
        f"Context:\n{context_summary}\n\n"
        f"Is this operation safe to auto-approve?"
    )

    result = _call_classifier_llm(user_prompt, state)

    with _cache_lock:
        if len(_cache) >= _MAX_CACHE:
            oldest_key = next(iter(_cache))
            del _cache[oldest_key]
            _cache_ts.pop(oldest_key, None)
        _cache[key] = result
        _cache_ts[key] = now

    return result


def _call_classifier_llm(user_prompt: str, state: dict) -> ClassifierResult:
    """调用 LLM 执行风险分类。"""
    try:
        from apps.services.llm.services.chat import unified_llm_call

        user_id = state.get("user_id") or state.get("_origin_user_id") or ""
        organization_id = (
            state.get("organization_id") or state.get("_origin_organization_id") or ""
        )

        if not organization_id or not user_id:
            return ClassifierResult(
                should_allow=False,
                confidence="low",
                reason="缺少 organization/user 信息，回退人工确认",
            )

        tool_name_part = user_prompt.split("(")[0].replace("Operation: ", "").strip() if "Operation:" in user_prompt else ""
        args_part = ""
        context_part = ""
        if "Context:" in user_prompt:
            parts = user_prompt.split("Context:")
            context_part = parts[1].replace("\n\nIs this operation safe to auto-approve?", "").strip() if len(parts) > 1 else ""
        if "(" in user_prompt and ")" in user_prompt:
            args_part = user_prompt[user_prompt.index("(") + 1:user_prompt.index(")")]

        result = unified_llm_call(
            scene_key="tool_risk_classify",
            variables={
                "tool_name": tool_name_part,
                "args_summary": args_part,
                "context_summary": context_part,
            },
            user_id=user_id,
            organization_id=organization_id,
        )

        return _parse_classifier_response(result.content)

    except Exception as exc:
        logger.warning("[AIClassifier] 分类器异常: %s", exc, exc_info=True)
        return ClassifierResult(
            should_allow=False,
            confidence="low",
            reason=f"分类器异常: {exc}",
        )


def _parse_classifier_response(content: str) -> ClassifierResult:
    """解析 LLM 返回的 JSON 分类结果。"""
    content = content.strip()
    if content.startswith("```"):
        lines = content.splitlines()
        content = "\n".join(
            line for line in lines if not line.strip().startswith("```")
        )

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        logger.warning("[AIClassifier] 无法解析 LLM 响应: %.200s", content)
        return ClassifierResult(
            should_allow=False,
            confidence="low",
            reason="分类器返回格式错误，回退人工确认",
        )

    is_safe = bool(data.get("safe", False))
    confidence = data.get("confidence", "low")
    if confidence not in ("high", "medium", "low"):
        confidence = "low"
    reason = str(data.get("reason", ""))

    should_allow = is_safe and confidence == "high"

    return ClassifierResult(
        should_allow=should_allow,
        confidence=confidence,
        reason=reason or ("安全" if should_allow else "需人工确认"),
    )


# ── 连续拒绝追踪 ────────────────────────────────────────────


_DENIAL_STATE_KEY = "_s16_consecutive_denials"
_DENIAL_TOOL_KEY = "_s16_last_denied_tool"
_MAX_DENIALS_BEFORE_WARN = 3


def track_denial(state: dict, tool_name: str) -> int:
    """追踪连续拒绝次数。返回当前连续拒绝数。

    超过阈值时 log 提醒。
    """
    last_tool = state.get(_DENIAL_TOOL_KEY)
    if last_tool == tool_name:
        count = (state.get(_DENIAL_STATE_KEY) or 0) + 1
    else:
        count = 1

    state[_DENIAL_STATE_KEY] = count
    state[_DENIAL_TOOL_KEY] = tool_name

    if count >= _MAX_DENIALS_BEFORE_WARN:
        logger.warning(
            "[AIClassifier] 工具 '%s' 已连续被拒绝 %d 次，"
            "建议用户检查权限配置或调整操作策略",
            tool_name,
            count,
        )

    return count


def reset_denial_tracking(state: dict) -> None:
    """重置拒绝追踪（工具被批准后调用）。"""
    state.pop(_DENIAL_STATE_KEY, None)
    state.pop(_DENIAL_TOOL_KEY, None)


# ── 集成入口 ────────────────────────────────────────────────


def _is_classifier_enabled() -> bool:
    """检查 Django settings 开关（支持 legacy 名回退）。"""
    from apps.services.agent_engine.legacy_env import agent_engine_setting
    return bool(agent_engine_setting("AGENT_ENGINE_AI_CLASSIFIER_ENABLED", False))


def evaluate_with_classifier(
    engine: PermissionRuleEngine,
    tool_name: str,
    tool_args: Optional[Dict[str, Any]],
    state: dict,
    recent_messages: Optional[list] = None,
) -> Tuple[PermissionAction, Optional[ClassifierResult]]:
    """包装 PermissionRuleEngine.evaluate()，在返回 ASK 时可选调用 AI 分类器。

    调用方可选择性使用此函数代替直接调用 engine.evaluate()。
    不修改 engine.evaluate() 本身。

    Returns:
        (action, classifier_result):
        - action: 最终权限动作
        - classifier_result: 分类器结果（仅当分类器被调用时非 None）
    """
    action = engine.evaluate(tool_name, tool_args or {}, state)

    # S17(b): PASSTHROUGH 在此处解析为最终动作
    if action == PermissionAction.PASSTHROUGH:
        action = PermissionRuleEngine._resolve_passthrough(state)

    if action != PermissionAction.ASK:
        if action == PermissionAction.ALLOW:
            reset_denial_tracking(state)
        return action, None

    if not _is_classifier_enabled():
        return action, None

    args = tool_args or {}

    fast = check_fast_path(tool_name, args)
    if fast is not None and fast.should_allow:
        logger.info(
            "[AIClassifier] 快速路径放行: %s (%s)", tool_name, fast.reason,
        )
        reset_denial_tracking(state)
        return PermissionAction.ALLOW, fast

    result = classify_risk(
        tool_name=tool_name,
        tool_args=args,
        recent_messages=recent_messages or [],
        state=state,
    )

    if result.should_allow:
        logger.info(
            "[AIClassifier] AI 分类器放行: %s (confidence=%s, reason=%s)",
            tool_name,
            result.confidence,
            result.reason,
        )
        reset_denial_tracking(state)
        return PermissionAction.ALLOW, result

    logger.info(
        "[AIClassifier] AI 分类器维持确认: %s (confidence=%s, reason=%s)",
        tool_name,
        result.confidence,
        result.reason,
    )
    track_denial(state, tool_name)
    return PermissionAction.ASK, result


# ── A3 升级：CliInvocationSpec 加严入口 ──────────────────────


def try_uplift_safe_to_review(
    spec: "CliInvocationSpec",
    state: Optional[dict] = None,
    recent_messages: Optional[list] = None,
) -> Optional["Decision"]:
    """对 ``safe`` 的 ``CliInvocationSpec`` 调 AI 分类器尝试**加严**到 ``review``。

    与 AI 分类器既有的 ``_FAST_ALLOW_PATTERNS`` 做语义对账：
    - ``spec.risk_level == 'safe'`` 时优先信任 spec（已经过 YAML 静态规则确认）
    - AI 分类器仅用于"提升警惕"，**绝对不放宽**：本函数永远不返回 ``action='allow'``
    - 即便 AI 错误返回 safe，``cli_engine.merge_decisions`` 的单调合并算子也会兜底
      （动态层 allow 同档于 static 的 allow，merge 后维持 static）

    设计权衡（消化技术 Review P2-6）：
    本函数**不**复用 ``check_fast_path``——后者只匹配 ``package_install`` /
    ``execute_in_terminal``，对 ``cli:<domain>.<verb>`` 等 CLI tool_name 永远不命中，
    只会让代码绕远路。CLI 是否需要"快速放行"由本路径上层（``CliPermissionEngine``
    的 ``_should_call_ai_uplift``）通过 ``ai_uplift_yaml_safe`` 配置决定。

    A3 启动包要求"最小改动"：本函数不替换 ``evaluate_with_classifier`` 既有路径，
    后者继续服务 ``execute_in_terminal`` 等既有 tool 调用快路径。

    返回：
    - ``None``                                — AI 维持 safe（含 AI 不可用 / 异常 fail-close）
    - ``Decision(action='review', source='ai')`` — AI 觉得需要加严

    异常处理（fail-close）：任何异常都返回 ``None``，由调用方（``cli_engine``）保持 spec 原 risk_level。
    """
    from apps.services.agent_engine.cli.spec import RISK_SAFE  # 避免硬编码字符串

    # 类型与档位前置校验：本函数仅服务 safe（其他档位由调用方自决）
    if spec is None or getattr(spec, "risk_level", None) != RISK_SAFE:
        return None

    if not _is_classifier_enabled():
        # AI 关闭 = 信任 spec 原判定（safe）
        return None

    # 把 spec 翻译成 AI 分类器既有协议（tool_name + tool_args）
    # tool_name 用 "cli:" 前缀避免与 RegisteredTool 名字冲突
    try:
        tool_name = f"cli:{spec.binary}.{spec.domain}.{spec.verb}"
        tool_args = spec.to_dict()
    except Exception as exc:
        logger.warning(
            "[AIClassifier] try_uplift_safe_to_review: spec serialize 异常 fail-close: %s",
            exc,
            exc_info=True,
        )
        return None

    try:
        result = classify_risk(
            tool_name=tool_name,
            tool_args=tool_args,
            recent_messages=recent_messages or [],
            state=state or {},
        )
    except Exception as exc:
        logger.warning(
            "[AIClassifier] try_uplift_safe_to_review 异常 fail-close (维持 safe): %s",
            exc,
            exc_info=True,
        )
        return None

    if result is None:
        return None

    if result.should_allow:
        logger.debug(
            "[AIClassifier] try_uplift_safe_to_review: AI 维持 safe: %s (reason=%s)",
            tool_name,
            result.reason,
        )
        return None

    # AI 觉得不安全 = 加严到 review
    # 注意：永远不返回 action='deny'（AI 没有权限直接拒绝；deny 由硬底线层负责）
    # 也永远不返回 action='allow'（不能放宽 spec，单调合并兜底约束）
    logger.info(
        "[AIClassifier] try_uplift_safe_to_review: AI 加严 safe→review: %s (reason=%s)",
        tool_name,
        result.reason,
    )
    # Lazy import 避免 cli_engine ↔ ai_classifier 循环依赖
    from apps.services.agent_engine.permissions.cli_engine import Decision
    return Decision(
        action="review",
        reason=f"AI uplift (confidence={result.confidence}): {result.reason}",
        source="ai",
        matched_rule_pattern=getattr(spec, "matched_rule_pattern", "") or "",
    )


__all__ = [
    "ClassifierResult",
    "check_fast_path",
    "classify_risk",
    "track_denial",
    "reset_denial_tracking",
    "evaluate_with_classifier",
    "try_uplift_safe_to_review",
]
