"""
ConversationStore - 对话状态持久化服务

提供：
- save_state / load_state：对话消息和状态的持久化
- save_interrupt / load_and_clear_interrupt：HITL 中断状态管理（原子操作）
- 乐观锁防止并发写入冲突
"""

from __future__ import annotations

import dataclasses
import datetime
import json as _json
import logging
import time
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from django.db import DatabaseError, IntegrityError, transaction

logger = logging.getLogger(__name__)


def _sanitize_for_json(obj: Any) -> Any:
    """递归清洗不可 JSON 序列化的类型，防止 psycopg2 写入 JSONField 时报错。

    转换规则：
    - Decimal → str（保留精度，避免 float 二进制舍入）
    - datetime/date → ISO 8601 字符串
    - UUID → str
    - bytes → UTF-8 解码
    - set → 排序后的 list
    - dataclass → dict（通过 dataclasses.asdict 再递归清洗）
    - 其余未识别类型 → str(obj)
    """
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, set):
        return [_sanitize_for_json(v) for v in sorted(obj, key=str)]
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _sanitize_for_json(dataclasses.asdict(obj))
    return str(obj)

_MESSAGES_SIZE_WARN_BYTES = 2 * 1024 * 1024    # 2 MB
_MESSAGES_SIZE_HARD_LIMIT_BYTES = 8 * 1024 * 1024  # 8 MB
_TRUNCATION_TARGET_BYTES = int(_MESSAGES_SIZE_HARD_LIMIT_BYTES * 0.8)  # 6.4 MB

_TRUNCATION_MARKER = {
    "role": "system",
    "content": (
        "[之前的对话内容较长，已自动精简以保持流畅。"
        "如需回顾早期内容，请使用 memory_search 工具或 read_file 直接读取本地 jsonl"
        "（platform-data/.../conversations/sessions/{id}/messages.jsonl）。]\n"
        "（Agent 注意：前序对话已由系统自动摘要压缩，"
        "如需详细上下文请使用 memory_search 工具）"
    ),
}

FALLBACK_KEY_PREFIX = "state:fallback:"
FALLBACK_TTL_SECONDS = 86400  # 24h


def _get_fallback_redis():
    from django_redis import get_redis_connection
    return get_redis_connection("default")


def _estimate_messages_bytes(messages_json: list) -> int:
    """估算 messages 序列化后的字节数（UTF-8 JSON）。"""
    try:
        return len(
            _json.dumps(messages_json, ensure_ascii=False, separators=(",", ":"))
            .encode("utf-8")
        )
    except (TypeError, ValueError, OverflowError):
        return 0

def _repair_orphan_tool_calls(tail: list) -> None:
    """修复截断后可能断裂的 tool_call <-> tool_result 配对。

    两种断裂模式：
    1. assistant 有 tool_calls 但对应的 tool result 被截掉 → 补占位 tool result
    2. tool result 在 tail 中但对应的 assistant tool_calls 被截掉 → 删除孤立 tool result
    """
    expected_ids: set = set()
    provided_ids: set = set()

    for msg in tail:
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls", []):
                tc_id = tc.get("id", "")
                if tc_id:
                    expected_ids.add(tc_id)
        elif msg.get("role") == "tool":
            tc_id = msg.get("tool_call_id", "")
            if tc_id:
                provided_ids.add(tc_id)

    missing = expected_ids - provided_ids
    for tc_id in missing:
        tail.append({
            "role": "tool",
            "tool_call_id": tc_id,
            "content": '{"status":"truncated","note":"Result removed during context compression"}',
        })

    orphan = provided_ids - expected_ids
    if orphan:
        tail[:] = [
            m for m in tail
            if not (m.get("role") == "tool" and m.get("tool_call_id") in orphan)
        ]


def _emergency_truncate_and_repair(
    messages: list,
    target_bytes: int = _TRUNCATION_TARGET_BYTES,
) -> list:
    """紧急截断：保留 head(system) + 按字节预算从尾部保留 + 修复消息链。

    在事务外执行，不含 LLM 调用。仅当 messages 超过 HARD_LIMIT 时由 save_state 调用。
    """
    if not messages or len(messages) <= 10:
        return messages

    head = [m for m in messages[:5] if m.get("role") == "system"]

    head_bytes = _estimate_messages_bytes(head)
    budget = target_bytes - head_bytes - 500

    tail: list = []
    i = len(messages) - 1
    while i >= len(head) and budget > 0:
        msg = messages[i]
        msg_size = _estimate_messages_bytes([msg])
        if msg_size > budget:
            break
        tail.insert(0, msg)
        budget -= msg_size
        i -= 1

    _repair_orphan_tool_calls(tail)

    return head + [dict(_TRUNCATION_MARKER)] + tail


def _check_and_truncate_if_needed(messages_json: list, thread_id: str) -> list:
    """检查 messages 体积，超限时截断。供所有写入路径共用。"""
    msg_bytes = _estimate_messages_bytes(messages_json)
    if msg_bytes <= _MESSAGES_SIZE_HARD_LIMIT_BYTES:
        return messages_json
    try:
        truncated = _emergency_truncate_and_repair(messages_json)
        logger.warning(
            "[ConversationStore] Emergency truncation applied: "
            "thread=%s original_bytes=%d new_bytes=%d limit=%d",
            thread_id,
            msg_bytes,
            _estimate_messages_bytes(truncated),
            _MESSAGES_SIZE_HARD_LIMIT_BYTES,
        )
        return truncated
    except Exception:
        logger.error(
            "[ConversationStore] Emergency truncation failed, "
            "falling back to original messages (log-only)",
            exc_info=True,
        )
        return messages_json


# state_json 中排除的字段 — 由 State Key Registry 声明式管理
# 所有 persist=False 的 key 自动生成此集合，详见 state/key_registry.py
from apps.services.agent_engine.state.key_registry import excluded_keys as _get_excluded_keys

_EXCLUDED_STATE_KEYS: frozenset[str] = _get_excluded_keys()


class ConversationStore:
    """
    对话状态持久化服务。

    使用 Django ORM 操作 ConversationState model。
    所有方法均为同步（NativeReactLoop 在同步线程中运行）。
    """

    @staticmethod
    def save_state(thread_id: str, state: dict) -> None:
        """
        保存完整对话状态（消息 + 非消息字段）。

        使用 select_for_update 防止并发写入互相覆盖。

        Args:
            thread_id: 对话线程 ID
            state: NativeReactLoop 的完整 state dict
        """
        from apps.services.agent_engine.models import ConversationState

        messages = state.get("messages", [])
        messages_json = _sanitize_for_json(_serialize_messages(messages))
        messages_json = _check_and_truncate_if_needed(messages_json, thread_id)

        state_json = _sanitize_for_json({
            k: v for k, v in state.items()
            if k not in _EXCLUDED_STATE_KEYS
        })

        try:
            obj = ConversationStore._upsert_state(
                thread_id, messages_json, state_json,
                extra_fields={},
            )
            logger.debug(
                "[ConversationStore] save_state: thread=%s msgs=%d version=%d",
                thread_id, len(messages_json), obj.version,
            )
        except Exception as exc:
            logger.error("[ConversationStore] save_state failed: %s", exc, exc_info=True)
            raise

    @staticmethod
    def load_state(
        thread_id: str,
        *,
        expected_user_id: Optional[str] = None,
    ) -> Optional[dict]:
        """
        加载对话状态。

        Args:
            thread_id: 对话线程 ID
            expected_user_id: 可选，期望的用户 ID。提供时会校验 state 中的
                user_id 或关联 ChatSession 的 user_id 是否匹配，
                不匹配时返回 None。

        Returns:
            state dict（包含 messages、_version 和其他字段），不存在时返回 None。
            _version 用于乐观锁 CAS 写入。
        """
        from apps.services.agent_engine.models import ConversationState

        try:
            obj = ConversationState.objects.filter(thread_id=thread_id).first()
            if not obj:
                fallback_state = ConversationStore._load_fallback_from_redis(thread_id)
                if fallback_state is not None:
                    if expected_user_id is not None:
                        if not ConversationStore._check_thread_user(
                            thread_id, fallback_state, expected_user_id,
                        ):
                            return None
                    return fallback_state
                return None

            if expected_user_id is not None:
                if not ConversationStore._check_thread_user(
                    thread_id, obj.state_json, expected_user_id,
                ):
                    return None

            state = dict(obj.state_json or {})
            raw_messages = obj.messages_json or []
            messages = validate_messages(raw_messages, thread_id)

            from apps.services.agent_execution.context_assembler import (
                repair_incomplete_tool_calls,
                sanitize_historical_tool_names,
            )
            messages = repair_incomplete_tool_calls(messages)
            # dogfood P0 修复 2026-04-30：旧 session 历史里可能含点号工具名
            # （`tabdoc.create_document` / `plan.exit` 等），跨轮装填回 LLM
            # 上游会因 `^[a-zA-Z0-9_-]{1,64}$` 正则被 400 reject。装载即净化，
            # 确保旧 session 重启后能平滑续聊。与本地 Runtime 的
            # `sanitizeHistoricalToolName`（select-recent-history.ts）对称。
            messages = sanitize_historical_tool_names(messages)

            state["messages"] = messages
            state["thread_id"] = thread_id
            state["_version"] = obj.version
            return state
        except (DatabaseError, ValueError) as exc:
            logger.error("[ConversationStore] load_state failed: %s", exc, exc_info=True)
            return None
        except Exception as exc:
            logger.critical("[ConversationStore] Unexpected error in load_state: %s", exc, exc_info=True)
            return None

    @staticmethod
    def save_state_cas(thread_id: str, state: dict, expected_version: int) -> bool:
        """
        乐观锁保存对话状态（CAS）。

        仅当 DB 中的 version == expected_version 时才写入。用于子 Agent 并发
        回写 / lifecycle 状态更新等场景，防止覆盖其他线程的写入——典型场景：
        客户端 runtime 通过 relay 写回的 lifecycle 字段更新。

        Args:
            thread_id: 对话线程 ID
            state: 完整 state dict
            expected_version: 上次 load_state 时获取的 _version

        Returns:
            True 如果 CAS 成功，False 如果 version 冲突
        """
        from apps.services.agent_engine.models import ConversationState

        messages = state.get("messages", [])
        messages_json = _sanitize_for_json(_serialize_messages(messages))
        messages_json = _check_and_truncate_if_needed(messages_json, thread_id)
        state_json = _sanitize_for_json({
            k: v for k, v in state.items()
            if k not in _EXCLUDED_STATE_KEYS and k != "_version"
        })

        try:
            with transaction.atomic(using='postgresql'):
                updated = ConversationState.objects.filter(
                    thread_id=thread_id,
                    version=expected_version,
                ).update(
                    messages_json=messages_json,
                    state_json=state_json,
                    version=expected_version + 1,
                )
                if updated == 0:
                    logger.warning(
                        "[ConversationStore] save_state_cas version conflict: thread=%s expected=%d",
                        thread_id, expected_version,
                    )
                    return False
            logger.debug(
                "[ConversationStore] save_state_cas succeeded: thread=%s version=%d->%d",
                thread_id, expected_version, expected_version + 1,
            )
            return True
        except (DatabaseError, ValueError) as exc:
            logger.error("[ConversationStore] save_state_cas failed: %s", exc, exc_info=True)
            return False
        except Exception as exc:
            logger.critical("[ConversationStore] Unexpected error in save_state_cas: %s", exc, exc_info=True)
            return False

    @staticmethod
    def update_state_field(thread_id: str, key: str, value) -> bool:
        """原子更新 state_json 中的单个字段，不影响 messages 和其他字段。

        通过 SELECT FOR UPDATE + version 递增实现，避免 load-modify-save 竞态。
        version 递增确保并发的 save_state_cas 能感知到此修改（CAS 冲突检测）。

        Returns:
            True 成功，False 如果 thread 不存在。
        """
        from apps.services.agent_engine.models import ConversationState

        try:
            with transaction.atomic(using='postgresql'):
                obj = (
                    ConversationState.objects
                    .select_for_update()
                    .filter(thread_id=thread_id)
                    .first()
                )
                if obj is None:
                    return False
                state_json = obj.state_json or {}
                state_json[key] = _sanitize_for_json(value)
                obj.state_json = state_json
                obj.version = obj.version + 1
                obj.save(update_fields=["state_json", "version", "updated_at"])
            return True
        except (DatabaseError, ValueError) as exc:
            logger.error(
                "[ConversationStore] update_state_field failed: thread=%s key=%s: %s",
                thread_id, key, exc, exc_info=True,
            )
            return False
        except Exception as exc:
            logger.critical(
                "[ConversationStore] Unexpected error in update_state_field: thread=%s key=%s: %s",
                thread_id, key, exc, exc_info=True,
            )
            return False

    @staticmethod
    def save_interrupt(thread_id: str, state: dict, interrupt_payload: dict) -> None:
        """
        保存 HITL 中断状态。

        在 NativeReactLoop 检测到需要人工审核的 tool_call 时调用。
        同时保存完整 state 和中断 payload。

        Args:
            thread_id: 对话线程 ID
            state: 中断时的完整 state dict
            interrupt_payload: 中断 payload（包含 action_requests, review_configs 等）
        """
        from apps.services.agent_engine.models import ConversationState

        messages_json = _sanitize_for_json(_serialize_messages(state.get("messages", [])))
        messages_json = _check_and_truncate_if_needed(messages_json, thread_id)
        state_json = _sanitize_for_json({
            k: v for k, v in state.items()
            if k not in _EXCLUDED_STATE_KEYS
        })

        interrupt_state = _sanitize_for_json({
            "payload": interrupt_payload,
            "interrupted_at": time.time(),
        })

        try:
            obj = ConversationStore._upsert_state(
                thread_id, messages_json, state_json,
                extra_fields={"interrupt_state": interrupt_state},
            )
            logger.info(
                "[ConversationStore] save_interrupt: thread=%s version=%d",
                thread_id, obj.version,
            )
        except Exception as exc:
            logger.error("[ConversationStore] save_interrupt failed: %s", exc, exc_info=True)
            raise

    @staticmethod
    def _upsert_state(
        thread_id: str,
        messages_json: list,
        state_json: dict,
        extra_fields: dict,
    ):
        """INSERT-or-UPDATE，通过捕获 IntegrityError 消除首次并发 CREATE 竞态。

        流程：SELECT FOR UPDATE → 命中则 UPDATE，未命中则 CREATE；
        若并发 CREATE 抛 IntegrityError，在新事务中 SELECT FOR UPDATE → UPDATE。
        """
        from apps.services.agent_engine.models import ConversationState

        msg_bytes = _estimate_messages_bytes(messages_json)
        if msg_bytes > _MESSAGES_SIZE_HARD_LIMIT_BYTES:
            logger.error(
                "[ConversationStore] messages_json exceeds hard limit: "
                "thread=%s size=%d bytes (%d msgs), limit=%d",
                thread_id, msg_bytes, len(messages_json),
                _MESSAGES_SIZE_HARD_LIMIT_BYTES,
            )
        elif msg_bytes > _MESSAGES_SIZE_WARN_BYTES:
            logger.warning(
                "[ConversationStore] messages_json size warning: "
                "thread=%s size=%d bytes (%d msgs)",
                thread_id, msg_bytes, len(messages_json),
            )

        update_fields = ["messages_json", "state_json", "version", "updated_at"]
        update_fields.extend(extra_fields.keys())

        with transaction.atomic(using='postgresql'):
            obj = (
                ConversationState.objects
                .select_for_update()
                .filter(thread_id=thread_id)
                .first()
            )
            if obj is not None:
                obj.messages_json = messages_json
                obj.state_json = state_json
                for k, v in extra_fields.items():
                    setattr(obj, k, v)
                obj.version = obj.version + 1
                obj.save(update_fields=update_fields)
                return obj

        # 行不存在，尝试 CREATE
        try:
            with transaction.atomic(using='postgresql'):
                obj = ConversationState.objects.create(
                    thread_id=thread_id,
                    messages_json=messages_json,
                    state_json=state_json,
                    version=1,
                    **extra_fields,
                )
                return obj
        except IntegrityError:
            logger.info(
                "[ConversationStore] Concurrent INSERT detected, falling back to UPDATE: thread=%s",
                thread_id,
            )

        # 并发 CREATE 失败，回退到 SELECT FOR UPDATE → UPDATE
        with transaction.atomic(using='postgresql'):
            obj = (
                ConversationState.objects
                .select_for_update()
                .filter(thread_id=thread_id)
                .first()
            )
            if obj is None:
                raise RuntimeError(
                    f"[ConversationStore] Row vanished after IntegrityError: thread={thread_id}"
                )
            obj.messages_json = messages_json
            obj.state_json = state_json
            for k, v in extra_fields.items():
                setattr(obj, k, v)
            obj.version = obj.version + 1
            obj.save(update_fields=update_fields)
            return obj

    _INTERRUPT_RETRY_MAX = 4
    _INTERRUPT_RETRY_DELAY_S = 0.25

    @staticmethod
    def load_and_clear_interrupt(
        thread_id: str,
        *,
        expected_user_id: Optional[str] = None,
        max_retries: int = _INTERRUPT_RETRY_MAX,
        retry_delay: float = _INTERRUPT_RETRY_DELAY_S,
    ) -> Optional[dict]:
        """原子加载 + 清除中断状态，防止并发 review 请求重复执行工具。

        区分行被锁中（skip_locked 跳过）与真正缺失：
        - 首次使用 skip_locked=True 快速尝试
        - 若被跳过（行存在但锁中），有限次阻塞重试（SELECT FOR UPDATE 等待锁释放）
        - 若行不存在或 interrupt_state 为空，立即返回 None

        Args:
            expected_user_id: 可选，提供时校验 state 中的 user_id 是否匹配。
        """
        from apps.services.agent_engine.models import ConversationState

        try:
            with transaction.atomic(using="postgresql"):
                obj = (
                    ConversationState.objects
                    .select_for_update(skip_locked=True)
                    .filter(thread_id=thread_id)
                    .first()
                )
                if obj is not None:
                    if expected_user_id is not None:
                        if not ConversationStore._check_thread_user(
                            thread_id, obj.state_json, expected_user_id,
                        ):
                            return None
                    if not obj.interrupt_state:
                        return None
                    return ConversationStore._extract_and_clear_interrupt(obj, thread_id)
        except (DatabaseError, ValueError) as exc:
            logger.error(
                "[ConversationStore] load_and_clear_interrupt failed: %s", exc, exc_info=True,
            )
            return None
        except Exception as exc:
            logger.critical(
                "[ConversationStore] Unexpected error in load_and_clear_interrupt: %s", exc, exc_info=True,
            )
            return None

        row_exists = ConversationState.objects.filter(thread_id=thread_id).exists()
        if not row_exists:
            return None

        for attempt in range(1, max_retries + 1):
            time.sleep(retry_delay)
            try:
                with transaction.atomic(using="postgresql"):
                    obj = (
                        ConversationState.objects
                        .select_for_update()
                        .filter(thread_id=thread_id)
                        .first()
                    )
                    if obj is None or not obj.interrupt_state:
                        logger.info(
                            "[ConversationStore] load_and_clear_interrupt: "
                            "interrupt consumed during retry (attempt %d/%d): thread=%s",
                            attempt, max_retries, thread_id,
                        )
                        return None
                    return ConversationStore._extract_and_clear_interrupt(obj, thread_id)
            except (DatabaseError, ValueError) as exc:
                logger.warning(
                    "[ConversationStore] load_and_clear_interrupt retry %d/%d failed: %s",
                    attempt, max_retries, exc,
                )
                if attempt == max_retries:
                    return None
            except Exception as exc:
                logger.critical(
                    "[ConversationStore] Unexpected error in load_and_clear_interrupt retry %d/%d: %s",
                    attempt, max_retries, exc, exc_info=True,
                )
                return None

        return None

    @staticmethod
    def _extract_and_clear_interrupt(obj, thread_id: str) -> dict:
        """从 ConversationState 行中提取 interrupt_state 并清除。

        save_interrupt 不再冗余存储 messages_snapshot / state_snapshot，
        改为此处从主列（messages_json / state_json）按需重建，向后兼容旧数据。

        返回的 dict 包含 ``_version`` 字段（清除后的新版本号），
        供 resume 路径使用 CAS 持久化最终状态，防止覆盖延迟期间的并发写入（P1-36）。
        """
        data = dict(obj.interrupt_state)
        if "messages_snapshot" not in data:
            data["messages_snapshot"] = list(obj.messages_json or [])
        if "state_snapshot" not in data:
            data["state_snapshot"] = dict(obj.state_json or {})
        obj.interrupt_state = None
        obj.version = obj.version + 1
        obj.save(update_fields=["interrupt_state", "version", "updated_at"])
        data["_version"] = obj.version
        logger.info(
            "[ConversationStore] load_and_clear_interrupt: thread=%s version=%d",
            thread_id, obj.version,
        )
        return data

    @staticmethod
    def peek_interrupt_state(thread_id: str) -> Optional[dict]:
        """只读获取 ``ConversationState.interrupt_state``（不清除、不加锁）。

        给 ``PromptForwardService`` 的生产 caller 用：用户重发 prompt 时
        把当前 PG 里的 interrupt_state 整包透传给 daemon → DaemonAgentHost
        在 runtime.query 入口按 ``pending_approvals`` 重建 PendingApprovalRegistry。
        清除发生在 daemon 跑完审批回送 ``approval_resolved`` 后的
        ``_persist_approval_resolved`` 路径，**不**在本读路径。

        与 ``load_and_clear_interrupt`` 区别：
        - load_and_clear：消费语义，原子取出 + 清除（resume 路径用）
        - peek：观察语义，只读不清（forward 重发路径用，避免把 daemon 还没消费
          完的状态提前清掉）

        行不存在 / interrupt_state 为空 → 返回 ``None``。
        DB 异常 → 返回 ``None``（不抛，避免阻塞 forward 主路径）。
        """
        from apps.services.agent_engine.models import ConversationState

        try:
            row = (
                ConversationState.objects
                .filter(thread_id=thread_id)
                .only("interrupt_state")
                .first()
            )
        except Exception as exc:
            logger.warning(
                "[ConversationStore] peek_interrupt_state failed: thread=%s error=%s",
                thread_id, exc,
            )
            return None

        if row is None:
            return None
        state = row.interrupt_state
        if not isinstance(state, dict) or not state:
            return None
        return state

    @staticmethod
    def restore_interrupt(thread_id: str, interrupt_data: dict) -> None:
        """将 load_and_clear_interrupt 取出的中断数据写回 PG。

        用于 resume 路径中账单/TTL 等后置校验失败时恢复中断状态，
        避免中断被提前清空后无法重试。
        """
        from apps.services.agent_engine.models import ConversationState

        restore_payload = _sanitize_for_json({
            k: v for k, v in interrupt_data.items()
            if k != "_version"
        })

        try:
            with transaction.atomic(using="postgresql"):
                obj = (
                    ConversationState.objects
                    .select_for_update()
                    .filter(thread_id=thread_id)
                    .first()
                )
                if obj is None:
                    logger.warning(
                        "[ConversationStore] restore_interrupt: row not found for thread=%s",
                        thread_id,
                    )
                    return
                obj.interrupt_state = restore_payload
                obj.version = obj.version + 1
                obj.save(update_fields=["interrupt_state", "version", "updated_at"])
                logger.info(
                    "[ConversationStore] restore_interrupt: thread=%s version=%d",
                    thread_id, obj.version,
                )
        except Exception as exc:
            logger.error(
                "[ConversationStore] restore_interrupt failed: thread=%s error=%s",
                thread_id, exc, exc_info=True,
            )

    @staticmethod
    def check_messages_size(messages: list) -> Tuple[int, bool, bool]:
        """估算 messages 体积，供并行工具等调用方在中间步骤做体积守卫。

        Returns:
            (estimated_bytes, exceeded_warning, exceeded_hard_limit)
            - exceeded_warning: 超过 2 MB 警告阈值，调用方应触发压缩
            - exceeded_hard_limit: 超过 8 MB 硬限制，调用方应截断后续追加
        """
        serialized = _serialize_messages(messages)
        size = _estimate_messages_bytes(serialized)
        return (
            size,
            size > _MESSAGES_SIZE_WARN_BYTES,
            size > _MESSAGES_SIZE_HARD_LIMIT_BYTES,
        )

    @staticmethod
    def _check_thread_user(
        thread_id: str,
        state_json: Optional[dict],
        expected_user_id: str,
    ) -> bool:
        """校验 thread 归属于指定用户（纵深防御）。

        优先检查 state_json 中的 user_id；对 chat-session-* 前缀的 thread
        回退到 ChatSession.user_id 校验。不匹配时记录安全日志。
        """
        owner_id = (state_json or {}).get("user_id")
        if owner_id and str(owner_id) == str(expected_user_id):
            return True

        if owner_id and str(owner_id) != str(expected_user_id):
            logger.warning(
                "[ConversationStore] thread ownership mismatch: "
                "thread=%s expected=%s actual=%s",
                thread_id, expected_user_id, owner_id,
            )
            return False

        if thread_id.startswith("chat-session-"):
            try:
                from apps.chat.conversation.models import ChatSession
                session = ChatSession.objects.filter(thread_id=thread_id).only("user_id").first()
                if not session:
                    sid = thread_id.replace("chat-session-", "", 1)
                    session = ChatSession.objects.filter(id=sid).only("user_id").first()
                if session:
                    if str(session.user_id) != str(expected_user_id):
                        logger.warning(
                            "[ConversationStore] ChatSession ownership mismatch: "
                            "thread=%s expected=%s session_user=%s",
                            thread_id, expected_user_id, session.user_id,
                        )
                        return False
                    return True
            except Exception as exc:
                logger.warning(
                    "[ConversationStore] ChatSession lookup failed during ownership check: "
                    "thread=%s error=%s", thread_id, exc,
                )
                return False

        # R-1 deny-by-default: owner_id 为空且无法通过 ChatSession 验证归属时拒绝访问
        logger.warning(
            "[ConversationStore] thread ownership unverifiable (no owner_id in state): "
            "thread=%s expected_user=%s",
            thread_id, expected_user_id,
        )
        return False

    @staticmethod
    def exists(thread_id: str) -> bool:
        """检查指定 thread_id 的对话状态是否存在。"""
        from apps.services.agent_engine.models import ConversationState

        try:
            return ConversationState.objects.filter(thread_id=thread_id).exists()
        except (DatabaseError, ValueError) as exc:
            logger.warning("[ConversationStore] exists check failed: thread=%s: %s", thread_id, exc)
            return False
        except Exception as exc:
            logger.critical("[ConversationStore] Unexpected error in exists: thread=%s: %s", thread_id, exc, exc_info=True)
            return False

    @staticmethod
    def delete(thread_id: str) -> bool:
        """删除指定 thread_id 的对话状态。"""
        from apps.services.agent_engine.models import ConversationState

        try:
            deleted, _ = ConversationState.objects.filter(thread_id=thread_id).delete()
            return deleted > 0
        except Exception as exc:
            logger.error("[ConversationStore] delete failed: %s", exc, exc_info=True)
            return False

    @staticmethod
    def save_state_fallback(thread_id: str, state: dict) -> bool:
        """PG 持久化全部失败后，将 state 写入 Redis 作为紧急兜底。

        与 save_state 共用序列化逻辑，保证 load_state 可还原。
        """
        try:
            redis = _get_fallback_redis()
            messages = state.get("messages", [])
            messages_json = _sanitize_for_json(_serialize_messages(messages))
            messages_json = _check_and_truncate_if_needed(messages_json, thread_id)
            state_json = _sanitize_for_json({
                k: v for k, v in state.items()
                if k not in _EXCLUDED_STATE_KEYS
            })
            payload = _json.dumps({
                "messages_json": messages_json,
                "state_json": state_json,
            }, ensure_ascii=False)
            key = f"{FALLBACK_KEY_PREFIX}{thread_id}"
            redis.setex(key, FALLBACK_TTL_SECONDS, payload.encode("utf-8"))
            logger.info(
                "[ConversationStore] State fallback saved to Redis: thread=%s msgs=%d",
                thread_id, len(messages_json),
            )
            return True
        except Exception as exc:
            logger.error(
                "[ConversationStore] Redis fallback write also failed: thread=%s: %s",
                thread_id, exc, exc_info=True,
            )
            return False

    @staticmethod
    def _load_fallback_from_redis(thread_id: str) -> Optional[dict]:
        """从 Redis 兜底 key 加载 state。成功后尝试最佳努力回写 PG。"""
        try:
            redis = _get_fallback_redis()
            key = f"{FALLBACK_KEY_PREFIX}{thread_id}"
            raw = redis.get(key)
            if not raw:
                return None

            data = _json.loads(raw)
            state = dict(data.get("state_json", {}))
            raw_messages = data.get("messages_json", [])
            state["messages"] = validate_messages(raw_messages, thread_id)
            state["thread_id"] = thread_id
            state["_version"] = 0
            state["_from_redis_fallback"] = True

            logger.info(
                "[ConversationStore] State loaded from Redis fallback: thread=%s msgs=%d",
                thread_id, len(state["messages"]),
            )

            try:
                ConversationStore.save_state(thread_id, state)
                redis.delete(key)
                logger.info(
                    "[ConversationStore] Redis fallback recovered to PG: thread=%s",
                    thread_id,
                )
            except Exception as pg_exc:
                logger.warning(
                    "[ConversationStore] Redis fallback PG writeback failed "
                    "(will retry via Celery): thread=%s: %s",
                    thread_id, pg_exc,
                )

            return state
        except Exception as exc:
            logger.warning(
                "[ConversationStore] Redis fallback read failed: thread=%s: %s",
                thread_id, exc,
            )
            return None


_VALID_ROLES = frozenset({"system", "user", "assistant", "tool", "function"})


def validate_messages(raw: Any, thread_id: str = "") -> List[dict]:
    """校验并修复 messages_json，过滤格式异常的条目。"""
    if not isinstance(raw, list):
        logger.warning(
            "[ConversationStore] messages_json is not a list (thread=%s), type=%s",
            thread_id, type(raw).__name__,
        )
        return []

    valid: List[dict] = []
    for idx, msg in enumerate(raw):
        if not isinstance(msg, dict):
            logger.warning(
                "[ConversationStore] Skipping non-dict message #%d (thread=%s)",
                idx, thread_id,
            )
            continue
        role = msg.get("role")
        if role not in _VALID_ROLES:
            logger.warning(
                "[ConversationStore] Skipping invalid role=%r message #%d (thread=%s)",
                role, idx, thread_id,
            )
            continue
        valid.append(msg)

    _repair_orphan_tool_calls(valid)
    return valid


def _serialize_messages(messages: list) -> List[dict]:
    """
    将消息列表序列化为 OpenAI dict 格式。

    支持：
    - 已经是 dict 的消息（直接使用）
    - LangChain BaseMessage 对象（转换为 dict）
    """
    result: List[dict] = []
    for msg in messages:
        if isinstance(msg, dict):
            result.append(msg)
        else:
            # LangChain BaseMessage → dict
            msg_type = getattr(msg, "type", None) or getattr(msg, "role", None)
            if msg_type == "human":
                role = "user"
            elif msg_type == "ai":
                role = "assistant"
            elif msg_type == "system":
                role = "system"
            elif msg_type == "tool":
                role = "tool"
            else:
                role = msg_type or "assistant"

            entry: Dict[str, Any] = {
                "role": role,
                "content": getattr(msg, "content", ""),
            }
            tool_call_id = getattr(msg, "tool_call_id", None)
            if tool_call_id:
                entry["tool_call_id"] = tool_call_id
            name = getattr(msg, "name", None)
            if name:
                entry["name"] = name
            tool_calls = getattr(msg, "tool_calls", None)
            if tool_calls:
                entry["tool_calls"] = tool_calls

            result.append(entry)
    return result


__all__ = ["ConversationStore"]
