"""
ApprovalMemoService — Workspace 级 always 审批记忆。

数据模型：``Workspace.approval_memo`` JSON 字段：

::

    {
        "version": 1,
        "entries": {
            "<namespace>::<tool_name>::<pattern_key>": {
                "decision": "allow" | "deny",
                "created_at": <unix_ms>,
                "updated_at": <unix_ms>,
                "approver_user_id": "<uuid>",
                "reason": "<rejection_message_or_note>"
            }
        },
        "generation": <int>
    }

并发控制（PRD §8.1.2）：
    - 客户端 PUT 必带 ``If-Match: <generation>`` header（路由层抽出）
    - 服务端用 PG 行级锁 ``select_for_update()`` 拿当前 ``Workspace`` 行
    - 比对 ``approval_memo.generation == client_last_seen``，不一致返回 409
    - 成功写入时 ``generation`` 自增（事务内）

广播（PRD §7.4 / 本期）：
    - 写入成功后 publish ``agent.action.approval_memo_updated`` 到
      organization-level + workspace-level topic
    - 客户端 ``ApprovalMemoStore`` 收到后比对本地 generation，过期则重拉

本服务只管理执行现场维度的审批记忆；Agent 身份配置不承载该数据。
"""

from __future__ import annotations

import copy
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional
from uuid import UUID

from django.db import DatabaseError, transaction

from apps.services.common.db_router import postgres_app_db_alias

from apps.services.common.agent_protocol.constants import AgentActionEvent

from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)


APPROVAL_MEMO_KEY = "approval_memo"
APPROVAL_MEMO_VERSION = 1
ENTRY_KEY_MAX_LEN = 256
REASON_MAX_LEN = 2000


def _is_row_lock_busy(exc: BaseException) -> bool:
    message = str(exc).lower()
    return (
        "could not obtain lock on row" in message
        or "lock timeout" in message
        or "nowait" in message
    )


def _raise_memo_busy(exc: BaseException) -> None:
    raise ServiceError(
        "APPROVAL_MEMO_BUSY",
        "审批记忆正在被更新，请稍后重试",
        status=409,
    ) from exc


@dataclass
class ApprovalMemoView:
    """REST API 序列化用的 dataclass。"""

    version: int
    entries: Dict[str, Dict[str, Any]]
    generation: int


def _empty_memo() -> Dict[str, Any]:
    return {
        "version": APPROVAL_MEMO_VERSION,
        "entries": {},
        "generation": 0,
    }


def _normalize_memo(raw: Any) -> Dict[str, Any]:
    """把 ``Workspace.approval_memo`` 归一化为完整 dict。

    - None / 非 dict / 缺字段 → 用空骨架填齐
    - generation 非 int → 重置为 0
    - entries 非 dict → 重置为 {}
    """
    if not isinstance(raw, dict):
        return _empty_memo()
    version = raw.get("version") if isinstance(raw.get("version"), int) else APPROVAL_MEMO_VERSION
    entries = raw.get("entries") if isinstance(raw.get("entries"), dict) else {}
    generation = raw.get("generation") if isinstance(raw.get("generation"), int) else 0
    return {
        "version": version,
        "entries": dict(entries),
        "generation": generation,
    }


class ApprovalMemoService(BaseService):
    """Workspace 级 always memo CRUD 服务。"""

    REQUIRED_ROLE = "editor"

    # ------------------------------------------------------------------
    # 读
    # ------------------------------------------------------------------

    def get_memo(self, workspace_id: UUID) -> ApprovalMemoView:
        """Bootstrap 全量读 + 客户端 RBAC 校验。

        权限：Workspace 创建者才能读取审批记忆。
        """
        from apps.tabtinspace.models import Workspace

        workspace = Workspace.objects.filter(id=workspace_id).first()
        if not workspace:
            raise ServiceError("WORKSPACE_NOT_FOUND", "Workspace 不存在", status=404)

        if str(workspace.created_by_id) != str(self.user.id):
            raise ServiceError(
                "PERMISSION_DENIED",
                "无权访问该 Workspace 的审批记忆",
                status=403,
            )

        memo = _normalize_memo(workspace.approval_memo)
        return ApprovalMemoView(
            version=memo["version"],
            entries=memo["entries"],
            generation=memo["generation"],
        )

    # ------------------------------------------------------------------
    # 写：单条 upsert（editor 及以上 + optimistic lock）
    # ------------------------------------------------------------------

    def upsert_entry(
        self,
        workspace_id: UUID,
        entry_key: str,
        decision: str,
        reason: str,
        last_seen_generation: int,
        scope_description: str = "",
    ) -> ApprovalMemoView:
        """单条 upsert + PG 行级锁 + generation 自增。

        失败语义：
            - 404 ServiceError("WORKSPACE_NOT_FOUND")
            - 403 ServiceError("PERMISSION_DENIED")
            - 400 ServiceError("INVALID_*")
            - 409 ServiceError("GENERATION_CONFLICT", data={"current_generation": N})
              客户端按 current_generation 重拉 memo + 重提交
        """
        self._validate_entry_key(entry_key)
        self._validate_decision(decision)
        self._validate_reason(reason)

        from apps.tabtinspace.models import Workspace

        # 先做无锁的存在性 + RBAC 校验（fast-fail）
        workspace_meta = Workspace.objects.filter(id=workspace_id).only(
            "organization_id",
            "created_by_id",
        ).first()
        if not workspace_meta:
            raise ServiceError("WORKSPACE_NOT_FOUND", "Workspace 不存在", status=404)

        if str(workspace_meta.created_by_id) != str(self.user.id):
            raise ServiceError(
                "PERMISSION_DENIED",
                "仅 Workspace 归属用户可修改审批记忆",
                status=403,
            )

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                # PG row-level lock：保证 generation 比对 + 自增是原子的。
                # nowait 避免一个卡住的审批记忆请求把 Daphne 线程池拖成锁队列。
                workspace = (
                    Workspace.objects.using(postgres_app_db_alias())
                    .select_for_update(nowait=True)
                    .get(id=workspace_id)
                )
                memo = _normalize_memo(workspace.approval_memo)

                current_gen = memo["generation"]
                if last_seen_generation != current_gen:
                    raise ServiceError(
                        "GENERATION_CONFLICT",
                        "approval_memo generation conflict",
                        status=409,
                        data={"current_generation": current_gen},
                    )

                now_ms = int(time.time() * 1000)
                existing = memo["entries"].get(entry_key)
                new_entry = {
                    "decision": decision,
                    "updated_at": now_ms,
                    "approver_user_id": str(self.user.id) if self.user else "",
                    "reason": reason,
                    # M4.1 L-W6-24：存储业务名；缺失时写空字符串（兼容旧条目）
                    "scope_description": scope_description or "",
                }
                if existing and isinstance(existing, dict):
                    # 保留原 created_at（产品语义：updated_at 才是当前修改时间）
                    new_entry["created_at"] = existing.get("created_at", now_ms)
                else:
                    new_entry["created_at"] = now_ms

                memo["entries"][entry_key] = new_entry
                memo["generation"] = current_gen + 1
                memo["version"] = APPROVAL_MEMO_VERSION

                workspace.approval_memo = memo
                workspace.save(update_fields=["approval_memo", "updated_at"])
        except DatabaseError as exc:
            if _is_row_lock_busy(exc):
                logger.warning("[ApprovalMemoService] row lock busy on upsert workspace=%s key=%s", workspace_id, entry_key)
                _raise_memo_busy(exc)
            raise

        self._broadcast_updated(workspace_id, str(workspace_meta.organization_id), memo["generation"])

        logger.info(
            "[ApprovalMemoService] upsert workspace=%s key=%s decision=%s gen=%d",
            workspace_id, entry_key, decision, memo["generation"],
        )
        return ApprovalMemoView(
            version=memo["version"],
            entries=memo["entries"],
            generation=memo["generation"],
        )

    # ------------------------------------------------------------------
    # 写：单条删除（editor 及以上 + optimistic lock）
    # ------------------------------------------------------------------

    def delete_entry(
        self,
        workspace_id: UUID,
        entry_key: str,
        last_seen_generation: int,
    ) -> ApprovalMemoView:
        self._validate_entry_key(entry_key)

        from apps.tabtinspace.models import Workspace

        workspace_meta = Workspace.objects.filter(id=workspace_id).only(
            "organization_id",
            "created_by_id",
        ).first()
        if not workspace_meta:
            raise ServiceError("WORKSPACE_NOT_FOUND", "Workspace 不存在", status=404)

        if str(workspace_meta.created_by_id) != str(self.user.id):
            raise ServiceError(
                "PERMISSION_DENIED",
                "仅 Workspace 归属用户可修改审批记忆",
                status=403,
            )

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                workspace = (
                    Workspace.objects.using(postgres_app_db_alias())
                    .select_for_update(nowait=True)
                    .get(id=workspace_id)
                )
                memo = _normalize_memo(workspace.approval_memo)

                current_gen = memo["generation"]
                if last_seen_generation != current_gen:
                    raise ServiceError(
                        "GENERATION_CONFLICT",
                        "approval_memo generation conflict",
                        status=409,
                        data={"current_generation": current_gen},
                    )

                if entry_key not in memo["entries"]:
                    # 幂等：已不存在视为删成功，不递增 generation 避免空 churn
                    return ApprovalMemoView(
                        version=memo["version"],
                        entries=memo["entries"],
                        generation=memo["generation"],
                    )

                memo["entries"].pop(entry_key, None)
                memo["generation"] = current_gen + 1
                memo["version"] = APPROVAL_MEMO_VERSION

                workspace.approval_memo = memo
                workspace.save(update_fields=["approval_memo", "updated_at"])
        except DatabaseError as exc:
            if _is_row_lock_busy(exc):
                logger.warning("[ApprovalMemoService] row lock busy on delete workspace=%s key=%s", workspace_id, entry_key)
                _raise_memo_busy(exc)
            raise

        self._broadcast_updated(workspace_id, str(workspace_meta.organization_id), memo["generation"])

        logger.info(
            "[ApprovalMemoService] delete workspace=%s key=%s gen=%d",
            workspace_id, entry_key, memo["generation"],
        )
        return ApprovalMemoView(
            version=memo["version"],
            entries=memo["entries"],
            generation=memo["generation"],
        )

    # ------------------------------------------------------------------
    # 写：清空所有 always memo（Skill 升级后用户撤销 Agent 内全部）
    # ------------------------------------------------------------------

    def revoke_all(self, workspace_id: UUID) -> ApprovalMemoView:
        from apps.tabtinspace.models import Workspace

        workspace_meta = Workspace.objects.filter(id=workspace_id).only(
            "organization_id",
            "created_by_id",
        ).first()
        if not workspace_meta:
            raise ServiceError("WORKSPACE_NOT_FOUND", "Workspace 不存在", status=404)

        if str(workspace_meta.created_by_id) != str(self.user.id):
            raise ServiceError(
                "PERMISSION_DENIED",
                "仅 Workspace 归属用户可修改审批记忆",
                status=403,
            )

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                workspace = (
                    Workspace.objects.using(postgres_app_db_alias())
                    .select_for_update(nowait=True)
                    .get(id=workspace_id)
                )
                memo = _normalize_memo(workspace.approval_memo)

                had_entries = bool(memo["entries"])
                memo["entries"] = {}
                # 即使空也递增（让客户端缓存全量失效）
                memo["generation"] = memo["generation"] + 1
                memo["version"] = APPROVAL_MEMO_VERSION

                workspace.approval_memo = memo
                workspace.save(update_fields=["approval_memo", "updated_at"])
        except DatabaseError as exc:
            if _is_row_lock_busy(exc):
                logger.warning("[ApprovalMemoService] row lock busy on revoke_all workspace=%s", workspace_id)
                _raise_memo_busy(exc)
            raise

        self._broadcast_updated(workspace_id, str(workspace_meta.organization_id), memo["generation"])

        logger.info(
            "[ApprovalMemoService] revoke_all workspace=%s prev_had_entries=%s gen=%d",
            workspace_id, had_entries, memo["generation"],
        )
        return ApprovalMemoView(
            version=memo["version"],
            entries=memo["entries"],
            generation=memo["generation"],
        )

    # ------------------------------------------------------------------
    # 内部：广播 + 校验
    # ------------------------------------------------------------------

    @staticmethod
    def _broadcast_updated(workspace_id: UUID, organization_id: str, generation: int) -> None:
        """publish ``agent.action.approval_memo_updated`` 到 organization + workspace topic。

        客户端 ApprovalMemoStore 收到后比对本地 generation，过期则重拉 memo 全量。
        失败容错：广播失败不影响主路径写入；客户端 5min 后下一次 bootstrap 会自然修正。
        """
        try:
            from apps.services.common.ws.bus import publish_ws_event
            from apps.services.common.ws.protocol import build_envelope, new_event_id

            payload = {
                "workspace_id": str(workspace_id),
                "generation": generation,
            }
            envelope = build_envelope(
                AgentActionEvent.APPROVAL_MEMO_UPDATED,
                new_event_id(),
                payload,
                thread_id=None,
                organization_id=organization_id,
            )
            # organization-level（editor 及以上在任意 thread 改 memo 都能让所有客户端感知）
            publish_ws_event(f"organization.{organization_id}", envelope)
            publish_ws_event(f"workspace.{workspace_id}", envelope)
        except Exception:
            logger.warning(
                "[ApprovalMemoService] broadcast approval_memo_updated 失败 workspace=%s gen=%d",
                workspace_id, generation, exc_info=True,
            )

    @staticmethod
    def _validate_entry_key(entry_key: str) -> None:
        if not isinstance(entry_key, str) or not entry_key.strip():
            raise ServiceError(
                "INVALID_ENTRY_KEY",
                "entry_key 不能为空",
                status=400,
            )
        if len(entry_key) > ENTRY_KEY_MAX_LEN:
            raise ServiceError(
                "INVALID_ENTRY_KEY",
                f"entry_key 长度超过 {ENTRY_KEY_MAX_LEN}",
                status=400,
            )
        # 可选：校验 PRD §6.5 的 "<namespace>::<tool_name>::<pattern_key>" 格式
        # 当前不强校验——客户端 Layer 4 buildApprovalKey 是 SSoT，服务端只存 key

    @staticmethod
    def _validate_decision(decision: str) -> None:
        if decision not in ("allow", "deny"):
            raise ServiceError(
                "INVALID_DECISION",
                "decision 只能是 'allow' 或 'deny'",
                status=400,
            )

    @staticmethod
    def _validate_reason(reason: str) -> None:
        if not isinstance(reason, str):
            raise ServiceError("INVALID_REASON", "reason 必须是字符串", status=400)
        if len(reason) > REASON_MAX_LEN:
            raise ServiceError(
                "INVALID_REASON",
                f"reason 长度超过 {REASON_MAX_LEN}",
                status=400,
            )


__all__ = [
    "APPROVAL_MEMO_KEY",
    "APPROVAL_MEMO_VERSION",
    "ApprovalMemoService",
    "ApprovalMemoView",
]
