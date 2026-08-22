"""
PermissionRuleEngine - 权限规则引擎

基于操作类别的授权规则 + allow/ask/deny × once/session/always 矩阵。

规则优先级（高 → 低）:
1. Session-level override（HITL 审批时用户选择 scope=session 的结果）
2. Authorization rules（_authorization_rules 按操作类别: read/write/script/delete_system/install）
3. Tool metadata fallback（risk_level 字段: safe → ALLOW, review/strict → ASK）
4. 默认策略（可配置: "allow" 或 "ask"）

A3 升级（PRD-v3 §5.1 第 3 项）：新增 ``evaluate_cli_spec`` 入口，
可识别 ``CliInvocationSpec`` 结构化 spec；与既有 ``evaluate(tool_name, ...)``
**并行模式**共存，不替换。详见 ``apps.services.agent_engine.permissions.cli_engine``。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from enum import Enum
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple
from uuid import UUID

if TYPE_CHECKING:
    from apps.services.agent_engine.cli.spec import CliInvocationSpec
    from apps.services.agent_engine.permissions.cli_engine import Decision

logger = logging.getLogger(__name__)

PERM_ALWAYS_GEN_KEY = "perm:always_cache_gen"
ALWAYS_PERSIST_RETRY_DELAYS_SECONDS = (0.02, 0.05)


class PermissionAction(str, Enum):
    """权限动作。"""
    ALLOW = "allow"
    ASK = "ask"      # HITL 中断
    DENY = "deny"
    PASSTHROUGH = "passthrough"  # S17(b): 未匹配任何规则，由外层根据预设决定


class PermissionScope(str, Enum):
    """权限记忆范围。

    v0.4 W2-轮 1（PRD 05 §7.2.2 + §9.3 L1.5-2-A）：``SESSION = "session"``
    内部枚举字面值升级为 ``"thread"`` 与 wire schema 全链统一（``ApprovalScope``
    一刀切已删除 ``'session'``）。本字段无 caller 调用 ``record_decision``
    （grep 验证 dormant），改名不破坏行为；保留 ``SESSION`` enum 名作为
    Python 常量供历史代码兼容引用。
    """
    ONCE = "once"           # 仅本次调用
    SESSION = "thread"      # 本会话内（v0.4：原 "session" 升级为 "thread"）
    ALWAYS = "always"       # 永久（当前写入 session 缓存）


class PermissionRuleEngine:
    """权限规则评估引擎。

    核心方法:
        evaluate(tool_name, args, state) → PermissionAction
        record_decision(tool_name, decision, scope, state) → None

    集成方式:
        NativeReactLoop 构造时注入 permission_engine，
        在执行 tool_calls 前调用 evaluate()。

    安全约束:
        每次请求（ReactAgent / agent_caller / Celery task）必须新建实例，
        严禁单例复用或跨请求共享——内存缓存按 (user_id, space_id) 隔离，
        复用实例虽然有防御性身份校验，但设计上仍假设 per-request 生命周期。
    """

    _ALWAYS_CACHE_TTL_SECONDS = 300
    _always_cache_generation: int = 0

    def __init__(
        self,
        *,
        default_policy: str = "allow",
        cli_engine: Optional["object"] = None,
    ):
        self._default_policy = PermissionAction(default_policy) if default_policy in ("allow", "ask", "deny") else PermissionAction.ALLOW
        # legacy: 已迁移到 state["_permission_cache"]，保留供向后兼容
        self._always_decisions_cache: Optional[Dict[str, str]] = None
        self._cache_loaded_at: float = 0.0
        self._cached_user_id: Optional[str] = None
        self._cached_space_id: Optional[str] = None
        # A3 升级：可选 CliPermissionEngine 注入（不传 = 走 module-level singleton）
        # 类型注解写成 object 以避免 import cli_engine（lazy 评估）
        self._cli_engine = cli_engine

    def evaluate(
        self,
        tool_name: str,
        args: Optional[Dict[str, Any]],
        state: dict,
    ) -> PermissionAction:
        """评估工具调用的权限。

        按优先级检查:
        0. S17(a) 安全硬底线（无条件，任何预设都无法绕过）
        1. S17(c) 审批记忆化（tool_name:args_pattern 级别的"总是允许"缓存）
        2. Session-level decisions（本次会话内用户已做出的决策）
        3. Tool metadata（risk_level + authorization_rules）
        4. S17(b) Passthrough fallback（未匹配时返回 PASSTHROUGH）
        """
        # --- S17(a): 安全硬底线 ---
        from apps.services.common.authorization_policy import check_safety_hardline
        hardline = check_safety_hardline(tool_name, args)
        if hardline is not None:
            verdict, _reason = hardline
            if verdict == "block":
                return PermissionAction.DENY
            return PermissionAction.ASK  # "confirm" → ASK

        # --- S17(c): 审批记忆化前置检查 ---
        always_mem = self._check_always_memory(tool_name, args, state)
        if always_mem is not None:
            return always_mem

        session_decision = self._check_session_decisions(tool_name, state)
        if session_decision is not None:
            return session_decision

        tool_meta_decision = self._check_tool_metadata(tool_name, state)
        if tool_meta_decision is not None:
            return tool_meta_decision

        # --- S17(b): Passthrough fallback ---
        return PermissionAction.PASSTHROUGH

    def evaluate_batch(
        self,
        tool_calls: List[dict],
        state: dict,
    ) -> Tuple[List[dict], List[dict], List[dict]]:
        """批量评估一组 tool_calls 的权限。

        Args:
            tool_calls: OpenAI 格式的 tool_call 列表
            state: 当前完整 state

        Returns:
            (allowed, denied, needs_review): 三个分组列表
        """
        allowed: List[dict] = []
        denied: List[dict] = []
        needs_review: List[dict] = []

        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            try:
                args = json.loads(func.get("arguments", "{}"))
            except (json.JSONDecodeError, TypeError):
                args = {}

            action = self.evaluate(tool_name, args, state)

            # S17(b): PASSTHROUGH 根据预设解析为最终动作
            if action == PermissionAction.PASSTHROUGH:
                action = self._resolve_passthrough(state)

            if action == PermissionAction.ALLOW:
                allowed.append(tc)
            elif action == PermissionAction.DENY:
                denied.append(tc)
            else:  # ASK
                needs_review.append(tc)

        return allowed, denied, needs_review

    def record_decision(
        self,
        tool_name: str,
        decision: PermissionAction,
        scope: PermissionScope,
        state: dict,
        args: Optional[Dict[str, Any]] = None,
    ) -> None:
        """记录用户的权限决策。

        Args:
            tool_name: 工具名称
            decision: 用户的决策（allow/deny）
            scope: 记忆范围（once/session/always）
            state: 当前 state（session 级决策写入 state）
            args: 工具调用参数（ALWAYS scope 时用于路径敏感记忆化）
        """
        if scope == PermissionScope.ONCE:
            # once 不需要记录，调用方直接使用
            return

        if scope == PermissionScope.SESSION:
            decisions = dict(state.get("_permission_decisions") or {})
            decisions[tool_name] = decision.value
            state["_permission_decisions"] = decisions
            self._sync_decisions_to_contextvar(decisions)
            logger.info(
                "[PermissionEngine] 记录 session 决策: %s → %s",
                tool_name, decision.value,
            )
            return

        if scope == PermissionScope.ALWAYS:
            decisions = dict(state.get("_permission_decisions") or {})
            decisions[tool_name] = decision.value
            state["_permission_decisions"] = decisions
            self._sync_decisions_to_contextvar(decisions)
            self._persist_always_decision(tool_name, decision, state)
            self.record_always_memory(tool_name, args, decision, state)
            perm_cache = state.get("_permission_cache")
            if perm_cache is not None:
                current_user = str(state.get("user_id") or "")
                current_space = str(state.get("current_space_id") or "")
                if (
                    perm_cache.get("user_id") == current_user
                    and perm_cache.get("space_id") == current_space
                ):
                    perm_cache["decisions"][tool_name] = decision.value
                    perm_cache["loaded_at"] = time.monotonic()
            logger.info(
                "[PermissionEngine] 记录 always 决策: %s → %s (已持久化+路径记忆)",
                tool_name, decision.value,
            )
            return

    def build_interrupt_payload(
        self,
        needs_review: List[dict],
        denied: List[dict],
    ) -> dict:
        """构造 HITL 中断 payload，扩展原有格式。

        扩展: 添加 permission_context 字段。
        """
        import uuid as _uuid

        from apps.services.common.hitl_security import compute_args_hash

        action_requests = []
        review_configs = []

        for tc in needs_review:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            try:
                args = json.loads(func.get("arguments", "{}"))
            except (json.JSONDecodeError, TypeError):
                args = {}

            action_requests.append({
                "tool_name": tool_name,
                "tool_call_id": tc.get("id", ""),
                "arguments": args,
                "args_hash": compute_args_hash(args),
            })
            review_configs.append({
                "tool_name": tool_name,
                "review_type": "approve_reject",
            })

        denied_tools = []
        for tc in denied:
            func = tc.get("function", {})
            denied_tools.append(func.get("name", ""))

        return {
            "id": str(_uuid.uuid4()),
            "value": {
                "action_requests": action_requests,
                "review_configs": review_configs,
                "permission_context": {
                    "can_remember": True,
                    "scopes": ["once", "thread", "always"],
                    "denied_tools": denied_tools,
                },
            },
        }

    def build_denied_tool_results(self, denied: List[dict]) -> List[dict]:
        """为被拒绝的工具调用生成 tool result error messages。

        LLM 会看到这些错误，从而了解哪些工具被禁止并调整策略。
        """
        results = []
        for tc in denied:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            tool_call_id = tc.get("id", "")
            results.append({
                "role": "tool",
                "content": json.dumps({
                    "error": f"Permission denied: 工具 '{tool_name}' 已被用户禁止执行。"
                             f"请使用其他方法完成任务，或告知用户需要此权限。"
                }, ensure_ascii=False),
                "tool_call_id": tool_call_id,
            })
        return results

    # ------------------------------------------------------------------
    # S17(c): 审批记忆化 — "总是允许此操作" 路径
    # ------------------------------------------------------------------

    _ALWAYS_MEMORY_STATE_KEY = "_permission_always_memories"

    _PATH_SENSITIVE_PARAMS: frozenset = frozenset({
        "file_path", "path", "directory", "target_path",
        "filepath", "dir", "filename",
    })

    @staticmethod
    def _build_memory_key(tool_name: str, args: Optional[Dict[str, Any]]) -> str:
        """构造记忆化 key：tool_name:sorted_keys[:path_hash]。

        基础维度为 args 的 sorted key 名称集合（结构匹配）。
        当 args 中包含路径敏感参数（file_path / path / directory 等）时，
        将这些参数值经 os.path.normpath 规范化后拼接取 SHA-256 前 8 位
        追加到 key，防止用户对安全路径的 ALWAYS 审批被静默复用到任意路径。
        """
        if not args:
            return f"{tool_name}:*"
        sorted_keys = ",".join(sorted(args.keys()))

        path_values: list[str] = []
        for param in sorted(args.keys()):
            if param in PermissionRuleEngine._PATH_SENSITIVE_PARAMS:
                val = args[param]
                if isinstance(val, str) and val:
                    path_values.append(os.path.normpath(val))

        if path_values:
            path_digest = hashlib.sha256(
                "|".join(path_values).encode()
            ).hexdigest()[:8]
            return f"{tool_name}:{sorted_keys}:{path_digest}"

        return f"{tool_name}:{sorted_keys}"

    def _check_always_memory(
        self,
        tool_name: str,
        args: Optional[Dict[str, Any]],
        state: dict,
    ) -> Optional[PermissionAction]:
        """S17(c): 检查会话级审批记忆——用户之前选择了"总是允许/拒绝此操作"。"""
        memories = state.get(self._ALWAYS_MEMORY_STATE_KEY)
        if not isinstance(memories, dict) or not memories:
            return None
        key = self._build_memory_key(tool_name, args)
        decision_str = memories.get(key)
        if decision_str in ("allow", "deny"):
            logger.debug(
                "[PermissionEngine] 审批记忆命中: %s → %s", key, decision_str,
            )
            return PermissionAction(decision_str)
        wildcard_key = f"{tool_name}:*"
        decision_str = memories.get(wildcard_key)
        if decision_str in ("allow", "deny"):
            logger.debug(
                "[PermissionEngine] 审批记忆通配命中: %s → %s", wildcard_key, decision_str,
            )
            return PermissionAction(decision_str)
        return None

    def record_always_memory(
        self,
        tool_name: str,
        args: Optional[Dict[str, Any]],
        decision: PermissionAction,
        state: dict,
    ) -> None:
        """S17(c): 记录"总是允许/拒绝此操作"的审批记忆。

        仅负责写入 ``_permission_always_memories``，后续 evaluate 优先检查。
        ``_permission_decisions`` 由调用方 ``record_decision`` 管理，此处不再重复写入。
        """
        if decision not in (PermissionAction.ALLOW, PermissionAction.DENY):
            return
        memories = dict(state.get(self._ALWAYS_MEMORY_STATE_KEY) or {})
        key = self._build_memory_key(tool_name, args)
        memories[key] = decision.value
        state[self._ALWAYS_MEMORY_STATE_KEY] = memories

        logger.info(
            "[PermissionEngine] 审批记忆写入: %s → %s", key, decision.value,
        )

    # ------------------------------------------------------------------
    # S17(b): Passthrough 解析
    # ------------------------------------------------------------------

    _PASSTHROUGH_AUTO_PRESETS = frozenset({"full_auto", "server_auto"})

    @staticmethod
    def _resolve_passthrough(state: dict) -> PermissionAction:
        """S17(b): 将 PASSTHROUGH 解析为最终动作。

        根据 state 中的授权规则推断预设行为：
        - collaborative / cautious → confirm (ASK)
        - full_auto / server_auto → allow
        """
        auth_rules = state.get("_authorization_rules")
        if isinstance(auth_rules, dict):
            # server_auto: 所有类别都是 auto
            if all(v == "auto" for v in auth_rules.values()):
                return PermissionAction.ALLOW
            # full_auto: read/write/install 是 auto, delete_system/script 是 confirm
            auto_count = sum(1 for v in auth_rules.values() if v == "auto")
            if auto_count >= 3:
                return PermissionAction.ALLOW
        # collaborative / cautious / 无规则 → 保守确认
        return PermissionAction.ASK

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    @staticmethod
    def _sync_decisions_to_contextvar(decisions: Dict[str, str]) -> None:
        """将 state 中的权限决策同步到 ContextVar，确保 BaseTool._run 层
        的 _check_authorization_rules 能立即感知新决策（双轨一致性）。"""
        try:
            from apps.services.tools.base import set_tool_permission_decisions
            set_tool_permission_decisions(decisions)
        except Exception as exc:
            logger.debug("[PermissionEngine] ContextVar 同步跳过: %s", exc)

    def _check_session_decisions(
        self, tool_name: str, state: dict
    ) -> Optional[PermissionAction]:
        """检查 session 级别 + ALWAYS 级别的决策缓存。"""
        decisions = state.get("_permission_decisions")
        if isinstance(decisions, dict):
            decision_str = decisions.get(tool_name)
            if decision_str in ("allow", "deny"):
                return PermissionAction(decision_str)

        always_decision = self._check_always_decisions(tool_name, state)
        if always_decision is not None:
            return always_decision

        return None

    def _check_always_decisions(
        self, tool_name: str, state: dict
    ) -> Optional[PermissionAction]:
        """从持久化存储加载 ALWAYS 级别决策（懒加载 + TTL 缓存）。

        缓存存储在 state["_permission_cache"] 中（per-run 隔离），
        消除多线程共享 PermissionRuleEngine 实例时的并发竞态。
        缓存按 (user_id, space_id) 隔离：身份变更时强制重新加载。

        跨 Worker 失效 (P1-7)：TTL 过期时额外从 Redis 同步 generation，
        若其他 Worker 已递增则本地 generation 更新，触发缓存刷新。
        Redis 不可用时退回进程内 TTL 机制。
        """
        current_user = str(state.get("user_id") or "")
        current_space = str(state.get("current_space_id") or "")

        perm_cache = state.get("_permission_cache")
        now = time.monotonic()

        ttl_expired = (
            perm_cache is None
            or (now - perm_cache.get("loaded_at", 0)) >= self._ALWAYS_CACHE_TTL_SECONDS
        )

        if ttl_expired:
            self._sync_redis_generation()

        cache_valid = (
            perm_cache is not None
            and perm_cache.get("user_id") == current_user
            and perm_cache.get("space_id") == current_space
            and not ttl_expired
            and perm_cache.get("generation") == PermissionRuleEngine._always_cache_generation
        )

        if not cache_valid:
            space_id = state.get("current_space_id")
            user_id = state.get("user_id")
            decisions = self._load_always_decisions(space_id, user_id)
            state["_permission_cache"] = {
                "user_id": current_user,
                "space_id": current_space,
                "decisions": decisions,
                "loaded_at": now,
                "generation": PermissionRuleEngine._always_cache_generation,
            }
            perm_cache = state["_permission_cache"]

        decision_str = perm_cache["decisions"].get(tool_name)
        if decision_str in ("allow", "deny"):
            return PermissionAction(decision_str)
        return None

    # ------------------------------------------------------------------
    # Redis generation — 跨 Worker 缓存失效 (P1-7)
    # ------------------------------------------------------------------

    @staticmethod
    def _redis_incr_generation() -> None:
        """原子递增 Redis 全局 generation 计数器（INCR 自动创建不存在的 key）。"""
        try:
            from django_redis import get_redis_connection
            conn = get_redis_connection("default")
            conn.incr(PERM_ALWAYS_GEN_KEY)
        except Exception as exc:
            logger.debug("[PermissionEngine] Redis generation INCR 失败，仅本地失效: %s", exc)

    @staticmethod
    def _redis_get_generation() -> Optional[int]:
        """读取 Redis 全局 generation 计数器。Redis 不可用时返回 None。"""
        try:
            from django_redis import get_redis_connection
            conn = get_redis_connection("default")
            val = conn.get(PERM_ALWAYS_GEN_KEY)
            return int(val) if val is not None else 0
        except Exception:
            return None

    @classmethod
    def _sync_redis_generation(cls) -> None:
        """从 Redis 同步全局 generation 到本地类变量。

        当 Redis generation 与本地不一致时，说明其他 Worker 已执行过
        invalidate_always_cache，需要更新本地 generation 以触发缓存刷新。
        Redis 不可用时静默跳过，退回进程内 TTL 机制。
        """
        redis_gen = cls._redis_get_generation()
        if redis_gen is not None and redis_gen != cls._always_cache_generation:
            logger.info(
                "[PermissionEngine] Redis generation 不一致 (local=%d, redis=%d)，同步本地",
                cls._always_cache_generation, redis_gen,
            )
            cls._always_cache_generation = redis_gen

    def invalidate_always_cache(self) -> None:
        """主动使 ALWAYS 缓存失效。

        管理员撤销 ALWAYS 决策后应调用此方法，使引擎在下次 evaluate
        时从 DB 重新加载，而不必等待 TTL 自然过期。

        递增类级别 generation 计数器 + Redis 全局 generation，
        本进程内立即失效，其他 Worker 在 TTL 过期检查时感知到
        Redis generation 变化后同步刷新。
        """
        PermissionRuleEngine._always_cache_generation += 1
        self._redis_incr_generation()
        # 保留旧清理逻辑作为兼容
        self._always_decisions_cache = None
        self._cache_loaded_at = 0.0
        self._cached_user_id = None
        self._cached_space_id = None

    def _check_tool_metadata(
        self, tool_name: str, state: dict
    ) -> Optional[PermissionAction]:
        """检查工具的 risk_level 元数据，结合授权规则评估权限。

        AC-013: _authorization_rules 检查独立于 _tool_permissions —
        即使 _tool_permissions 不存在（如子 Agent state 尚未经过
        agent_engine 注入），只要 _authorization_rules 存在就按
        fail-close 原则评估（AZ-7）。
        """
        tool_permissions = state.get("_tool_permissions")
        risk_level = None
        if isinstance(tool_permissions, dict):
            risk_level = tool_permissions.get(tool_name)

        if risk_level and risk_level in ("strict", "review"):
            return PermissionAction.ASK

        return self._check_enforced_category(tool_name)

    @staticmethod
    def _check_enforced_category(tool_name: str) -> Optional[PermissionAction]:
        """无授权规则时，通过工具类别覆盖表对高危工具强制确认（fail-safe）。"""
        from apps.services.common.authorization_policy import _TOOL_CATEGORY_OVERRIDES
        ENFORCED = frozenset({'delete_system', 'script'})
        category = _TOOL_CATEGORY_OVERRIDES.get(tool_name)
        if category in ENFORCED:
            return PermissionAction.ASK
        return None

    # ------------------------------------------------------------------
    # ALWAYS 决策持久化
    # ------------------------------------------------------------------

    _ALWAYS_MEMO_PREFIX = "permission_rule::tool::"

    @staticmethod
    def _persist_always_decision(
        tool_name: str,
        decision: "PermissionAction",
        state: dict,
    ) -> None:
        """将 ALWAYS 决策写入 Workspace 审批记忆。"""
        space_id = state.get("current_space_id")
        user_id = state.get("user_id")
        if not space_id or not user_id:
            logger.warning("[PermissionEngine] ALWAYS 持久化跳过: 缺少 space_id 或 user_id")
            return
        if decision not in (PermissionAction.ALLOW, PermissionAction.DENY):
            return
        try:
            from apps.tabtinspace.services.approval_memo_service import ApprovalMemoService
            from apps.tabtinspace.services.base import ServiceError

            service = ApprovalMemoService(user=SimpleNamespace(id=user_id))
            workspace_id = UUID(str(space_id))
            attempts = len(ALWAYS_PERSIST_RETRY_DELAYS_SECONDS) + 1
            for attempt in range(attempts):
                current = service.get_memo(workspace_id)
                try:
                    service.upsert_entry(
                        workspace_id=workspace_id,
                        entry_key=f"{PermissionRuleEngine._ALWAYS_MEMO_PREFIX}{tool_name}",
                        decision=decision.value,
                        reason="PermissionRuleEngine ALWAYS decision",
                        last_seen_generation=current.generation,
                    )
                    break
                except ServiceError as exc:
                    retryable = exc.code in {
                        "GENERATION_CONFLICT",
                        "APPROVAL_MEMO_BUSY",
                    }
                    if not retryable or attempt >= attempts - 1:
                        raise
                    time.sleep(ALWAYS_PERSIST_RETRY_DELAYS_SECONDS[attempt])
        except Exception as exc:
            logger.warning("[PermissionEngine] ALWAYS 决策持久化失败: %s", exc)

    @staticmethod
    def _load_always_decisions(
        space_id: Optional[str],
        user_id: Optional[str],
    ) -> Dict[str, str]:
        """从 Workspace 审批记忆加载当前用户的 ALWAYS 决策。"""
        if not space_id or not user_id:
            return {}
        try:
            from apps.tabtinspace.services.approval_memo_service import ApprovalMemoService

            view = ApprovalMemoService(user=SimpleNamespace(id=user_id)).get_memo(
                UUID(str(space_id))
            )
            decisions = {}
            for entry_key, entry in view.entries.items():
                if not entry_key.startswith(PermissionRuleEngine._ALWAYS_MEMO_PREFIX):
                    continue
                decision = entry.get("decision") if isinstance(entry, dict) else None
                if decision in ("allow", "deny"):
                    tool_name = entry_key[len(PermissionRuleEngine._ALWAYS_MEMO_PREFIX):]
                    if tool_name:
                        decisions[tool_name] = decision
            return decisions
        except Exception as exc:
            logger.warning("[PermissionEngine] ALWAYS 决策加载失败: %s", exc)
            return {}

    # ------------------------------------------------------------------
    # A3 升级：CliInvocationSpec 入口（PRD-v3 §5.1 第 3 项）
    # ------------------------------------------------------------------

    def evaluate_cli_spec(
        self,
        spec: "CliInvocationSpec",
        *,
        state: Optional[dict] = None,
        recent_messages: Optional[list] = None,
    ) -> "Decision":
        """评估 ``CliInvocationSpec`` 结构化 spec（A3 升级）。

        **并行模式**（按 PRD §13.2 子 Agent 自决"兼容性更好"建议）：
        与既有 ``evaluate(tool_name, args, state)`` 不冲突；本方法独立处理 spec，
        既有 tool 名打分路径一行不动。

        实现优先使用构造时注入的 ``cli_engine``（DI），缺失时 fallback 到
        ``apps.services.agent_engine.permissions.cli_engine.get_default_engine``
        singleton（避免每次构造引擎重读 ``cli_rules.yaml``，消化 A1-L7）。

        参数：
        - ``spec``            — A1 ``CliInvocationParser.parse(...)`` 输出
        - ``state``           — 可选，AI 分类器需要 ``user_id``/``organization_id`` 上下文；
                              ``thread_id`` 也用于结构化日志
        - ``recent_messages`` — 可选，AI 分类器对话上下文摘要

        返回：5 层评估后的 ``Decision``（``allow`` / ``review`` / ``deny``）。

        详见 ``cli_engine.CliPermissionEngine.evaluate_cli_spec`` docstring。
        """
        if self._cli_engine is not None:
            return self._cli_engine.evaluate_cli_spec(
                spec, state=state, recent_messages=recent_messages,
            )
        from apps.services.agent_engine.permissions.cli_engine import get_default_engine
        return get_default_engine().evaluate_cli_spec(
            spec, state=state, recent_messages=recent_messages,
        )


__all__ = ["PermissionAction", "PermissionScope", "PermissionRuleEngine"]
