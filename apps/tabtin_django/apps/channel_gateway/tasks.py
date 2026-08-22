"""Channel Gateway background tasks."""

from __future__ import annotations

import json
import logging
import re
from datetime import timedelta

from celery import shared_task

from apps.channel_gateway.compat import run_adapter_coro
from apps.channel_gateway.services.outbound_service import ChannelOutboundService

logger = logging.getLogger(__name__)

CHANNEL_AGENT_MAX_ITERATIONS = 5

CHANNEL_RATE_LIMIT_WINDOW = 60
CHANNEL_RATE_LIMIT_MAX_REQUESTS = 10
_RATE_LIMIT_KEY_PREFIX = "ch_rate:"

_HITL_PATTERN = re.compile(r"\[review_required\]|\[ask_user\]")

CHANNEL_GATEWAY_BEAT_SCHEDULE = {
    "channel-gateway-deliver-outbox-sweep": {
        "task": "channel_gateway.deliver_outbox_sweep",
        "schedule": 60,
        "options": {"expires": 55, "queue": "realtime_delivery"},
    },
    "channel-gateway-retry-outbox": {
        "task": "channel_gateway.retry_channel_outbox",
        "schedule": 60,
        "options": {"expires": 55, "queue": "realtime_delivery"},
    },
    "channel-gateway-channel-poll": {
        "task": "channel_gateway.channel_poll",
        "schedule": 3,
        "options": {"expires": 2, "queue": "realtime_delivery"},
    },
    "channel-gateway-cleanup-logs": {
        "task": "channel_gateway.cleanup_old_records",
        "schedule": timedelta(hours=6),
        "options": {"expires": 600, "queue": "default"},
    },
    "channel-gateway-probe-longpoll": {
        "task": "channel_gateway.probe_longpoll_accounts",
        "schedule": timedelta(hours=6),
        "options": {"expires": 600, "queue": "default"},
    },
}


@shared_task(
    name="channel_gateway.retry_channel_outbox",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
    queue="realtime_delivery",
)
def retry_channel_outbox() -> int:
    return ChannelOutboundService().retry_pending(limit=100)


@shared_task(
    name="channel_gateway.deliver_one_outbox",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
    queue="realtime_delivery",
)
def deliver_one_outbox(outbox_id: str) -> int:
    """投递单条出站消息；已发送或未到重试时间的记录按幂等 no-op 处理。"""
    from django.db import transaction
    from django.db.models import Q
    from django.utils import timezone

    from apps.channel_gateway.models import ChannelOutboundMessageRecord

    now = timezone.now()
    with transaction.atomic():
        record = (
            ChannelOutboundMessageRecord.objects
            .select_for_update(skip_locked=True)
            .filter(id=outbox_id)
            .first()
        )
        if record is None or record.status == "sent":
            return 0
        if record.status != "pending":
            return 0
        if record.next_retry_at and record.next_retry_at > now:
            return 0
        updated = ChannelOutboundMessageRecord.objects.filter(
            id=record.id,
            status="pending",
        ).filter(
            Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now),
        ).update(status="dispatched")
        if updated == 0:
            return 0
        record.status = "dispatched"

    return 1 if _deliver_claimed_record(record) else 0


@shared_task(
    name="channel_gateway.deliver_outbox_sweep",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
    queue="realtime_delivery",
)
def deliver_outbox_sweep(limit: int = 100) -> int:
    """Pull pending outbox records and deliver them via channel adapters.

    Runs as fallback sweep via beat. For each pending record, looks up the
    adapter, calls ``send_text`` / ``send_media``, and marks the record
    as sent or failed.
    """
    from django.db import transaction
    from django.db.models import Q
    from django.utils import timezone

    from apps.channel_gateway.models import ChannelOutboundMessageRecord

    now = timezone.now()
    with transaction.atomic():
        records = list(
            ChannelOutboundMessageRecord.objects
            .select_for_update(skip_locked=True)
            .filter(status="pending")
            .filter(Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now))
            .order_by("created_at")[:limit]
        )
        # 在事务内标记为 dispatched，防止其他 Worker 重复抢取
        if records:
            ChannelOutboundMessageRecord.objects.filter(
                id__in=[r.id for r in records],
            ).update(status="dispatched")
            for r in records:
                r.status = "dispatched"

    return sum(1 for record in records if _deliver_claimed_record(record))


@shared_task(
    name="channel_gateway.deliver_outbox",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
    queue="realtime_delivery",
)
def deliver_outbox(limit: int = 100) -> int:
    """Legacy task name wrapper. New schedules use ``deliver_outbox_sweep``."""
    return deliver_outbox_sweep(limit=limit)


def _deliver_claimed_record(record) -> bool:
    from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
    from apps.channel_gateway.models import ChannelAccount

    adapter = ChannelAdapterRegistry.get(record.channel)
    if not adapter:
        logger.warning(
            "[deliver_outbox] no adapter for channel=%s, failing outbox %s",
            record.channel,
            record.id,
        )
        _mark_failed(record, f"no adapter registered for channel '{record.channel}'")
        return False

    account = ChannelAccount.objects.filter(
        channel=record.channel,
        account_id=record.account_id,
        organization_id=record.organization_id,
        enabled=True,
    ).first()
    if not account:
        logger.warning(
            "[deliver_outbox] account not found for %s/%s/%s",
            record.channel,
            record.account_id,
            record.organization_id,
        )
        _mark_failed(record, "channel account not found or disabled")
        return False

    payload = record.payload or {}
    inner = payload.get("payload") or payload
    text = inner.get("text") or ""
    media_list = inner.get("media") or []
    to = payload.get("to") or record.peer_id
    if not to:
        _mark_failed(record, "missing destination (to)")
        return False

    reply_to = inner.get("reply_to") or payload.get("reply_to")
    thread_id = payload.get("thread_id")

    result = _deliver_single(
        adapter, account, to, text, media_list,
        reply_to=reply_to, thread_id=thread_id,
    )

    outbound_svc = ChannelOutboundService()
    if result.ok:
        outbound_svc.mark_delivered(record, provider_message_id=result.provider_message_id)
        return True
    outbound_svc.mark_send_failed(record, result.error or "delivery failed")
    return False




def _deliver_single(adapter, account, to: str, text: str, media_list: list,
                    *, reply_to=None, thread_id=None):
    """Send a single outbound record — handles text-only, media-only, and mixed.

    Strategy:
    - Text only → send_text
    - Single media → send_media with text as caption
    - Multiple media → send each media, then send remaining text separately
    - No text and no media → error
    """
    from apps.channel_gateway.adapters.base import SendResult

    def _safe_result(r):
        """run_adapter_coro 在 ThreadPool 失败时返回 None，需防护。"""
        if r is None:
            return SendResult(ok=False, error="adapter call failed or timed out")
        return r

    has_text = bool(text and text.strip())
    if not isinstance(media_list, list):
        media_list = []
    has_media = bool(media_list)

    if not has_text and not has_media:
        return SendResult(ok=False, error="empty payload: no text or media")

    if not has_media:
        return _safe_result(run_adapter_coro(
            adapter.send_text(account, to, text, reply_to=reply_to, thread_id=thread_id)
        ))

    last_result = SendResult(ok=True)
    caption_used = False
    sent_count = 0

    for i, media in enumerate(media_list):
        if not isinstance(media, dict):
            continue
        media_url = media.get("url") or media.get("file_id") or ""
        if not media_url:
            continue
        caption = None
        if has_text and i == 0 and len(media_list) == 1:
            caption = text
            caption_used = True
        result = _safe_result(run_adapter_coro(adapter.send_media(
            account, to, media_url,
            caption=caption,
            mime_type=media.get("mime_type"),
            reply_to=reply_to,
            thread_id=thread_id,
        )))
        if not result.ok:
            return result
        last_result = result
        sent_count += 1

    if sent_count == 0 and not has_text:
        return SendResult(ok=False, error="no valid media in payload")

    if has_text and not caption_used:
        result = _safe_result(run_adapter_coro(
            adapter.send_text(account, to, text, reply_to=reply_to, thread_id=thread_id)
        ))
        if not result.ok:
            return result
        last_result = result

    return last_result


def _mark_failed(record, error: str) -> None:
    from django.utils import timezone

    record.status = "failed"
    record.last_error = error
    record.next_retry_at = None
    record.updated_at = timezone.now()
    record.save(update_fields=["status", "last_error", "next_retry_at", "updated_at"])


@shared_task(
    name="channel_gateway.dispatch_agent_reply",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
    queue="heavy",
)
def dispatch_agent_reply(binding_id: str, data_dict: dict, message_text: str) -> None:
    """Stage-2 of inbound processing: call LLM and publish outbound reply.

    Separated from the fast inbound task so that LLM latency doesn't block
    the inbound worker or trigger premature SIGKILL.
    """
    from apps.channel_gateway.models import ChannelBinding
    from apps.channel_gateway.schemas import (
        ChannelInboundMessage,
        ChannelOutboundMessage,
        ChannelOutboundPayload,
    )
    from apps.channel_gateway.services.identity_context import normalize_channel_context_value
    from apps.channel_gateway.services.outbound_service import ChannelOutboundService
    from apps.i18n import get_text as _

    binding = ChannelBinding.objects.filter(id=binding_id).first()
    if not binding:
        logger.warning("[dispatch_agent_reply] binding not found: %s", binding_id)
        return

    try:
        data = ChannelInboundMessage(**data_dict)
    except Exception as exc:
        logger.error("[dispatch_agent_reply] parse error: %s", exc, exc_info=True)
        return

    # DS-018: per-peer 频率限制，防止恶意用户持续消耗 Owner LLM 额度
    if _is_rate_limited(data):
        logger.warning(
            "[dispatch_agent_reply] DS-018: rate limited peer=%s channel=%s",
            data.peer_id, data.channel,
        )
        return

    _try_send_typing_before_llm(data)

    reply = _call_llm(binding, data, message_text)
    if not reply:
        reply = _("agent.generation_failed")

    if not reply.strip():
        return

    # DS-015: 脱敏 HITL 回复，防止内部数据结构泄露给外部用户
    reply = _sanitize_reply_for_channel(reply)

    account_id = (data.account_id or "default").strip() or "default"
    payload = ChannelOutboundPayload(text=reply, media=None, reply_to=None, metadata=None)
    outbound_space_id = normalize_channel_context_value(
        getattr(binding, "effective_handling_space_id", None)
        or getattr(binding, "space_id", None)
    ) or None
    outbound_execution_agent_id = normalize_channel_context_value(
        getattr(binding, "effective_execution_agent_id", None)
    ) or None
    outbound = ChannelOutboundMessage(
        schema_version=data.schema_version,
        type="channel.outbound",
        channel=data.channel,
        account_id=account_id,
        organization_id=data.organization_id,
        identity_user_id=normalize_channel_context_value(getattr(binding, "identity_user_id", "")) or None,
        execution_agent_id=outbound_execution_agent_id,
        handling_space_id=normalize_channel_context_value(getattr(binding, "handling_space_id", "") or getattr(binding, "space_id", "")) or None,
        space_id=outbound_space_id,
        session_id=str(binding.session_id) if binding.session_id else None,
        thread_id=binding.thread_id,
        to=data.peer_id.strip(),
        message_id=None,
        idempotency_key=data.message_id,
        payload=payload,
    )
    ChannelOutboundService().publish(outbound)


def _sanitize_reply_for_channel(reply: str) -> str:
    """DS-015: 移除 HITL 标记和内部数据结构，替换为通用提示。"""
    if _HITL_PATTERN.search(reply):
        return (
            "This operation requires review and cannot be completed "
            "through this channel. Please use the TabTin app directly."
        )
    return reply


def _is_rate_limited(data) -> bool:
    """DS-018: per-peer sliding-window 频率限制。"""
    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        organization_id = getattr(data, "organization_id", "")
        key = f"{_RATE_LIMIT_KEY_PREFIX}{data.channel}:{organization_id}:{data.peer_id}"
        count = redis_client.incr(key)
        if count == 1:
            redis_client.expire(key, CHANNEL_RATE_LIMIT_WINDOW)
        return count > CHANNEL_RATE_LIMIT_MAX_REQUESTS
    except Exception:
        return False


def _try_send_typing_before_llm(data) -> None:
    """Best-effort: send a typing indicator before LLM call to give the user
    immediate feedback that the bot is processing their message."""
    try:
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
        from apps.channel_gateway.models import ChannelAccount

        adapter = ChannelAdapterRegistry.get(data.channel)
        if not adapter:
            return

        account_id = (data.account_id or "default").strip() or "default"
        account = ChannelAccount.objects.filter(
            channel=data.channel,
            account_id=account_id,
            organization_id=data.organization_id,
            enabled=True,
        ).first()
        if not account:
            return

        run_adapter_coro(adapter.send_typing(account, data.peer_id.strip()))
    except Exception:
        pass


def _call_llm(binding, data, message_text: str):
    """Invoke LLM via ChatService — extracted for testability.

    CD-008: 传递 channel_sender_id 让 Agent 感知真实发送者
    CD-009: client_type="channel" + cautious 预设，隔离外部来源权限
    DS-016: 传递 source_channel / source_sender_id 用于审计区分
    DS-018: 使用 task profile 限制 max_iterations
    """
    from apps.chat.conversation.models import ChatSession
    from apps.services.remote_agent import RemoteAgentDispatcher
    from apps.channel_gateway.services.identity_context import (
        resolve_channel_identity_user,
        resolve_channel_runtime_identity_context,
    )

    session = ChatSession.objects.select_related("user").filter(id=binding.session_id).first()
    if not session:
        logger.warning("[dispatch_agent_reply] session missing: %s", binding.session_id)
        return None

    from apps.channel_gateway.services.inbound_service import ChannelInboundService

    meta = data.metadata or {}
    raw_sender = (
        meta.get("sender_username")
        or meta.get("sender_name")
        or data.sender_id
    )
    sender_display = ChannelInboundService.sanitize_sender_name(raw_sender)
    identity_context = resolve_channel_runtime_identity_context(
        organization_id=str(getattr(binding, "organization_id", "") or getattr(data, "organization_id", "")),
        binding=binding,
        session=session,
    )
    if not identity_context.identity_user_id:
        logger.warning("[dispatch_agent_reply] binding missing identity_user_id: %s", getattr(binding, "id", ""))
        return None

    session_user_id = str(
        getattr(session, "user_id", "")
        or getattr(getattr(session, "user", None), "id", "")
        or ""
    ).strip()
    if session_user_id and session_user_id == identity_context.identity_user_id and getattr(session, "user", None) is not None:
        identity_user = session.user
    else:
        try:
            identity_user = resolve_channel_identity_user(
                organization_id=str(getattr(binding, "organization_id", "") or getattr(data, "organization_id", "")),
                identity_user_id=identity_context.identity_user_id,
            )
        except ValueError as exc:
            logger.warning(
                "[dispatch_agent_reply] invalid identity binding=%s user=%s reason=%s",
                getattr(binding, "id", ""),
                identity_context.identity_user_id,
                exc,
            )
            return None

    app_context = {
        "channel_sender_id": data.sender_id,
        "channel_sender_name": sender_display,
        "channel_name": data.channel,
        "channel_peer_kind": data.peer_kind,
        # DS-016: 标准化审计字段，使 downstream 可区分 Owner 主动操作和外部触发
        "source_channel": data.channel,
        "source_sender_id": data.sender_id,
        "source_type": "channel_bot",
        # DS-018: 限制 Channel Bot 最大迭代次数
        "channel_max_iterations": CHANNEL_AGENT_MAX_ITERATIONS,
        "identity_user_id": identity_context.identity_user_id,
        "execution_agent_id": identity_context.execution_agent_id,
        "handling_space_id": identity_context.handling_space_id,
        "current_space_id": identity_context.handling_space_id,
    }
    # 仅保留显式渠道路由的执行 Agent；不再从 identity 默认推导默认执行者。
    if identity_context.execution_agent_id:
        app_context["_execution_agent_id"] = identity_context.execution_agent_id

    try:
        result = RemoteAgentDispatcher.send_message_sync(
            session_id=str(session.id),
            user=identity_user,
            message=message_text,
            model_id=None,
            client_type="channel",
            execution_profile="task",
            app_context=app_context,
        )
        if not isinstance(result, dict):
            return None

        # W13 修复（L1+L2）：当 Dispatcher 返回 error_category 时，
        # 必须用对外用户友好的话术，绝不能把 "当前设备 X 不在线，请打开
        # 客户端后重试" 这种内部运维语暴露给飞书/微信外部用户。
        # 真实失败原因写到日志供运维排障。
        error_category = result.get("error_category")
        if error_category:
            logger.warning(
                "[dispatch_agent_reply] dispatcher error: channel=%s peer=%s "
                "session=%s category=%s message=%s",
                getattr(data, "channel", ""),
                getattr(data, "peer_id", ""),
                getattr(session, "id", ""),
                error_category,
                result.get("error_message") or "",
            )
            return _user_friendly_dispatcher_error_reply(
                error_category=error_category,
            )
        return result.get("reply")
    except Exception as exc:
        logger.error("[dispatch_agent_reply] LLM call failed: %s", exc, exc_info=True)
        return None


def _user_friendly_dispatcher_error_reply(*, error_category: str) -> str:
    """把 Dispatcher 错误码映射成对外用户能看懂的话术。

    原则：避免任何"客户端 / 设备 / 重试"等技术词汇——这些是发给飞书/微信
    外部用户的回复，他们对 TabTin 的内部架构没有任何概念。
    """
    if error_category in ("device_offline", "device_unreachable", "device_dropped"):
        return "AI 助手暂时不可用，请稍后再试。"
    if error_category == "remote_agent_timeout":
        return "AI 助手处理超时，请稍后再试。"
    if error_category == "runtime_failed":
        return "AI 助手处理时出现异常，请稍后再试。"
    return "AI 助手暂时无法回复，请稍后再试。"


DEBOUNCE_WINDOW_SECONDS = 2
DEBOUNCE_KEY_PREFIX = "ch_debounce:"


@shared_task(name="channel_gateway.process_inbound", ignore_result=True, time_limit=30, soft_time_limit=25)
def process_inbound_message(data_dict: dict) -> None:
    """Process a single inbound message, with debounce for rapid-fire senders.

    When multiple messages arrive within ``DEBOUNCE_WINDOW_SECONDS`` from the
    same peer, subsequent messages are buffered in Redis and a delayed task
    flushes them as a single combined text — avoiding N separate agent calls.
    """
    from apps.channel_gateway.schemas import ChannelInboundMessage
    from apps.channel_gateway.services.inbound_service import ChannelInboundService

    try:
        data = ChannelInboundMessage(**data_dict)
    except Exception as exc:
        logger.error("[process_inbound] parse error: %s", exc, exc_info=True)
        return

    debounce_key = (
        f"{DEBOUNCE_KEY_PREFIX}{data.channel}:{data.account_id}:{data.peer_id}"
    )

    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")

        buf_key = f"{debounce_key}:buf"
        lock_key = f"{debounce_key}:lock"

        is_first = redis_client.set(lock_key, "1", nx=True, ex=DEBOUNCE_WINDOW_SECONDS)
        if is_first:
            ChannelInboundService().handle_inbound(data)
            _flush_debounce_buffer(redis_client, buf_key, data)
        else:
            meta = data.metadata or {}
            buf_entry = json.dumps({
                "text": data.text or "",
                "sender_id": data.sender_id,
                "sender_name": meta.get("sender_username") or meta.get("sender_name") or "",
            }, ensure_ascii=False)
            redis_client.rpush(buf_key, buf_entry)
            redis_client.expire(buf_key, DEBOUNCE_WINDOW_SECONDS + 5)
            flush_scheduled_key = f"{debounce_key}:flush_scheduled"
            if redis_client.set(flush_scheduled_key, "1", nx=True, ex=DEBOUNCE_WINDOW_SECONDS + 2):
                flush_debounce_buffer.apply_async(
                    args=[data_dict],
                    countdown=DEBOUNCE_WINDOW_SECONDS,
                )
    except Exception:
        ChannelInboundService().handle_inbound(data)


def _flush_debounce_buffer(redis_client, buf_key: str, data) -> None:
    """Pop any buffered texts and send them as a combined follow-up.

    Buffer entries are JSON with ``sender_id``, ``sender_name``, and ``text``
    so that messages from different senders retain attribution.
    """
    entries: list[dict] = []
    while True:
        raw = redis_client.lpop(buf_key)
        if raw is None:
            break
        decoded = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        if not decoded.strip():
            continue
        try:
            entry = json.loads(decoded)
        except (json.JSONDecodeError, TypeError):
            entry = {"text": decoded, "sender_id": "", "sender_name": ""}
        if entry.get("text", "").strip():
            entries.append(entry)
    if not entries:
        return

    from apps.channel_gateway.services.inbound_service import ChannelInboundService

    is_group = getattr(data, "peer_kind", None) == "group"
    lines: list[str] = []
    for entry in entries:
        text = entry["text"].strip()
        if is_group and entry.get("sender_id"):
            raw_sender = entry.get("sender_name") or entry["sender_id"]
            sender = ChannelInboundService.sanitize_sender_name(raw_sender)
            text = f"[{sender}]: {text}"
        lines.append(text)

    combined_text = "\n".join(lines)
    combined = data.model_copy(update={
        "text": combined_text,
        "message_id": f"{data.message_id}_merged",
        "media": None,
    })
    try:
        ChannelInboundService().handle_inbound(combined)
    except Exception as exc:
        logger.error("[flush_debounce] error: %s", exc, exc_info=True)


@shared_task(name="channel_gateway.flush_debounce", ignore_result=True, time_limit=15, soft_time_limit=12)
def flush_debounce_buffer(data_dict: dict) -> None:
    """Delayed task to flush accumulated debounce buffer."""
    from apps.channel_gateway.schemas import ChannelInboundMessage

    try:
        data = ChannelInboundMessage(**data_dict)
    except Exception:
        return

    debounce_key = (
        f"{DEBOUNCE_KEY_PREFIX}{data.channel}:{data.account_id}:{data.peer_id}"
    )
    buf_key = f"{debounce_key}:buf"

    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        _flush_debounce_buffer(redis_client, buf_key, data)
    except Exception as exc:
        logger.error("[flush_debounce] redis error: %s", exc)


@shared_task(name="channel_gateway.channel_poll", ignore_result=True, time_limit=60, soft_time_limit=50, queue="realtime_delivery")
def channel_poll() -> int:
    """Poll all channels that support polling and dispatch inbound messages.

    Discovers adapters with ``capabilities.supports_polling`` dynamically
    from the registry.  Uses per-channel Redis locks to prevent concurrent
    polls from conflicting.
    """
    from django_redis import get_redis_connection
    from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
    from apps.channel_gateway.models import ChannelAccount, ChannelRuntimeStatus

    redis_client = get_redis_connection("default")
    total = 0

    for adapter in ChannelAdapterRegistry.list_all():
        if not adapter.capabilities.supports_polling:
            continue

        channel_id = adapter.id
        lock_key = f"channel_gateway:{channel_id}_poll:lock"
        if not redis_client.set(lock_key, "1", nx=True, ex=65):
            continue

        try:
            total += _poll_channel(adapter, channel_id, redis_client)
        finally:
            redis_client.delete(lock_key)

    return total


def _poll_channel(adapter, channel_id: str, redis_client) -> int:
    """Poll a single channel for all its polling-mode accounts."""
    from apps.channel_gateway.models import ChannelAccount, ChannelRuntimeStatus

    accounts = ChannelAccount.objects.filter(
        channel=channel_id,
        enabled=True,
    )
    polling_accounts = [
        a for a in accounts
        if (a.config or {}).get("mode") == "polling"
    ]
    if not polling_accounts:
        return 0

    total = 0
    for account in polling_accounts:
        status_obj, _ = ChannelRuntimeStatus.objects.get_or_create(
            channel=channel_id,
            account_id=account.account_id,
            organization_id=account.organization_id,
            defaults={"status": "running", "details": {}},
        )
        offset = (status_obj.details or {}).get("poll_offset", 0)

        try:
            result = run_adapter_coro(
                adapter.poll_updates(account, offset=offset, timeout=2)
            )
            if result is None:
                continue
            messages, new_offset = result
        except Exception as exc:
            logger.error(
                "[channel_poll] %s poll error for %s: %s",
                channel_id,
                account.account_id,
                exc,
            )
            continue

        if new_offset != offset:
            details = dict(status_obj.details or {})
            details["poll_offset"] = new_offset
            status_obj.details = details
            status_obj.status = "running"
            status_obj.save(update_fields=["details", "status", "updated_at"])

        for msg in messages:
            try:
                process_inbound_message.delay(msg.model_dump())
                total += 1
            except Exception as exc:
                logger.error("[channel_poll] dispatch error: %s", exc)

    return total


_CLEANUP_BATCH_SIZE = 2000


@shared_task(name="channel_gateway.cleanup_old_records", ignore_result=True, time_limit=600, soft_time_limit=560)
def cleanup_old_records(
    inbound_days: int = 7,
    outbox_days: int = 30,
) -> dict:
    """Purge stale inbound logs and completed outbox records (batch delete)."""
    from django.utils import timezone
    from apps.channel_gateway.models import ChannelInboundMessageLog, ChannelOutboundMessageRecord

    now = timezone.now()

    inbound_deleted = 0
    inbound_cutoff = now - timedelta(days=inbound_days)
    while True:
        ids = list(
            ChannelInboundMessageLog.objects
            .filter(received_at__lt=inbound_cutoff)
            .values_list("id", flat=True)[:_CLEANUP_BATCH_SIZE]
        )
        if not ids:
            break
        deleted, _ = ChannelInboundMessageLog.objects.filter(id__in=ids).delete()
        inbound_deleted += deleted

    outbox_deleted = 0
    outbox_cutoff = now - timedelta(days=outbox_days)
    while True:
        ids = list(
            ChannelOutboundMessageRecord.objects
            .filter(status__in=["sent", "failed"], created_at__lt=outbox_cutoff)
            .values_list("id", flat=True)[:_CLEANUP_BATCH_SIZE]
        )
        if not ids:
            break
        deleted, _ = ChannelOutboundMessageRecord.objects.filter(id__in=ids).delete()
        outbox_deleted += deleted

    if inbound_deleted or outbox_deleted:
        logger.info(
            "[cleanup] deleted %d inbound logs, %d outbox records",
            inbound_deleted, outbox_deleted,
        )
    return {"inbound_deleted": inbound_deleted, "outbox_deleted": outbox_deleted}


@shared_task(name="channel_gateway.probe_longpoll_accounts", ignore_result=True, time_limit=120, soft_time_limit=100)
def probe_longpoll_accounts() -> int:
    """定期检测长轮询渠道账号的 token 有效性。

    每 6 小时执行一次，对所有启用的 weixin_personal 账号调用 getConfig 验证 token。
    发现过期则标记 auth_expired，避免用户长时间不知情。
    """
    from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
    from apps.channel_gateway.models import ChannelAccount
    from apps.channel_gateway.services.weixin_auth_service import WeixinAuthService

    adapter = ChannelAdapterRegistry.get("weixin_personal")
    if not adapter:
        logger.info("[probe_longpoll] weixin_personal adapter not registered, skipping")
        return 0

    accounts = ChannelAccount.objects.filter(channel="weixin_personal", enabled=True)
    expired_count = 0

    for account in accounts:
        try:
            result = run_adapter_coro(adapter.probe(account))
            if result is None:
                logger.warning("[probe_longpoll] probe returned None for account=%s", account.account_id)
                continue
            if not result.ok and result.error and "过期" in result.error:
                logger.warning(
                    "[probe_longpoll] token expired for account=%s organization=%s: %s",
                    account.account_id, account.organization_id, result.error,
                )
                WeixinAuthService.mark_session_expired(account)
                expired_count += 1
            elif not result.ok:
                logger.warning(
                    "[probe_longpoll] probe failed (non-expiry) for account=%s: %s",
                    account.account_id, result.error,
                )
        except Exception as exc:
            logger.error(
                "[probe_longpoll] unexpected error probing account=%s: %s",
                account.account_id, exc, exc_info=True,
            )

    if expired_count:
        logger.info("[probe_longpoll] marked %d account(s) as auth_expired", expired_count)
    return expired_count
