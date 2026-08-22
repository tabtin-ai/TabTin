"""
消息接收层（Stage A）— 去重、排队、锁、debounce

从 ChatService 提取的模块级函数，保持业务逻辑不变。
"""

from typing import Dict, Any, Callable, List, Optional, Union

import hashlib
import json
import logging
import time
import uuid

from django.db import DatabaseError

from apps.services.common.chat_stream_publisher import (
    ChatStreamPublisher as Publisher,
)

logger = logging.getLogger(__name__)


def normalize_queue_mode(mode: Optional[str]) -> str:
    normalized = (mode or "collect").strip().lower()
    if normalized in {"collect", "followup", "steer"}:
        return normalized
    if normalized in {"queue", "interrupt"}:
        return "followup"
    return "collect"


def build_client_message_id(session_id: str, user_id: str, message: str) -> str:
    time_bucket = int(time.time()) // 5
    digest = hashlib.sha1(f"{session_id}:{user_id}:{message}:{time_bucket}".encode("utf-8")).hexdigest()
    return digest


def load_queue_settings(queue_service) -> Dict[str, Any]:
    settings = queue_service.load_settings()
    settings["queue_mode"] = normalize_queue_mode(settings.get("queue_mode"))
    return settings


def build_queue_payload(
    *,
    message: str,
    model_id: Optional[str],
    user_message_id: Optional[str],
    agent_name: Optional[str] = None,
    blocks: Optional[list] = None,
    attachments: Optional[list] = None,
    client_type: Optional[str] = None,
    execution_profile: Optional[str] = None,
    app_context: Optional[Dict[str, Any]] = None,
    agent_mode: Optional[str] = None,
    approval_mode: Optional[str] = None,
    client_message_id: Optional[str] = None,
    dedupe_key: Optional[str] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "message": message,
        "model_id": model_id,
        "user_message_id": user_message_id,
        "agent_name": agent_name,
        "queued_at": time.time(),
    }
    if blocks is not None:
        payload["blocks"] = blocks
    if attachments is not None:
        payload["attachments"] = attachments
    if client_type is not None:
        payload["client_type"] = client_type
    if execution_profile is not None:
        payload["execution_profile"] = execution_profile
    if app_context is not None:
        payload["app_context"] = app_context
    if agent_mode is not None:
        payload["agent_mode"] = agent_mode
    if approval_mode is not None:
        payload["approval_mode"] = approval_mode
    if client_message_id is not None:
        payload["client_message_id"] = client_message_id
    if dedupe_key is not None:
        payload["dedupe_key"] = dedupe_key
    return payload


def enqueue_payload(queue_service, thread_id: str, payload: Dict[str, Any], settings: Dict[str, Any]) -> bool:
    mode = settings.get("queue_mode", "collect")
    debounce_ms = int(settings.get("debounce_ms", 0) or 0)
    queue_max = int(settings.get("queue_max", 0) or 0)
    queue_ttl = int(settings.get("queue_ttl", 0) or 0)

    if mode == "collect":
        if queue_max and queue_service.get_collect_size(thread_id) >= queue_max:
            logger.warning("[ChatService] Collect queue full, discarding message: %s", thread_id)
            return False
        if debounce_ms > 0:
            is_first = queue_service.enqueue_debounce(thread_id, payload, debounce_ms)
            logger.info(
                "[ChatService] Debounce enqueue (collect): thread=%s, "
                "is_first=%s, debounce_ms=%d",
                thread_id, is_first, debounce_ms,
            )
            return True
        queue_service.enqueue_collect(thread_id, payload, ttl=queue_ttl)
        return True

    # followup / steer
    if mode == "steer":
        logger.info("[ChatService] Steer mode treated as followup: %s", thread_id)
    if queue_max and queue_service.get_queue_size(thread_id) >= queue_max:
        logger.warning("[ChatService] Followup queue full, discarding message: %s", thread_id)
        return False
    if debounce_ms > 0:
        is_first = queue_service.enqueue_debounce(thread_id, payload, debounce_ms)
        logger.info(
            "[ChatService] Debounce enqueue (followup): thread=%s, "
            "is_first=%s, debounce_ms=%d",
            thread_id, is_first, debounce_ms,
        )
        return True
    queue_service.enqueue_followup(thread_id, payload, ttl=queue_ttl)
    return True


def enqueue_payload_once(
    queue_service,
    thread_id: str,
    payload: Dict[str, Any],
    settings: Dict[str, Any],
    *,
    dedupe_key: str,
    queued_result: Dict[str, Any],
):
    """以稳定事件 ID 原子入队并缓存 queued 受理结果。"""
    return queue_service.enqueue_once(
        thread_id=thread_id,
        client_event_id=dedupe_key,
        payload=payload,
        queued_result=queued_result,
        mode=settings.get("queue_mode", "collect"),
        queue_max=int(settings.get("queue_max", 0) or 0),
        queue_ttl=int(settings.get("queue_ttl", 0) or 0),
        dedupe_ttl=int(settings.get("dedupe_ttl", 0) or 0),
        debounce_ms=int(settings.get("debounce_ms", 0) or 0),
    )


def drain_queued_payloads(queue_service, thread_id: str, settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从队列中取出待处理消息。

    注意：不再在此处执行 debounce sleep，由调用方通过 wait_debounce_outside_lock
    在锁外等待 debounce 窗口关闭后再调用本方法。
    """
    mode = settings.get("queue_mode", "collect")
    debounce_ms = int(settings.get("debounce_ms", 0) or 0)

    if debounce_ms > 0:
        items = queue_service.drain_debounce(thread_id)
        if items:
            return items

    if mode == "collect":
        return queue_service.drain_collect(thread_id)

    item = queue_service.pop_followup(thread_id)
    return [item] if item else []


_DELIVERY_RESULT_METADATA_KEY = "chat_delivery_result_v1"


def _normalize_cached_result(value: Dict[str, Any]) -> Dict[str, Any]:
    """复制 Redis/JSON 结果，避免调用方修改共享对象。"""
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def persist_dedupe_result(
    session,
    client_message_id: Optional[str],
    result: Dict[str, Any],
) -> None:
    """把完整投递结果写回 USER metadata，作为 Redis 丢失时的恢复事实。

    Redis 是快速去重层；稳定 ``client_event_id`` 对应的 USER 行是持久事实层。
    保存 task_id 等 ACK 关键字段后，Redis 过期或故障也无需把 USER 行误当成
    assistant，更不会为了恢复结果再次 dispatch。
    """
    if not client_message_id or not isinstance(result, dict):
        return
    try:
        client_uuid = uuid.UUID(str(client_message_id))
    except (ValueError, TypeError, AttributeError):
        return

    from django.db import transaction
    from apps.chat.conversation.models import ChatMessage

    safe_result = _normalize_cached_result(result)
    try:
        with transaction.atomic():
            user_message = (
                ChatMessage.objects.select_for_update()
                .filter(
                    session=session,
                    role="user",
                    client_event_id=client_uuid,
                )
                .first()
            )
            if user_message is None:
                return
            metadata = dict(user_message.metadata or {})
            metadata[_DELIVERY_RESULT_METADATA_KEY] = safe_result
            user_message.metadata = metadata
            user_message.save(update_fields=["metadata", "updated_at"])
    except Exception:
        # Redis dedupe 已足以保护热路径；DB 补偿失败只降级恢复能力，不能把已
        # 成功 dispatch 的请求翻转成失败。
        logger.warning(
            "[ChatService] persist dedupe result failed: session=%s client_event_id=%s",
            getattr(session, "id", None),
            client_message_id,
            exc_info=True,
        )


def build_dedupe_response(
    session,
    cached_result: Optional[Union[Dict[str, Any], str]],
    *,
    client_message_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """恢复完整 ChatService 结果，兼容 v2 JSON 与旧纯 message_id 缓存。"""
    if isinstance(cached_result, dict):
        return _normalize_cached_result(cached_result)

    if isinstance(cached_result, str) and cached_result.startswith("err-persist-"):
        return {
            "message_id": cached_result,
            "reply": "",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "persist_error",
        }

    from apps.chat.conversation.models import ChatMessage

    message = None
    resolved_from_legacy_id = False
    if isinstance(cached_result, str) and cached_result:
        try:
            cached_uuid = uuid.UUID(cached_result)
        except (ValueError, TypeError, AttributeError):
            cached_uuid = None
        if cached_uuid is not None:
            message = ChatMessage.objects.filter(
                session=session,
                id=cached_uuid,
            ).first()
            resolved_from_legacy_id = message is not None

    # Redis miss / 旧缓存值失效时优先用稳定 client_event_id 找 USER 持久事实。
    if message is None and client_message_id:
        try:
            client_uuid = uuid.UUID(str(client_message_id))
        except (ValueError, TypeError, AttributeError):
            client_uuid = None
        if client_uuid is not None:
            message = ChatMessage.objects.filter(
                session=session,
                role="user",
                client_event_id=client_uuid,
            ).first()

    if message is None:
        return None

    if message.role == "user":
        metadata = message.metadata if isinstance(message.metadata, dict) else {}
        persisted = metadata.get(_DELIVERY_RESULT_METADATA_KEY)
        if isinstance(persisted, dict):
            return _normalize_cached_result(persisted)
        # 兼容部署前错误地把 USER id 当 assistant id 存进 Redis 的值。这里
        # 只恢复 USER ACK，不读已删除的 content，也绝不伪造 assistant reply。
        if not resolved_from_legacy_id:
            return None
        model_instance = message.model
        return {
            "message_id": str(message.id),
            "reply": "",
            "model_id": str(model_instance.id) if model_instance else None,
            "model_name": model_instance.model_name if model_instance else None,
            "trace_id": str(message.trace_id) if message.trace_id else None,
        }

    # 旧版缓存确实可能存 assistant id；W3 后正文来自 text_summary / blocks，
    # ``content`` 已删除，任何低频 dedupe 命中都不能再访问它。
    model_instance = message.model
    return {
        "message_id": str(message.id),
        "reply": message.text_summary or "",
        "model_id": str(model_instance.id) if model_instance else None,
        "model_name": model_instance.model_name if model_instance else None,
        "trace_id": str(message.trace_id) if message.trace_id else None,
    }


def push_queue_error(session, thread_id: str, exc: Exception) -> Dict[str, Any]:
    """队列消息处理失败时向用户推送 error 事件，避免 [queued] 回复后无后续响应。"""
    try:
        from apps.services.agent_engine.observability.error_category import classify_agent_error
        from apps.services.agent_engine.services.persistence_pipeline import (
            persist_error_message,
        )
        error_category = classify_agent_error(exc)
        err_msg = f"[{error_category}] An error occurred while processing your queued message."
        from apps.chat.conversation.models import ChatMessage
        source_user = (
            ChatMessage.objects
            .filter(session=session, role="user")
            .order_by("-created_at")
            .first()
        )
        source_client_event_id = (
            str(source_user.client_event_id or source_user.id)
            if source_user is not None else None
        )
        err_assistant = persist_error_message(
            session,
            err_msg,
            error_category=error_category,
            source_client_event_id=source_client_event_id,
        )
        Publisher.publish_stream_done(
            thread_id, err_msg,
            message_id=str(err_assistant.id),
            metadata={"error_category": error_category},
            source_client_event_id=source_client_event_id,
        )
        return {
            "message_id": "",
            "error_message_id": str(err_assistant.id),
            "reply": err_msg,
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": error_category,
            "retryable": True,
        }
    except Exception as push_exc:
        logger.error(
            "[ChatService] Failed to push queue error event to user "
            "(session=%s, thread=%s): %s", session.id, thread_id, push_exc,
        )
        return {
            "message_id": "",
            "reply": "An error occurred while processing your queued message.",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "queue_processing_failed",
            "retryable": True,
        }


def wait_debounce_outside_lock(
    queue_service, thread_id: str, lock_token: str,
    debounce_ms: int, lock_ttl: int,
    *, watchdog=None,
) -> tuple:
    """debounce 窗口仍有剩余时间时，先释放锁再 sleep，避免阻塞 Gunicorn 线程。

    P1-16: 循环检查 debounce 是否真正结束后再返回，防止 sleep 期间新 debounce
           窗口开启导致 drain 取走不完整批次。
    P1-17: 每次循环重新读取 Redis PTTL 作为等待时间（含缓冲），不再用 debounce_ms
           做上限截断，避免 PTTL > debounce_ms（时钟偏差）时提前唤醒。
    P1-18: 每次重新获取锁使用全局唯一 token，防止 Redis Sentinel 切换时复用过时
           token 导致双持有；通过 watchdog.pause/resume 保持续期线程同步。

    Returns (success, current_token):
        success=True: 锁已获取且 debounce 已结束，current_token 为当前有效 token。
        success=False: 放弃（由其他锁持有者 drain），current_token 无意义。
    """
    from apps.services.agent_engine.services.message_queue_service import LockResult
    from apps.services.agent_engine.configuration import OrchestrationConfiguration
    try:
        _cfg = OrchestrationConfiguration.from_settings()
    except Exception:
        _cfg = OrchestrationConfiguration()

    _pttl_buffer = _cfg.debounce_pttl_buffer_ms
    _max_retries = _cfg.debounce_max_wait_retries

    current_token = lock_token

    for attempt in range(_max_retries):
        remaining_ms = queue_service.get_debounce_remaining_ms(thread_id)
        if remaining_ms is None:
            pending = queue_service.get_debounce_list_len(thread_id)
            if pending > 0:
                logger.warning(
                    "[ChatService] Debounce active_key missing but %d items "
                    "pending (anomalous state, possibly orphaned by crash): "
                    "thread=%s — proceeding to drain",
                    pending, thread_id,
                )
            return True, current_token
        if remaining_ms <= 0:
            return True, current_token

        if watchdog is not None:
            watchdog.pause()

        queue_service.release_lock(thread_id, current_token)
        wait_s = (remaining_ms + _pttl_buffer) / 1000
        time.sleep(wait_s)

        current_token = uuid.uuid4().hex
        lock_result = queue_service.acquire_lock(thread_id, current_token, ttl=lock_ttl)

        if lock_result != LockResult.ACQUIRED:
            logger.info(
                "[ChatService] Could not re-acquire lock after debounce wait "
                "(result=%s, attempt=%d/%d), another holder will drain: thread=%s",
                lock_result.value, attempt + 1,
                _max_retries, thread_id,
            )
            return False, current_token

        if watchdog is not None:
            watchdog.resume(current_token)

    logger.warning(
        "[ChatService] Debounce wait exceeded max retries (%d), "
        "proceeding with drain: thread=%s",
        _max_retries, thread_id,
    )
    return True, current_token


def process_queued_messages_sync(
    *,
    session,
    user,
    thread_id: str,
    queue_service,
    queue_settings: Dict[str, Any],
    lock_token: str = "",
    watchdog=None,
    process_fn: Callable,
    error_fn: Callable,
) -> str:
    """处理队列中的排队消息。

    Args:
        process_fn: 处理单条消息的回调（对应 ChatService._process_message_sync_core）。
        error_fn: 处理错误时的推送回调（对应 ChatService._push_queue_error）。

    Returns: 当前有效的 lock_token（可能因 P1-18 debounce 重获取而更新）。
    """
    max_runs = int(queue_settings.get("queue_max", 50) or 50)
    debounce_ms = int(queue_settings.get("debounce_ms", 0) or 0)
    lock_ttl = int(queue_settings.get("lock_ttl", 600))
    processed_runs = 0
    mode = queue_settings.get("queue_mode", "collect")
    current_token = lock_token

    def _finalize_payload_results(
        payload_items: List[Dict[str, Any]],
        process_result: Optional[Dict[str, Any]],
    ) -> None:
        if not isinstance(process_result, dict):
            process_result = {
                "message_id": "",
                "reply": "Queued message processing returned no result.",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
                "error_category": "queue_processing_failed",
                "retryable": True,
            }
        result_ttl = max(
            int(queue_settings.get("dedupe_ttl", 300) or 300),
            int(queue_settings.get("queue_ttl", 0) or 0),
        )
        for queued_payload in payload_items:
            dedupe_key = (
                queued_payload.get("dedupe_key")
                or queued_payload.get("client_message_id")
            )
            if not dedupe_key:
                continue
            item_result = dict(process_result)
            if queued_payload.get("user_message_id"):
                item_result["message_id"] = str(
                    queued_payload["user_message_id"]
                )
            queue_service.set_dedupe_result(
                thread_id,
                str(dedupe_key),
                item_result,
                ttl=result_ttl,
            )
            persist_dedupe_result(
                session,
                queued_payload.get("client_message_id"),
                item_result,
            )

    while processed_runs < max_runs:
        if debounce_ms > 0 and current_token:
            success, current_token = wait_debounce_outside_lock(
                queue_service, thread_id, current_token, debounce_ms, lock_ttl,
                watchdog=watchdog,
            )
            if not success:
                return current_token

        payloads = drain_queued_payloads(queue_service, thread_id, queue_settings)
        if not payloads:
            break

        if mode == "collect":
            pairs = [
                (item.get("message"), item.get("user_message_id"))
                for item in payloads
                if item.get("message")
            ]
            messages = [pair[0] for pair in pairs]
            if not messages:
                break
            user_message_ids = [str(pair[1]) for pair in pairs if pair[1]]
            last_payload = payloads[-1] if payloads else {}
            model_id = last_payload.get("model_id")
            agent_name = last_payload.get("agent_name")
            try:
                process_result = process_fn(
                    session=session,
                    user=user,
                    messages=messages,
                    model_id=model_id,
                    thread_id=thread_id,
                    user_message_ids=user_message_ids or None,
                    agent_name=agent_name,
                    blocks=last_payload.get("blocks"),
                    attachments=last_payload.get("attachments"),
                    client_type=last_payload.get("client_type"),
                    execution_profile=last_payload.get("execution_profile"),
                    app_context=last_payload.get("app_context"),
                    agent_mode=last_payload.get("agent_mode"),
                    approval_mode=last_payload.get("approval_mode"),
                    client_message_id=last_payload.get("client_message_id"),
                )
            except (DatabaseError, ValueError) as exc:
                logger.warning("[ChatService] Failed to process collect queue: %s", exc, exc_info=True)
                process_result = error_fn(session, thread_id, exc)
            except Exception as exc:
                logger.critical("[ChatService] Unexpected error processing collect queue: %s", exc, exc_info=True)
                process_result = error_fn(session, thread_id, exc)
            _finalize_payload_results(payloads, process_result)
            processed_runs += 1
            continue

        for payload in payloads:
            message_text = payload.get("message")
            if not message_text:
                continue
            try:
                process_result = process_fn(
                    session=session,
                    user=user,
                    messages=[message_text],
                    model_id=payload.get("model_id"),
                    thread_id=thread_id,
                    user_message_ids=[str(payload.get("user_message_id"))]
                    if payload.get("user_message_id")
                    else None,
                    agent_name=payload.get("agent_name"),
                    blocks=payload.get("blocks"),
                    attachments=payload.get("attachments"),
                    client_type=payload.get("client_type"),
                    execution_profile=payload.get("execution_profile"),
                    app_context=payload.get("app_context"),
                    agent_mode=payload.get("agent_mode"),
                    approval_mode=payload.get("approval_mode"),
                    client_message_id=payload.get("client_message_id"),
                )
            except (DatabaseError, ValueError) as exc:
                logger.warning("[ChatService] Failed to process followup queue: %s", exc, exc_info=True)
                process_result = error_fn(session, thread_id, exc)
            except Exception as exc:
                logger.critical("[ChatService] Unexpected error processing followup queue: %s", exc, exc_info=True)
                process_result = error_fn(session, thread_id, exc)
            _finalize_payload_results([payload], process_result)
            processed_runs += 1
            if processed_runs >= max_runs:
                break

    return current_token


def drain_queue_until_safely_released(
    *,
    session,
    user,
    thread_id: str,
    queue_service,
    queue_settings: Dict[str, Any],
    lock_token: str,
    watchdog=None,
    process_fn: Callable,
    error_fn: Callable,
) -> str:
    """Drain queued work and close the tail-enqueue race atomically.

    When the atomic release reports new work, loop back through the regular
    idempotent queue processor.  Each payload already references its persisted
    user message, so replaying the handoff loop cannot create a second user row.
    """
    current_token = lock_token
    while True:
        current_token = process_queued_messages_sync(
            session=session,
            user=user,
            thread_id=thread_id,
            queue_service=queue_service,
            queue_settings=queue_settings,
            lock_token=current_token,
            watchdog=watchdog,
            process_fn=process_fn,
            error_fn=error_fn,
        )
        if queue_service.release_lock_if_queues_empty(thread_id, current_token):
            return current_token
        logger.info(
            "[ChatService] Queue tail enqueue detected; draining before lock handoff: thread=%s",
            thread_id,
        )
