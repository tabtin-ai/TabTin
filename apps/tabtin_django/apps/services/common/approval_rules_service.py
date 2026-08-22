"""
统一审批 · 规则查询服务（W1.2）

合并三层规则源得出最终判决：
  1. 平台硬底线（``generated_hardline.check_safety_hardline``，从
     ``packages/security-policy/src/hardline-rules.json`` codegen）
  2. Agent 治理层（v2 嵌套：``tabtinspace.Agent.agent_config.capabilities``
     ``.overrides.shell.operation_switches`` + 顶层 ``authorization_preset``，
     可由调用方通过 ``governance_hint`` 注入 PolicyEvaluator 已派生的
     allow/confirm/block 结论；W2.1 决议起业务读取路径仅触碰 v2 嵌套，
     入参若为 v1 形状会在 ``evaluate`` 入口自动 ``migrate_v1_to_v2``。）
  3. 用户记忆层（``UserAgentApprovalMemo``，由 W1.1 ``ApprovalMemoService``
     封装查询）

判决优先级（命中即返回）：

    1. hardline.kind == 'block'         → deny / source='hardline_block'
    2. governance_hint == 'block' OR
       operation_switches[X] == 'block' → deny / source='governance_block'
    3. UserAgentApprovalMemo deny       → deny / source='memo_deny'
    4. UserAgentApprovalMemo allow      → allow / source='memo_allow'
                                         （hardline.kind == 'confirm' 时降为
                                           ask / source='hardline_confirm'，
                                           D9 安全兜底：硬底线类操作不能"以后
                                           不再询问"）
    5. governance_hint == 'confirm' OR
       operation_switches[X] == 'confirm' OR
       hardline.kind == 'confirm'       → ask / source='governance_ask' /
                                           'hardline_confirm'
    6. governance_hint == 'allow' OR
       operation_switches[X] == 'allow' → allow / source='governance_allow'
    7. authorization_preset 派生         → allow / ask / source='preset_fallback'

**跨层语义**：deny 优先于 ask 优先于 allow。本 service 在每一层命中时立刻
return，所以这种"优先级"由判决顺序天然保证。

**与方案 §4.4 文档的差异**（重要、本 service 故意为之）：
方案 §4.4 把"治理层 ask"放在"用户 memo allow"之前；本 service 把"用户 memo
allow"放在"治理层 ask"之前——理由是 D9 拍板"用户点了'记住选择'就是显式批
准"，比 admin 配的"需要确认"语义更强；如果 admin 想完全压住用户的'以后允许'
应该配 'block' 而不是 'confirm'。本差异已与 task 描述对齐，但方案 §4.4 的
文字顺序可能要回头修一笔（harness 跟用户对齐）。

**治理层 key 空间问题**（重要、本期未根治）：
``capabilities.overrides.shell.operation_switches`` 现网存的是
``OperationSwitchKey``（``git_read`` / ``rm`` / ``docker`` / ``ssh`` 等细粒度
子开关，给 client 端 ``PolicyEvaluator`` 做命令模式判定），跟本 service 的
``ActionType`` 维度（``execute_in_terminal`` / ``write_file`` 等粗粒度）
**不重合**。直接用 ``operation_switches.get(action_type)`` 在生产数据上
几乎永远 miss。

为了让客户端 Host（Phase 2）能把 ``PolicyEvaluator`` 已经派生的"action_type
粒度结论"喂给本 service，``evaluate`` 接受 ``governance_hint`` 参数（取值
``'allow' | 'confirm' | 'block'``）。调用方应：
  - 在 client 端先跑 ``PolicyEvaluator.evaluate(policy, action_type, params)``
    拿到 ``PolicyAction``
  - 把它（``allow/confirm/block``）通过 ``governance_hint`` 传给本 service
  - 让 service 把它跟 hardline / memo / preset fallback 串成最终判决

W1.3 REST API 也走 hint 注入；W1.5 北极星 e2e 必须验证两端一致。如果不传
hint，service 退化到"直接 dict lookup operation_switches[action_type]"，主要
覆盖未来"按 ActionType 全局开关"扩展（当前几乎永远 miss），不依赖于此。

跨库注意：``Agent`` 在 PostgreSQL（``tabtinspace`` app），``UserAgentApprovalMemo``
在 MySQL（``users_auth`` app）。每次 ``evaluate`` 默认会查 Agent 表，调用方
可通过传入 ``agent_config`` 跳过这次查询（避免一次请求多次 evaluate 时的
N+1）。客户端 Host 进程应做 5min TTL 的 LRU 缓存（W1.0 调研结论），但缓存
**不属于本服务层职责**。

action_type SSoT：参 ``approval_action_types.py``。未知 action_type 入参直接
抛 ``ValueError`` —— fail loud，避免与 TS 端命名漂移导致的 silent miss。

不归本服务的事：
  - REST API（W1.3）—— 本 service 是纯 Python 调用，没有 HTTP 层
  - 客户端规则缓存 / WS 失效信号（Phase 2）
  - prompt.forward 加 agent_id 字段（D-tech-10，W1.3）
  - HITL 超时统一（W1.6）
  - 前端 ApprovalCard UI（Phase 3）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional
from uuid import UUID

from .approval_action_types import (
    ApprovalActionType,
    FILE_ACTION_TYPES,
    TERMINAL_ACTION_TYPES,
    assert_known_action_type,
)
from .generated_hardline import HardlineVerdict, check_safety_hardline
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 数据类型
# ---------------------------------------------------------------------------

ApprovalBehavior = Literal['allow', 'ask', 'deny']
GovernanceHint = Literal['allow', 'confirm', 'block']

# Source 取值（穷举，方便调用方做枚举对齐）。
# 命名约定：``<层名>_<结果>``，便于审计 / Phase 3 UI 显示"为什么这条命令需要审批"。
SOURCE_HARDLINE_BLOCK = 'hardline_block'
SOURCE_HARDLINE_CONFIRM = 'hardline_confirm'
SOURCE_GOVERNANCE_BLOCK = 'governance_block'
SOURCE_GOVERNANCE_ASK = 'governance_ask'
SOURCE_GOVERNANCE_ALLOW = 'governance_allow'
SOURCE_MEMO_DENY = 'memo_deny'
SOURCE_MEMO_ALLOW = 'memo_allow'
SOURCE_PRESET_FALLBACK = 'preset_fallback'

# 已知 source 集合：调用方可以做穷举校验，避免拼写漂移。
ALL_SOURCES: frozenset = frozenset({
    SOURCE_HARDLINE_BLOCK,
    SOURCE_HARDLINE_CONFIRM,
    SOURCE_GOVERNANCE_BLOCK,
    SOURCE_GOVERNANCE_ASK,
    SOURCE_GOVERNANCE_ALLOW,
    SOURCE_MEMO_DENY,
    SOURCE_MEMO_ALLOW,
    SOURCE_PRESET_FALLBACK,
})


@dataclass(frozen=True)
class ApprovalDecision:
    """统一审批服务的最终判决。

    behavior 三态：
      - ``'allow'`` → 直接放行
      - ``'deny'``  → 直接拒绝（不再问用户）
      - ``'ask'``   → 弹审批卡片让用户决定

    source 字段是"哪一层得出的判决"，主要用途：
      - 审计 / 日志：方便排查"为什么这条命令被拦了"
      - Phase 3 ApprovalCard UI：显示"为什么需要审批"（hardline / 治理 / 记忆）
      - debug：方便 e2e 测试断言

    matched_rule 字段是命中的具体规则：
      - hardline 命中 → ``{'kind': 'block', 'pattern_name': ..., 'matched_text': ...}``
      - 治理层命中 → ``{'switch_value': 'block', 'switch_key': action_type}``
      - 记忆层命中 → ``{'memo_id': str, 'pattern': str, 'rule_kind': ...}``
      - 兜底未命中 → None
    """

    behavior: ApprovalBehavior
    source: str
    reason: str
    matched_rule: Optional[Dict[str, Any]] = field(default=None)


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

# PD-1（W6 M5）：_PRESET_FALLBACK_BEHAVIOR / _resolve_preset_fallback / _DEFAULT_PRESET
# 已删除。step 7 现在直接读 security.allow_yolo_mode（v3 PRD §5.1.1 改名），
# 不再做 preset fallback。


def _build_hardline_tool_input(
    action_type: str,
    raw_pattern: str,
    extra_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """把 (action_type, raw_pattern) 转成 hardline 期望的 tool_input dict。

    ``check_safety_hardline`` 期望从 dict 里按 ``SENSITIVE_FIELD_NAMES``
    顺序找字符串值，所以要把 raw_pattern 按 action_type 语义放到正确的字段。

    扫描字段顺序见 ``generated_hardline.SENSITIVE_FIELD_NAMES``：
        command / cmd / shell_command / shell / script / path / file_path /
        filepath / target_file / file / uri / destination / target / content /
        url / href / query / sql

    映射：
      - 终端类 → 'command'
      - 文件 / 搜索类 → 'file_path'
      - sql_execute → 'sql'
      - device_action / eval → 'script'（hardline 主要拦 eval $VAR 这种，eval
        类操作里 raw_pattern 通常是脚本文本）
      - 其它（理论上不存在，因为 action_type 已在白名单）→ 'content' 兜底

    如果调用方有完整 ``params``（命令工具的 stdin、文件的 content 等），可通过
    ``extra_params`` 透传——hardline 会扫所有 string 字段，不会漏。
    """
    tool_input: Dict[str, Any] = dict(extra_params or {})

    if action_type in TERMINAL_ACTION_TYPES:
        # 不覆盖 extra_params 已有的同名字段
        tool_input.setdefault('command', raw_pattern or '')
    elif action_type in FILE_ACTION_TYPES or action_type in (
        ApprovalActionType.CODE_GLOB,
        ApprovalActionType.CODE_GREP,
    ):
        tool_input.setdefault('file_path', raw_pattern or '')
    elif action_type == ApprovalActionType.SQL_EXECUTE:
        tool_input.setdefault('sql', raw_pattern or '')
    elif action_type in (ApprovalActionType.DEVICE_ACTION, ApprovalActionType.EVAL):
        tool_input.setdefault('script', raw_pattern or '')
    else:  # pragma: no cover —— assert_known_action_type 已挡住未知值
        tool_input.setdefault('content', raw_pattern or '')

    return tool_input


def _hardline_to_dict(verdict: HardlineVerdict) -> Dict[str, Any]:
    return {
        'kind': verdict.kind,
        'pattern_name': verdict.pattern_name,
        'matched_text': verdict.matched_text,
        'matched_field': verdict.matched_field,
    }


def _load_agent_config(agent_id: UUID) -> Dict[str, Any]:
    """跨库（PG）查 Agent.agent_config。

    Agent 在 PostgreSQL；用 ``.using(postgres_app_db_alias())`` 显式指定 db alias。
    若 Agent 不存在 / 字段缺失 → 返回空 dict（fallback 走 collaborative preset）。

    **N+1 风险**：每次 ``evaluate`` 都要查一次。调用方在批量场景下应
    预加载 ``agent_config`` 通过参数传入；客户端 Host 应做 5min TTL LRU。
    """
    try:
        # 延迟 import 避免 service 模块 import 时触发 tabtinspace app 加载
        # （主要为单测：不装 tabtinspace 也能跑 service 测试）。
        from apps.tabtinspace.models import Agent

        agent = Agent.objects.using(postgres_app_db_alias()).filter(pk=agent_id).only('agent_config').first()
        if agent is None:
            logger.warning(
                '[ApprovalRulesService] agent_id=%s not found in postgresql db; '
                'fallback to empty agent_config (collaborative preset).',
                agent_id,
            )
            return {}
        cfg = getattr(agent, 'agent_config', None) or {}
        if not isinstance(cfg, dict):
            logger.warning(
                '[ApprovalRulesService] agent_id=%s has non-dict agent_config '
                '(%s); fallback to empty.',
                agent_id, type(cfg).__name__,
            )
            return {}
        return cfg
    except Exception as exc:  # noqa: BLE001
        # 数据库故障 / app 未装等异常都按"无配置"兜底，不让审批服务
        # 因 Agent 表查询失败而 5xx——降级体验是"按 collaborative 弹审批"，
        # 不是"用户被锁住没法用"。
        logger.exception(
            '[ApprovalRulesService] Failed to load agent_config for %s: %s',
            agent_id, exc,
        )
        return {}


def _load_organization_settings(agent_id: UUID) -> Optional[Dict[str, Any]]:
    """从 agent_id 反查其所属 Organization 的 ``settings``（ yolo 组织天花板）。

    ：yolo gate 是组织准入天花板，从 ``Agent.organization.settings`` 读，
    不再读 agent_config。查不到 / 非 dict / 异常 → None（resolver fail-safe 关 yolo）。
    """
    try:
        from apps.tabtinspace.models import Agent

        agent = (
            Agent.objects.using(postgres_app_db_alias())
            .filter(pk=agent_id)
            .select_related('organization')
            .only('organization__settings')
            .first()
        )
        organization = getattr(agent, 'organization', None) if agent else None
        settings = getattr(organization, 'settings', None) if organization else None
        return settings if isinstance(settings, dict) else None
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            '[ApprovalRulesService] Failed to load organization settings for agent %s: %s',
            agent_id, exc,
        )
        return None


# ---------------------------------------------------------------------------
# 主服务
# ---------------------------------------------------------------------------


class ApprovalRulesService:
    """统一审批规则查询服务。

    所有方法 ``@staticmethod`` —— 服务无状态，与项目内 ``ApprovalMemoService``
    / ``ToolPermissionGuard`` 同风格。
    """

    @staticmethod
    def evaluate(
        user_id: str,
        agent_id: UUID,
        action_type: str,
        raw_pattern: str,
        *,
        session_id: Optional[UUID] = None,  # noqa: ARG004 —— 预留给审计/debug
        agent_config: Optional[Dict[str, Any]] = None,
        governance_hint: Optional[GovernanceHint] = None,
        extra_tool_input: Optional[Dict[str, Any]] = None,
    ) -> ApprovalDecision:
        """合并治理层 + 记忆层 + 硬底线得出最终判决。

        Args:
            user_id: User.id。memo 查询按 (user, agent_id, action_type, pattern) 维度。
            agent_id: Agent.id（PostgreSQL）。本服务跨库读它的 agent_config。
            action_type: 动作类型。必须在 ``ApprovalActionType.ALL`` 白名单里，
                未知值抛 ``ValueError``（避免与 TS 端命名漂移）。
            raw_pattern: 原始 pattern（命令字符串 / 文件路径 / SQL 等）。终端类会
                被 ``ApprovalMemoService._normalize_command`` 处理，与 W1.1 写入
                行为一致。
            session_id: 可选，调用上下文（仅审计/debug 用，本 wave 暂未消费）。
            agent_config: 可选预加载的 agent_config dict。传入时跳过 ``Agent``
                表查询——批量场景下用来避免 N+1。``None`` 时本服务自动跨库查。
            governance_hint: 可选，调用方（client Host / Phase 2 PolicyEvaluator）
                把 ``operation_switches`` × 命令模式判定后的"action_type 粒度
                治理结论"喂给本服务。取值 ``'allow' | 'confirm' | 'block'``。
                **如果传入，会覆盖** ``operation_switches.get(action_type)``
                的 dict lookup 结果——这是真治理层判决的正确路径，因为现网
                ``operation_switches`` 存的是 ``OperationSwitchKey`` 粒度
                （``git_read`` / ``rm`` 等），跟 ActionType 不重合。
            extra_tool_input: 可选，传给 hardline 的额外 tool_input 字段（如
                stdin / content）。raw_pattern 按 action_type 自动放对位置；
                有更多字段需要参与 hardline 扫描时传这里。

        Returns:
            ApprovalDecision —— behavior + source + reason + matched_rule。

        Raises:
            ValueError: action_type 或 governance_hint 不在白名单。
        """
        # ── 0. 入参校验 ────────────────────────────────────────────
        assert_known_action_type(action_type)
        if governance_hint is not None and governance_hint not in ('allow', 'confirm', 'block'):
            raise ValueError(
                f"governance_hint must be one of 'allow' / 'confirm' / 'block', "
                f"got {governance_hint!r}"
            )

        # ── 1. Hardline ───────────────────────────────────────────
        # 注意：hardline 是平台硬底线，**不可被治理层或用户记忆覆盖**。
        # block → 直接 deny；confirm → 标记"用户记忆 allow 也要降级 ask"。
        tool_input = _build_hardline_tool_input(action_type, raw_pattern, extra_tool_input)
        hardline_verdict = check_safety_hardline(action_type, tool_input)

        if hardline_verdict and hardline_verdict.kind == 'block':
            return ApprovalDecision(
                behavior='deny',
                source=SOURCE_HARDLINE_BLOCK,
                reason=(
                    f'操作触发了平台安全红线（{hardline_verdict.pattern_name}），'
                    f'任何配置都无法解锁'
                ),
                matched_rule=_hardline_to_dict(hardline_verdict),
            )

        hardline_force_ask = bool(
            hardline_verdict and hardline_verdict.kind == 'confirm'
        )

        # ── 2. 治理层 block（governance_hint 由客户端 judge 注入）────
        if governance_hint == 'block':
            return ApprovalDecision(
                behavior='deny',
                source=SOURCE_GOVERNANCE_BLOCK,
                reason='Agent 安全配置（管理员或组织设置）已拒绝此类操作',
                matched_rule={
                    'switch_key': action_type,
                    'switch_value': 'block',
                    'switch_source': 'governance_hint',
                },
            )

        # ── 3 / 4. 用户记忆层 ────────────────────────────────────
        # 延迟 import：避免 service 模块 import 时触发 users.auth app 加载。
        from apps.users.auth.approval_memo_service import ApprovalMemoService
        from apps.users.auth.models import UserAgentApprovalMemo

        memo = ApprovalMemoService.find_match(
            user_id=user_id,
            agent_id=agent_id,
            action_type=action_type,
            raw_pattern=raw_pattern,
        )
        if memo is not None:
            matched = {
                'memo_id': str(memo.id),
                'pattern': memo.pattern,
                'rule_kind': memo.rule_kind,
            }
            if memo.rule_kind == UserAgentApprovalMemo.RULE_KIND_DENY:
                return ApprovalDecision(
                    behavior='deny',
                    source=SOURCE_MEMO_DENY,
                    reason='你之前对这个 Agent 选过"总是拒绝"此类操作',
                    matched_rule=matched,
                )
            if memo.rule_kind == UserAgentApprovalMemo.RULE_KIND_ALLOW:
                # D9 安全兜底：hardline.confirm 类操作即使有 memo allow 也要 ask。
                # 避免用户对"写 ~/.ssh"等敏感操作设了"以后不再询问"后被静默
                # 放行——前端 ApprovalCard 应同步 disable"记住选择"勾选框，
                # 但服务层兜底要先把 ask 返回出去。
                if hardline_force_ask:
                    return ApprovalDecision(
                        behavior='ask',
                        source=SOURCE_HARDLINE_CONFIRM,
                        reason=(
                            '此类操作触及平台安全规则，每次都要你亲自确认；'
                            '你之前选过的"以后允许"对它无效'
                        ),
                        matched_rule={
                            **_hardline_to_dict(hardline_verdict),  # type: ignore[arg-type]
                            'overrides_memo_allow': True,
                            'memo_id': str(memo.id),
                        },
                    )
                return ApprovalDecision(
                    behavior='allow',
                    source=SOURCE_MEMO_ALLOW,
                    reason='你之前对这个 Agent 选过"总是允许"此类操作',
                    matched_rule=matched,
                )

        # ── 5. 治理层 ask（含 hardline.confirm）────────────────────
        if governance_hint == 'confirm':
            return ApprovalDecision(
                behavior='ask',
                source=SOURCE_GOVERNANCE_ASK,
                reason='Agent 安全配置要求此类操作每次都要你确认',
                matched_rule={
                    'switch_key': action_type,
                    'switch_value': 'confirm',
                    'switch_source': 'governance_hint',
                },
            )

        if hardline_force_ask:
            return ApprovalDecision(
                behavior='ask',
                source=SOURCE_HARDLINE_CONFIRM,
                reason='此类操作触及平台安全规则，每次都需要你确认',
                matched_rule=_hardline_to_dict(hardline_verdict),  # type: ignore[arg-type]
            )

        # ── 6. 治理层 allow ────────────────────────────────────────
        if governance_hint == 'allow':
            return ApprovalDecision(
                behavior='allow',
                source=SOURCE_GOVERNANCE_ALLOW,
                reason='Agent 安全配置允许此类操作自动通过',
                matched_rule={
                    'switch_key': action_type,
                    'switch_value': 'allow',
                    'switch_source': 'governance_hint',
                },
            )

        # ── 7. yolo 组织准入天花板 fallback ──────────────────────────
        # ：yolo gate 从 Agent 级改为**组织准入天花板**——读 Agent 所属
        # 组织的 ``settings.allow_member_yolo``，不再读 agent_config。组织开放 →
        # 自动放行；否则落到默认 ask（下方 return）。matched_rule key 用
        # ``allow_member_yolo``，便于 admin 审计面板按字段名 grep。
        # resolver fail-safe：查不到 / 脏值 → False（宁可多弹审批，不误放行）。
        from apps.services.common.agent_governance_resolver import (
            resolve_allow_yolo_mode,
        )
        allow_yolo = resolve_allow_yolo_mode(_load_organization_settings(agent_id))

        if allow_yolo:
            return ApprovalDecision(
                behavior='allow',
                source=SOURCE_PRESET_FALLBACK,
                reason='组织已开放 Yolo 准入，自动放行',
                matched_rule={'allow_member_yolo': True},
            )

        return ApprovalDecision(
            behavior='ask',
            source=SOURCE_PRESET_FALLBACK,
            reason='默认需要你确认此类操作',
            matched_rule={'allow_yolo_mode': False},
        )


__all__ = [
    'ApprovalDecision',
    'ApprovalRulesService',
    'GovernanceHint',
    'ApprovalBehavior',
    'ALL_SOURCES',
    'SOURCE_HARDLINE_BLOCK',
    'SOURCE_HARDLINE_CONFIRM',
    'SOURCE_GOVERNANCE_BLOCK',
    'SOURCE_GOVERNANCE_ASK',
    'SOURCE_GOVERNANCE_ALLOW',
    'SOURCE_MEMO_DENY',
    'SOURCE_MEMO_ALLOW',
    'SOURCE_PRESET_FALLBACK',
]
