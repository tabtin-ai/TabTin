"""CLI 权限规则引擎（PRD-v3 §5.1 第 3 项 — Wave A 启动包 A3）。

把 ``PermissionRuleEngine`` 从"按 tool 名打分"升级到能识别 ``CliInvocationSpec``
（含 ``binary``/``domain``/``verb``/``risk_level`` 的结构化 spec），
与既有 AI 分类器形成清晰层级。

5 层评估顺序（PRD §5.1 第 3 项 + L4 决策）：
  1. **硬底线**       — ``spec.risk_level == 'strict'`` 且 ``binary`` 不在 strict_allowlist → 直接 ``deny``
  2. **CliInvocationSpec 静态解析** — A1 parser 已经把 ``risk_level`` 落到 spec 上
  3. **YAML 规则匹配** — A1 parser 已完成（spec 上含 ``matched_rule_pattern``），此处不重复
  4. **AI 分类器回落** — 仅当 ``risk_level == 'safe'`` **且 YAML 未命中** 时尝试加严
                        （PRD §5.1 第 3 项字面收紧；可通过 ``ai_uplift_yaml_safe`` 切换为防御深度模式）
  5. **默认策略**     — 兜底 ``review``（A1 parser 已 fail-safe，此处主要逻辑漏洞兜底）

合并算子（A1-L11 / L4 决策）：
  ``merge_decisions(static, dynamic) -> Decision`` 单调合并：
  ``allow < review < deny`` 严格排序；动态层只能向上加严，不能向下放宽。

并行模式（按 PRD §13.2 子 Agent 自决建议）：
  ``CliPermissionEngine`` 是独立类，与既有 ``PermissionRuleEngine`` 不冲突；
  ``PermissionRuleEngine.evaluate_cli_spec`` 内部委托给本模块 singleton（也支持 DI）。

Singleton 化（消化 A1-L7）：
  ``get_default_parser`` / ``get_default_engine`` 提供进程级单例，
  避免 per-request 重读 ``cli_rules.yaml``；首次构造时读 Django settings 注入配置。

Audit 写入（兼容 A2 未完成）：
  ``_emit_audit`` 用 lazy import + try/except 包装；
  ``emit_cli_audit_event`` 不可用或写库失败时静默跳过，**绝不拖累决策路径**
  （启动包"禁止 audit 写失败拖累决策路径"约束）。

  **评估层 vs 执行层 fail-close 分工**（消化三视角 Review P0-2 治理张力）：
  本模块是**评估层**：决策必须返回，不能因 audit 失败被阻塞（observability 与
  decisioning 解耦）。**执行层**（A5 fork 第三方 CLI 等）独立做 fail-close：
  PG 不可达 + decision == ``allow`` 仍执行；audit 写失败仅 Sentry 报警。
  PRD §5.1 第 5 项的"高风险操作不留痕 = 立即可观测"由执行层 + Sentry 闭环。

结构化日志（消化 PRD §9.3）：
  每次 ``evaluate_cli_spec`` 出口打一条 JSON 日志，含 binary/domain/verb/
  risk_level/decision/source/thread_id/user_id（thread_id/user_id 来自 state，缺失为 null）。
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from typing import FrozenSet, Literal, Optional

from apps.services.agent_engine.cli.parser import CliInvocationParser
from apps.services.agent_engine.cli.spec import (
    CliInvocationSpec,
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
)

logger = logging.getLogger(__name__)


# ── Decision ────────────────────────────────────────────────────────

DecisionAction = Literal["allow", "review", "deny"]
DecisionSource = Literal[
    "static",               # Layer 2/3 静态 YAML 决策
    "ai",                   # Layer 4 AI 加严
    "hardline",             # Layer 1 硬底线 deny
    "allowlist_downgrade",  # Layer 1 strict spec 命中 strict_allowlist 后降级 review
    "default",              # Layer 5 真正兜底（A1 parser 已 fail-safe，目前主要预留 future 漏洞）
    "override",             # 人工/HITL 显式覆写（预留给 A4）
]

_VALID_ACTIONS: FrozenSet[str] = frozenset({"allow", "review", "deny"})

_ACTION_STRICTNESS: dict[str, int] = {"allow": 0, "review": 1, "deny": 2}
"""动作严苛度排序（用于合并算子单调性约束）。

与 ``RISK_LEVELS`` 的对应关系：
- ``safe``   → ``allow`` (strictness=0)
- ``review`` → ``review`` (strictness=1)
- ``strict`` → ``deny`` (strictness=2，在硬底线层直接转换)
"""


@dataclass(frozen=True)
class Decision:
    """权限决策结果。

    字段：
    - ``action``                — 最终动作 ``allow`` / ``review`` / ``deny``
    - ``reason``                — 文本理由（审计用）
    - ``source``                — 决策来源（详见 ``DecisionSource`` 枚举）
    - ``matched_rule_pattern``  — 命中的 YAML 规则 pattern（兜底为空字符串）

    与 ``CliInvocationSpec.matched_rule_pattern`` 一脉相承：动态层加严时，
    保留 static 层的 ``matched_rule_pattern`` 便于审计追溯"为什么是这个决策"。
    """

    action: DecisionAction
    reason: str
    source: DecisionSource
    matched_rule_pattern: str = ""

    # ── 消费侧 helper（消化技术 Review P2-2 / 用户 Review A.）──

    @property
    def is_allowed(self) -> bool:
        """``action == 'allow'``：CLI 可直接放行。"""
        return self.action == "allow"

    @property
    def requires_hitl(self) -> bool:
        """``action == 'review'``：需触发 HITL 等待用户决策。"""
        return self.action == "review"

    @property
    def is_blocking(self) -> bool:
        """``action == 'deny'``：CLI 强制拒绝执行（fail-close）。"""
        return self.action == "deny"

    def to_permission_action(self):
        """转换为既有 ``PermissionAction`` 枚举（A4 HITL UI 接入时复用，N18 决议）。

        映射：
        - ``allow``  → ``PermissionAction.ALLOW``
        - ``review`` → ``PermissionAction.ASK``
        - ``deny``   → ``PermissionAction.DENY``
        """
        from apps.services.agent_engine.permissions.rule_engine import PermissionAction
        return {
            "allow": PermissionAction.ALLOW,
            "review": PermissionAction.ASK,
            "deny": PermissionAction.DENY,
        }[self.action]


def merge_decisions(static: Decision, dynamic: Decision) -> Decision:
    """单调合并算子（A1-L11 / L4 决策）：动态层只能加严，不能放宽。

    严苛度排序：``allow`` < ``review`` < ``deny``。

    - ``dynamic.action`` 比 ``static.action`` 严苛 → 采纳 dynamic
      （``reason`` 标注 uplift 来源；``matched_rule_pattern`` 保留 static 的便于审计）
    - ``dynamic.action`` 同档或试图放宽 → 维持 static
      （绝不让 ``review`` 被动态层降到 ``allow``，绝不让 ``deny`` 被动态层降到 ``review``）

    ``merge_decisions(Decision('review', ..., 'static'), Decision('allow', ..., 'ai'))``
    → 必须返回 action='review'（验收单调性的核心断言）。

    **运行时校验**（消化技术 Review P1-5）：非法 ``action`` 抛 ``ValueError``，
    避免 dataclass ``Literal`` 静态校验在跨模块边界被绕过时静默 KeyError。
    """
    for d in (static, dynamic):
        if d.action not in _VALID_ACTIONS:
            raise ValueError(
                f"Decision.action must be one of {sorted(_VALID_ACTIONS)}, "
                f"got {d.action!r}"
            )
    if _ACTION_STRICTNESS[dynamic.action] > _ACTION_STRICTNESS[static.action]:
        return Decision(
            action=dynamic.action,
            reason=f"{dynamic.reason} (uplifted from {static.action})",
            source=dynamic.source,
            matched_rule_pattern=static.matched_rule_pattern,
        )
    return static


# ── Engine ──────────────────────────────────────────────────────────


class CliPermissionEngine:
    """CLI 权限规则引擎（5 层顺序 + 单调合并）。

    并行模式：
        本类与既有 ``PermissionRuleEngine`` 不替换关系；
        既有 ``evaluate(tool_name, args, state)`` 一行不动。
        ``PermissionRuleEngine.evaluate_cli_spec`` 是新接口，内部委托本类 singleton（也支持 DI）。

    Strict allowlist 语义：
        默认 ``DEFAULT_STRICT_ALLOWLIST = frozenset()``（空集 = 任何 strict spec 一律 deny）。
        预留给"特定生产命令 admin 已批准重复执行"等 H2 场景的豁免通道。
        命中 allowlist 的 strict spec 会被降级到 ``review``（仍需 HITL 二次确认），
        而不是直接 ``allow``——保持 fail-close 语义。

    AI uplift 触发条件（PRD §5.1 第 3 项收紧 + 防御深度可配置）：
        - 默认 ``ai_uplift_yaml_safe=False``：AI 仅在 ``spec.risk_level == 'safe'`` 且
          ``matched_rule_pattern == ""``（YAML 未命中）时被调用。这与 PRD 字面
          "AI 分类器（仅在 YAML 未命中时回落）" 一致。
        - 设置 ``ai_uplift_yaml_safe=True`` 后启用"防御深度"模式：
          所有 safe spec（含 YAML 显式 safe）都进 AI 二次加严。可应对 high-risk
          organization 等场景，但代价是每条 safe CLI 多一次 LLM 往返。

    线程安全：
        ``CliPermissionEngine`` 实例无可变状态，可被多线程共享；
        Singleton 由 ``get_default_engine`` 提供。
    """

    DEFAULT_STRICT_ALLOWLIST: FrozenSet[str] = frozenset()

    def __init__(
        self,
        *,
        strict_allowlist: Optional[FrozenSet[str]] = None,
        ai_classifier_enabled: bool = True,
        ai_uplift_yaml_safe: bool = False,
    ) -> None:
        self._strict_allowlist: FrozenSet[str] = (
            strict_allowlist if strict_allowlist is not None else self.DEFAULT_STRICT_ALLOWLIST
        )
        self._ai_classifier_enabled: bool = ai_classifier_enabled
        self._ai_uplift_yaml_safe: bool = ai_uplift_yaml_safe

    @property
    def strict_allowlist(self) -> FrozenSet[str]:
        return self._strict_allowlist

    @property
    def ai_classifier_enabled(self) -> bool:
        return self._ai_classifier_enabled

    @property
    def ai_uplift_yaml_safe(self) -> bool:
        return self._ai_uplift_yaml_safe

    # ------------------------------------------------------------------
    # 主入口：5 层评估
    # ------------------------------------------------------------------

    def evaluate_cli_spec(
        self,
        spec: CliInvocationSpec,
        *,
        state: Optional[dict] = None,
        recent_messages: Optional[list] = None,
    ) -> Decision:
        """按 5 层顺序评估 spec，返回最终 ``Decision``。

        参数：
        - ``spec``            — A1 parser 输出（必填）
        - ``state``           — 可选，AI 分类器需要 ``user_id``/``organization_id`` 上下文；
                              ``thread_id`` 也用于结构化日志
        - ``recent_messages`` — 可选，AI 分类器的对话上下文摘要

        即使 audit 写入失败也不影响决策返回（fail-close 仅作用于决策本身，不传染给审计）。
        """
        # === Layer 1: 硬底线 ===
        if spec.risk_level == RISK_STRICT and spec.binary not in self._strict_allowlist:
            decision = Decision(
                action="deny",
                reason=(
                    f"hardline: strict spec rejected "
                    f"(binary={spec.binary!r} not in strict_allowlist)"
                ),
                source="hardline",
                matched_rule_pattern=spec.matched_rule_pattern,
            )
            self._observe(spec, decision, state)
            return decision

        # === Layer 2 & 3: spec 静态解析（YAML 已经在 A1 parser 完成）===
        static_decision = self._spec_to_static_decision(spec)

        # === Layer 4: AI 分类器仅对 safe 加严（按 PRD 字面收紧 + 防御深度可选）===
        if self._should_call_ai_uplift(spec):
            ai_decision = self._try_ai_uplift(spec, state, recent_messages)
            if ai_decision is not None:
                merged = merge_decisions(static_decision, ai_decision)
                self._observe(spec, merged, state)
                return merged

        # === Layer 5: 默认策略（A1 parser 已 fail-safe 到 review，此处兜底逻辑漏洞）===
        self._observe(spec, static_decision, state)
        return static_decision

    # ------------------------------------------------------------------
    # Layer 2 & 3：静态翻译
    # ------------------------------------------------------------------

    @staticmethod
    def _spec_to_static_decision(spec: CliInvocationSpec) -> Decision:
        """把 ``spec.risk_level`` 翻译成静态 ``Decision``。

        - ``safe``   → ``allow`` (source=static)
        - ``review`` → ``review`` (source=static, HITL 中断)
        - ``strict`` → ``review`` (source=allowlist_downgrade)
                      仅当命中 strict_allowlist 才进到这里；保持 HITL 二次确认，
                      不直接 allow，fail-close 语义。

        ``matched_rule_pattern`` 与 ``reason`` 优先用 spec 携带的（A1 parser 已注入），
        缺失时用合理兜底文案。
        """
        if spec.risk_level == RISK_SAFE:
            return Decision(
                action="allow",
                reason=spec.matched_rule_reason or "spec.risk_level=safe",
                source="static",
                matched_rule_pattern=spec.matched_rule_pattern,
            )
        if spec.risk_level == RISK_REVIEW:
            return Decision(
                action="review",
                reason=spec.matched_rule_reason or "spec.risk_level=review",
                source="static",
                matched_rule_pattern=spec.matched_rule_pattern,
            )
        return Decision(
            action="review",
            reason="strict spec in strict_allowlist, downgraded to review (HITL)",
            source="allowlist_downgrade",
            matched_rule_pattern=spec.matched_rule_pattern,
        )

    # ------------------------------------------------------------------
    # Layer 4：AI 分类器加严
    # ------------------------------------------------------------------

    def _should_call_ai_uplift(self, spec: CliInvocationSpec) -> bool:
        """判定是否进入 layer 4 AI uplift。

        条件（PRD §5.1 第 3 项收紧 + 防御深度可配置）：
        - spec.risk_level 必须是 ``safe``
        - engine 的 ``ai_classifier_enabled`` 必须开
        - 默认 ``ai_uplift_yaml_safe=False``：仅当 YAML 未命中（``matched_rule_pattern == ""``）时才调 AI；
          这与 PRD 字面 "AI 分类器（仅在 YAML 未命中时回落）" 完全一致——
          YAML 已显式标 safe 的命令默认信任，节约 LLM 调用成本与延迟
        - 设置 ``ai_uplift_yaml_safe=True`` 启用防御深度：所有 safe 都过 AI

        当前 A1 parser 兜底是 review（不是 safe），所以默认条件下 layer 4 几乎不被触发；
        本设计是给未来 marketplace App 自定义 cliGrammar 把 spec 落到 safe + 无显式规则
        的场景预留兜底通道。
        """
        if spec.risk_level != RISK_SAFE:
            return False
        if not self._ai_classifier_enabled:
            return False
        if self._ai_uplift_yaml_safe:
            return True
        # 默认：仅 YAML 未命中时调 AI（matched_rule_pattern 为空字符串）
        return spec.matched_rule_pattern == ""

    def _try_ai_uplift(
        self,
        spec: CliInvocationSpec,
        state: Optional[dict],
        recent_messages: Optional[list],
    ) -> Optional[Decision]:
        """调 AI 分类器尝试把 ``safe`` spec 加严到 ``review``。

        语义：
        - 返回 ``None`` 表示 AI 维持 safe（含 AI 不可用 / fast path 放行 / AI 异常 fail-close）
        - 返回 ``Decision(action='review', source='ai')`` 表示 AI 觉得需加严

        AI 分类器永远不会通过本路径放宽 spec（``try_uplift_safe_to_review`` 自身约束）；
        即使 AI 错误返回 ``allow``，``merge_decisions`` 的单调合并算子也会拒绝放宽。
        """
        try:
            from apps.services.agent_engine.permissions.ai_classifier import (
                try_uplift_safe_to_review,
            )
        except ImportError:
            logger.debug(
                "[CliPermissionEngine] ai_classifier module unavailable, skip layer 4"
            )
            return None

        try:
            return try_uplift_safe_to_review(
                spec, state=state or {}, recent_messages=recent_messages,
            )
        except Exception as exc:
            logger.warning(
                "[CliPermissionEngine] AI uplift failed (fail-close, keep safe): %s",
                exc,
                exc_info=True,
            )
            return None

    # ------------------------------------------------------------------
    # 可观测：结构化日志 + audit hook
    # ------------------------------------------------------------------

    def _observe(
        self,
        spec: CliInvocationSpec,
        decision: Decision,
        state: Optional[dict],
    ) -> None:
        """每次决策出口的可观测面：① 结构化日志（PRD §9.3）② audit hook（A2）。

        两者**互不阻塞**：日志失败不影响 audit，audit 失败不影响决策返回。
        """
        self._log_structured(spec, decision, state)
        self._emit_audit(spec, decision, state)

    @staticmethod
    def _log_structured(
        spec: CliInvocationSpec,
        decision: Decision,
        state: Optional[dict],
    ) -> None:
        """每条决策一行 JSON 日志（消化 PRD §9.3 / 用户 Review P0-2）。

        含 ``thread_id`` / ``user_id`` / ``organization_id``（state 中可缺失为 null）+
        spec 关键字段 + decision 完整字段。便于 staging/现网排障与 metrics 聚合。
        """
        try:
            payload = {
                "evt": "cli.permission.decided",
                "binary": spec.binary,
                "domain": spec.domain,
                "verb": spec.verb,
                "risk_level": spec.risk_level,
                "matched_rule_pattern": spec.matched_rule_pattern,
                "decision_action": decision.action,
                "decision_source": decision.source,
                "decision_reason": decision.reason,
                "thread_id": (state or {}).get("thread_id"),
                "user_id": (state or {}).get("user_id"),
                "organization_id": (state or {}).get("organization_id"),
            }
            logger.info(
                "[CliPermissionEngine] %s",
                json.dumps(payload, ensure_ascii=False, default=str),
            )
        except Exception as exc:
            # 日志失败不应影响决策路径（被 _observe 包一层兜底；这里再加一层防守）
            logger.debug(
                "[CliPermissionEngine] structured log failed (decision unchanged): %s",
                exc,
            )

    @staticmethod
    def _emit_audit(
        spec: CliInvocationSpec,
        decision: Decision,
        state: Optional[dict],
    ) -> None:
        """写 ``CliAuditEvent``（A2 接口）；A2 未实现 / DB 异常都静默 swallow。

        约束（启动包"禁止 audit 写失败拖累决策路径"）：
        - 任何 ImportError / Exception / ``CliAuditWriteError`` 都不能让
          ``evaluate_cli_spec`` 抛错
        - 仅记日志，不重试，不传染（audit 是观测面，不是决策面）

        **评估层 vs 执行层 fail-close 分工**（PRD §5.1 第 5 项）：
        本评估层的 audit 失败仅记日志（warning 级别上 Sentry）；
        真正的"PG 不可达 + 高风险 = 拒绝执行"由 A5 执行层 fork 第三方 CLI 前
        独立 verify。A5 在调用 ``emit_cli_audit_event`` 时会保留 ``CliAuditWriteError``
        的传递链作为执行 fail-close 信号；评估层不传染。

        从 ``state`` 提取 A2 必填的 ``thread_id`` / ``agent_id`` / ``user_id``；
        缺失时仍尝试写（A2 内部 ``_coerce_uuid`` 接受 None）。
        """
        try:
            from apps.services.agent_engine.cli.audit import emit_cli_audit_event
        except ImportError:
            logger.debug(
                "[CliPermissionEngine] CliAuditEvent not yet available "
                "(A2 not complete), skip audit write"
            )
            return
        try:
            emit_cli_audit_event(
                spec,
                thread_id=(state or {}).get("thread_id"),
                agent_id=(state or {}).get("agent_id"),
                user_id=(state or {}).get("user_id"),
                rule_decision=decision.action,
                hitl_required=decision.requires_hitl,
            )
        except Exception as exc:
            # 含 A2 的 CliAuditWriteError 在内的任何异常都 swallow（评估层职责）
            logger.warning(
                "[CliPermissionEngine] emit_cli_audit_event failed (decision unchanged): %s",
                exc,
                exc_info=True,
            )


# ── Module-level singletons (消化 A1-L7) ────────────────────────────

_default_parser: Optional[CliInvocationParser] = None
_default_parser_lock = threading.Lock()

_default_engine: Optional[CliPermissionEngine] = None
_default_engine_lock = threading.Lock()


def get_default_parser() -> CliInvocationParser:
    """进程级单例 ``CliInvocationParser``，避免 per-request 重读 ``cli_rules.yaml``。

    A1-L7 升级：A1 ``CliInvocationParser()`` 每次构造都会走一次
    ``load_default_rules()`` 读 YAML；A3 通过本 singleton 让进程内仅读一次。
    """
    global _default_parser
    if _default_parser is None:
        with _default_parser_lock:
            if _default_parser is None:
                _default_parser = CliInvocationParser()
    return _default_parser


def get_default_engine() -> CliPermissionEngine:
    """进程级单例 ``CliPermissionEngine``。

    首次调用时读 Django settings 注入配置（消化用户 Review P1-2 运维通道）：
    - ``AGENT_ENGINE_CLI_STRICT_ALLOWLIST`` (str list/tuple, 默认空) → ``strict_allowlist``
    - ``AGENT_ENGINE_CLI_AI_UPLIFT_YAML_SAFE`` (bool, 默认 False)   → ``ai_uplift_yaml_safe``

    无可变状态，多线程共享安全。``PermissionRuleEngine.evaluate_cli_spec``
    内部就是调用本 singleton（除非显式注入 ``cli_engine``）。
    """
    global _default_engine
    if _default_engine is None:
        with _default_engine_lock:
            if _default_engine is None:
                _default_engine = _build_engine_from_settings()
    return _default_engine


def _build_engine_from_settings() -> CliPermissionEngine:
    """从 Django settings 读配置构造 ``CliPermissionEngine``；settings 不可用时用默认值。"""
    strict_allowlist: Optional[FrozenSet[str]] = None
    ai_uplift_yaml_safe: bool = False
    try:
        from django.conf import settings as _settings
        raw_allowlist = getattr(_settings, "AGENT_ENGINE_CLI_STRICT_ALLOWLIST", None)
        if raw_allowlist:
            strict_allowlist = frozenset(str(b) for b in raw_allowlist)
        ai_uplift_yaml_safe = bool(
            getattr(_settings, "AGENT_ENGINE_CLI_AI_UPLIFT_YAML_SAFE", False)
        )
    except Exception as exc:
        logger.debug(
            "[CliPermissionEngine] Django settings unavailable, fallback to defaults: %s",
            exc,
        )
    return CliPermissionEngine(
        strict_allowlist=strict_allowlist,
        ai_uplift_yaml_safe=ai_uplift_yaml_safe,
    )


def configure_default_engine(engine: Optional[CliPermissionEngine]) -> None:
    """显式覆盖默认 singleton（测试或运维热更新场景）。

    传 ``None`` 等价于 ``reset_default_singletons_for_testing`` 仅 engine 部分。
    生产慎用：会让所有依赖 ``get_default_engine`` 的调用方立刻切到新引擎。
    """
    global _default_engine
    with _default_engine_lock:
        _default_engine = engine


def reset_default_singletons_for_testing() -> None:
    """**测试专用**：重置 module-level singleton。

    严禁在生产路径调用；生产配置变更请用 ``configure_default_engine``。
    """
    global _default_parser, _default_engine
    with _default_parser_lock, _default_engine_lock:
        _default_parser = None
        _default_engine = None


__all__ = [
    "CliPermissionEngine",
    "Decision",
    "DecisionAction",
    "DecisionSource",
    "merge_decisions",
    "get_default_parser",
    "get_default_engine",
    "configure_default_engine",
    "reset_default_singletons_for_testing",
]
