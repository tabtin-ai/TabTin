"""
SubagentRegistry - 子 Agent 运行记录注册表（Postgres + Redis）

W5 cleanup (2026-05-26, 子 Agent 模块完善总控)：W10 之后子 Agent 执行已
全部下沉到 ``@tabtin/agent-runtime`` 客户端 runtime，云端 spawn 路径不再
存在。该文件保留的角色是 **read + cancel + lifecycle cleanup 路径**——
被 ``apps.users.auth.admin_api._cancel_active_agent_runs`` 调用以在用户
禁用时取消该用户的活跃 SubtaskRun，以及 collab 级联回滚的 read 路径。

本 wave 同步删除了已 0 调用的 spawn-side method（``register`` /
``spawn_lock`` / ``wait_for_result``）及其专属常量和 helper。如果未来恢复
云端 spawn / 等待机制（PRD 06 §三远期），重新加回即可（保留的 store_result
/ Redis 队列字段已与 lifecycle 解耦）。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Optional, Iterable

from django.utils import timezone
from django.db import transaction

from apps.services.common.agent_protocol.namespace import redis_key
from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

logger = logging.getLogger(__name__)

CANCEL_FLAG_TTL = 10 * 60  # 10 minutes
TERMINAL_STATUSES = {"completed", "error", "failed", "timeout", "cancelled", "archived"}
BLOCKING_STATUSES = {"timeout", "cancelled"}
_VALID_TRANSITIONS = {
    "pending": {"running", "queued", "cancelled", "timeout", "error"},
    "queued": {"pending", "running", "cancelled", "timeout", "error"},
    "running": {"completed", "error", "failed", "timeout", "cancelled", "pending"},
    "completed": {"archived", "pending"},
    "error": {"archived", "pending"},
    "failed": {"archived"},
    "timeout": {"archived"},
    "cancelled": {"archived"},
    "archived": set(),
}


class SubagentRegistry:
    """
    子 Agent 注册表（Postgres 为权威，Redis 用于结果队列）
    """

    def __init__(self):
        self._redis = get_frontend_action_service().redis_client
        self._model = self._resolve_model()

    @staticmethod
    def _resolve_model():
        from apps.services.agent_engine.models import SubtaskRun
        return SubtaskRun

    @staticmethod
    def _result_key(run_id: str) -> str:
        return redis_key(["subagent", f"{{{run_id}}}", "result"])

    @staticmethod
    def _cancel_key(run_id: str) -> str:
        return redis_key(["subagent", f"{{{run_id}}}", "cancel"])

    def _to_datetime(self, value: Optional[float]) -> Optional[timezone.datetime]:
        if value is None:
            return None
        try:
            return timezone.datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None

    def _serialize_run(self, run) -> Dict[str, Any]:
        rid = str(run.subagent_run_id)
        return {
            "subagent_run_id": rid,
            "parent_thread_id": run.parent_thread_id,
            "child_thread_id": run.child_thread_id,
            "parent_agent_name": run.parent_agent_name,
            "parent_agent_type": run.parent_agent_type,
            "agent_name": run.agent_name,
            "agent_type": run.agent_type,
            "subagent_type": run.subagent_type,
            "app_id": run.app_id,
            "mode": run.mode,
            "cleanup": run.cleanup,
            "status": run.status,
            "task": run.task,
            "label": run.label,
            "user_id": run.user_id,
            "organization_id": run.organization_id,
            "session_id": run.session_id,
            "current_space_id": run.current_space_id,
            "current_table_id": run.current_table_id,
            "model_id": run.model_id,
            "thinking_level": run.thinking_level,
            "run_timeout_seconds": run.run_timeout_seconds,
            "tool_domains": run.tool_domains or [],
            "action_app_ids": run.action_app_ids or [],
            "allowed_tools": run.allowed_tools or [],
            "input_state": run.input_state or {},
            "system_prompt": run.system_prompt,
            "result_summary": run.result_summary,
            "error": run.error,
            "stats_json": run.stats_json or {},
            "requester_origin_json": run.requester_origin_json or {},
            "metadata": run.metadata or {},
            "initiator_speaker_id": run.initiator_speaker_id,
            "template_version": run.template_version,
            "notified_at": run.notified_at.timestamp() if run.notified_at else None,
            "notification_retry_count": run.notification_retry_count,
            "created_at": run.created_at.timestamp() if run.created_at else None,
            "started_at": run.started_at.timestamp() if run.started_at else None,
            "ended_at": run.ended_at.timestamp() if run.ended_at else None,
            "archive_at": run.archive_at.timestamp() if run.archive_at else None,
        }

    def is_blocked(self, run_id: str) -> str:
        """检查子任务是否已被阻断（timeout/cancelled）。

        P0-6 修复：store_result 前调用，避免竞态窗口内成功结果覆盖 timeout 结果。

        Returns:
            阻断状态字符串（如 "timeout"/"cancelled"），未阻断则返回空字符串。
        """
        record = self.get_record(run_id)
        if not record:
            return ""
        status = (record.get("status") or "").lower()
        if status in BLOCKING_STATUSES:
            return status
        if self.is_cancelled(run_id):
            return "cancelled"
        return ""

    def get_record(self, run_id: str) -> Optional[Dict[str, Any]]:
        run = self._model.objects.filter(subagent_run_id=run_id).first()
        if not run:
            return None
        return self._serialize_run(run)

    def update_status(
        self,
        run_id: str,
        *,
        status: str,
        error: Optional[str] = None,
        started_at: Optional[float] = None,
        ended_at: Optional[float] = None,
        result_summary: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        stats_json: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """更新子 Agent 状态，遵循状态机转换规则。

        使用 select_for_update 保证并发路径（超时回调 vs 正常完成）
        对同一 run_id 的状态转换互斥，最终状态确定。

        Returns:
            True 如果更新成功，False 如果被状态机拒绝。
        """
        with transaction.atomic(using="postgresql"):
            run = (
                self._model.objects
                .select_for_update()
                .filter(subagent_run_id=run_id)
                .only("status")
                .first()
            )
            if not run:
                return False
            current_status = (run.status or "").lower()
            next_status = (status or "").lower()

            allowed = _VALID_TRANSITIONS.get(current_status, set())
            if next_status and next_status != current_status and next_status not in allowed:
                logger.info(
                    "[SubagentRegistry] State transition rejected: run_id=%s %s -> %s (allowed: %s)",
                    run_id, current_status, next_status, allowed,
                )
                return False

            updates: Dict[str, Any] = {"status": status, "updated_at": timezone.now()}
            if error:
                updates["error"] = error
            if started_at:
                updates["started_at"] = self._to_datetime(started_at)
            if ended_at:
                updates["ended_at"] = self._to_datetime(ended_at)
            if result_summary:
                updates["result_summary"] = result_summary
            if metadata:
                updates["metadata"] = metadata
            if stats_json:
                updates["stats_json"] = stats_json
            self._model.objects.filter(subagent_run_id=run_id).update(**updates)
            return True

    @staticmethod
    def _result_once_key(run_id: str) -> str:
        return redis_key(["subagent", f"{{{run_id}}}", "result_once"])

    _STORE_RESULT_LUA = """
local ok = redis.call("SET", KEYS[1], "1", "NX", "EX", ARGV[1])
if not ok then return 0 end
redis.call("LPUSH", KEYS[2], ARGV[2])
redis.call("EXPIRE", KEYS[2], ARGV[1])
return 1
"""
    _store_result_script = None

    def _get_store_result_script(self):
        if SubagentRegistry._store_result_script is None:
            SubagentRegistry._store_result_script = self._redis.register_script(
                self._STORE_RESULT_LUA
            )
        return SubagentRegistry._store_result_script

    def store_result(self, run_id: str, result: Dict[str, Any], ttl: Optional[int] = None) -> bool:
        """写入结果到 Redis 队列。使用 Lua 脚本原子执行 SETNX + LPUSH + EXPIRE。

        Hash Tag {run_id} 确保 once_key 和 result_key 路由到同一 Redis Cluster 节点，
        Lua 脚本保证三步操作的原子性，Failover 后不会出现部分写入。

        Returns:
            True 如果成功写入，False 如果已有结果（被另一线程抢先写入）。
        """
        from apps.services.agent_engine.configuration import OrchestrationConfiguration

        _cfg = OrchestrationConfiguration.from_settings()
        if ttl is None:
            ttl = _cfg.subagent_result_ttl

        once_key = self._result_once_key(run_id)
        result_key = self._result_key(run_id)
        payload = json.dumps(result, ensure_ascii=False)
        try:
            script = self._get_store_result_script()
            written = script(keys=[once_key, result_key], args=[ttl, payload])
        except Exception:
            logger.warning(
                "[SubagentRegistry] store_result Lua 脚本执行失败，将重试: run_id=%s",
                run_id,
                exc_info=True,
            )
            SubagentRegistry._store_result_script = None
            script = self._get_store_result_script()
            written = script(keys=[once_key, result_key], args=[ttl, payload])
        if not written:
            logger.info("[SubagentRegistry] Result already exists (skipping duplicate write): run_id=%s", run_id)
            return False
        return True

    def _cleanup_redis_keys(self, run_id: str) -> None:
        """统一清理某个 run_id 关联的所有 Redis key（仅 delete_run 使用）。"""
        keys = [
            self._result_key(run_id),
            self._result_once_key(run_id),
            self._cancel_key(run_id),
        ]
        try:
            self._redis.delete(*keys)
        except Exception:
            logger.warning(
                "[SubagentRegistry] _cleanup_redis_keys partial failure: run_id=%s",
                run_id, exc_info=True,
            )

    def delete_run(self, run_id: str) -> None:
        self._model.objects.filter(subagent_run_id=run_id).delete()
        self._cleanup_redis_keys(run_id)

    def archive_run(
        self,
        run_id: str,
        archive_at: Optional[timezone.datetime] = None,
        status: Optional[str] = "archived",
    ) -> bool:
        """归档子 Agent 运行记录。

        S2-045: select_for_update 保证并发互斥；幂等处理已归档记录；
        不清除 result_once_key（靠 TTL 过期），防止与 store_result SETNX 时序竞争。

        Returns:
            True 归档成功或已归档，False 记录不存在。
        """
        with transaction.atomic(using="postgresql"):
            run = (
                self._model.objects
                .select_for_update()
                .filter(subagent_run_id=run_id)
                .only("status", "archive_at")
                .first()
            )
            if not run:
                return False

            current_status = (run.status or "").lower()

            if current_status == "archived" and run.archive_at is not None:
                return True

            next_status = status
            allowed = _VALID_TRANSITIONS.get(current_status, set())
            if next_status and next_status.lower() not in allowed and next_status.lower() != current_status:
                next_status = current_status

            updates: Dict[str, Any] = {
                "updated_at": timezone.now(),
            }
            if archive_at is not None:
                updates["archive_at"] = archive_at
            if next_status:
                updates["status"] = next_status

            self._model.objects.filter(subagent_run_id=run_id).update(**updates)

        try:
            self._redis.delete(self._cancel_key(run_id))
        except Exception:
            logger.warning(
                "[SubagentRegistry] archive_run: cancel_key cleanup failed: run_id=%s",
                run_id, exc_info=True,
            )

        return True

    def count_active(
        self,
        parent_thread_id: Optional[str] = None,
        *,
        include_queued: bool = True,
    ) -> int:
        """统计活跃子任务数。

        include_queued=True（默认）：含 queued 状态，用于 spawn 路径的并发上限检查，
        避免低估已提交但未开始的任务数导致超额创建（P1-07 修复）。

        include_queued=False：仅 pending+running，用于 dispatch 路径判断可用执行槽位，
        避免将 queued 计入导致队列任务永远无法被调度。
        """
        statuses = ["pending", "running"]
        if include_queued:
            statuses.append("queued")
        query = self._model.objects.filter(status__in=statuses)
        if parent_thread_id:
            query = query.filter(parent_thread_id=parent_thread_id)
        return int(query.count())

    def count_queued(self, parent_thread_id: Optional[str] = None) -> int:
        query = self._model.objects.filter(status="queued")
        if parent_thread_id:
            query = query.filter(parent_thread_id=parent_thread_id)
        return int(query.count())

    def list_queued(
        self,
        *,
        parent_thread_id: Optional[str] = None,
        limit: int = 100,
    ) -> Iterable[Dict[str, Any]]:
        query = self._model.objects.filter(status="queued")
        if parent_thread_id:
            query = query.filter(parent_thread_id=parent_thread_id)
        items = query.order_by("created_at").values("subagent_run_id", "parent_thread_id", "created_at")[:limit]
        return [{"subagent_run_id": str(i["subagent_run_id"]), **{k: v for k, v in i.items() if k != "subagent_run_id"}} for i in items]

    def reserve_queued_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        with transaction.atomic(using="postgresql"):
            run = (
                self._model.objects.select_for_update(skip_locked=True)
                .filter(subagent_run_id=run_id, status="queued")
                .first()
            )
            if not run:
                return None
            metadata = run.metadata or {}
            metadata["queue_state"] = "dequeued"
            metadata["dequeued_at"] = timezone.now().isoformat()
            self._model.objects.filter(subagent_run_id=run_id).update(
                status="pending",
                metadata=metadata,
                updated_at=timezone.now(),
            )
            run.status = "pending"
            run.metadata = metadata
            return self._serialize_run(run)

    def mark_timeout(
        self,
        run_id: str,
        *,
        error: str = "timeout",
        ended_at: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """标记子任务超时。返回 True 表示成功，False 表示被其他终态抢先。"""
        return self.update_status(
            run_id,
            status="timeout",
            error=error,
            ended_at=ended_at,
            metadata=metadata,
        )

    def list_recoverable(self, stale_before: timezone.datetime) -> Iterable[Dict[str, Any]]:
        runs = self._model.objects.filter(status__in=["pending", "running"], updated_at__lt=stale_before)
        for run in runs:
            yield self._serialize_run(run)

    def list_expired(self, now: timezone.datetime) -> Iterable[Dict[str, Any]]:
        runs = self._model.objects.filter(archive_at__isnull=False, archive_at__lte=now)
        for run in runs:
            yield self._serialize_run(run)

    # ------------------------------------------------------------------
    # Cancel support
    # ------------------------------------------------------------------

    def cancel(self, run_id: str) -> bool:
        """设置取消标记。子 Agent 的 SubagentCancelCheckMiddleware 会在每次迭代前检测。

        三步跨存储操作各自独立 try/except，确保任一存储故障不阻断后续步骤：
        ① Redis cancel flag → ② PG status → ③ Redis result（解除父 Agent brpop 阻塞）
        """
        key = self._cancel_key(run_id)
        self._redis.set(key, "1", ex=CANCEL_FLAG_TTL)

        pg_ok = False
        try:
            pg_ok = self.update_status(run_id, status="cancelled", ended_at=time.time())
        except Exception as exc:
            logger.error(
                "[SubagentRegistry] cancel: PG update failed, extending cancel flag TTL: "
                "run_id=%s error=%s",
                run_id, exc,
            )
            try:
                self._redis.expire(key, CANCEL_FLAG_TTL * 4)
            except Exception:
                logger.warning(
                    "[SubagentRegistry] Redis expire 延长取消标记 TTL 失败: run_id=%s",
                    run_id,
                    exc_info=True,
                )

        try:
            self.store_result(run_id, {"success": False, "status": "cancelled", "error": "cancelled_by_user"})
        except Exception as exc:
            logger.error(
                "[SubagentRegistry] cancel: store_result failed: run_id=%s error=%s",
                run_id, exc,
            )

        logger.info("[SubagentRegistry] Cancelling subagent: run_id=%s pg_ok=%s", run_id, pg_ok)
        return pg_ok

    def set_cancel_flag(self, run_id: str) -> None:
        """仅设置 Redis 取消标记（不改变状态），用于超时后中断执行线程。"""
        key = self._cancel_key(run_id)
        self._redis.set(key, "1", ex=CANCEL_FLAG_TTL)

    def is_cancelled(self, run_id: str) -> bool:
        """检查子 Agent 是否已被取消（O(1) Redis 查询）。"""
        key = self._cancel_key(run_id)
        return bool(self._redis.exists(key))

    def clear_cancel_flag(self, run_id: str) -> None:
        """清除取消标记（新执行开始时调用，避免继承旧执行的取消信号）。"""
        try:
            self._redis.delete(self._cancel_key(run_id))
        except Exception:
            pass  # defensive: Redis 删除取消标记失败，不影响新任务启动主路径


__all__ = ["SubagentRegistry"]
