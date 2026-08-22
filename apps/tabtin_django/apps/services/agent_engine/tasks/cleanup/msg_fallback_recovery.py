"""MySQL 助手消息 Redis 兜底回写任务。

扫描 msg:fallback:* 键，尝试逐个回写 MySQL ChatMessage，成功后删除 Redis 键。
回写失败时续命 TTL 防止数据在 MySQL 恢复前过期。
"""

import json
import logging

from celery import shared_task
from celery.schedules import crontab

logger = logging.getLogger(__name__)

_MSG_FALLBACK_PREFIX = "msg:fallback:"
_SCAN_BATCH_SIZE = 100
_MAX_RECOVER_PER_RUN = 200
_FALLBACK_TTL_SECONDS = 86400
_RENEW_TTL_SECONDS = 43200


@shared_task(
    bind=True,
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
)
def recover_msg_fallback_states(self):
    from celery.exceptions import SoftTimeLimitExceeded

    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
    except Exception as exc:
        logger.warning("[MsgFallbackRecovery] Redis unavailable: %s", exc)
        return {"success": False, "error": str(exc)}

    recovered = 0
    failed = 0
    cursor = 0

    try:
        while recovered + failed < _MAX_RECOVER_PER_RUN:
            cursor, keys = redis_client.scan(
                cursor, match=f"{_MSG_FALLBACK_PREFIX}*", count=_SCAN_BATCH_SIZE,
            )
            for key in keys:
                key_str = key.decode("utf-8") if isinstance(key, bytes) else key
                try:
                    raw = redis_client.get(key)
                    if not raw:
                        redis_client.delete(key)
                        continue

                    data = json.loads(raw)
                    from apps.chat.conversation.models import ChatMessage

                    # W3 §3.3.1：字段重命名
                    # content → text_summary；blocks_json → content_blocks_json；
                    # agent_type / intent → 进 metadata（顶层字段已 drop）
                    metadata_payload = dict(data.get("metadata") or {})
                    if data.get("agent_type"):
                        metadata_payload.setdefault("agent_type", data["agent_type"])
                    if data.get("intent"):
                        metadata_payload.setdefault("intent", data["intent"])

                    create_kwargs = {
                        "session_id": data["session_id"],
                        "role": data.get("role", "assistant"),
                        "text_summary": (data.get("content") or "")[:200],
                        "agent_run_id": data.get("agent_run_id", ""),
                        "sender_user_id": data.get("sender_user_id", ""),
                        "metadata": metadata_payload if metadata_payload else None,
                    }
                    if data.get("model_id"):
                        create_kwargs["model_id"] = data["model_id"]
                    if data.get("blocks_json"):
                        create_kwargs["content_blocks_json"] = data["blocks_json"]
                    elif data.get("content_blocks_json"):
                        create_kwargs["content_blocks_json"] = data["content_blocks_json"]
                    if data.get("trace_id"):
                        create_kwargs["trace_id"] = data["trace_id"]
                    # W3 新顶层字段透传
                    for new_field in ("stop_reason", "subagent_run_id", "model_name_snapshot",
                                      "usage_json", "error_info_json"):
                        if data.get(new_field):
                            create_kwargs[new_field] = data[new_field]

                    # 幂等键：W3 用 client_event_id（如果有），否则保留旧 (session_id, agent_run_id) 兜底
                    if data.get("client_event_id"):
                        ChatMessage.objects.get_or_create(
                            session_id=data["session_id"],
                            client_event_id=data["client_event_id"],
                            defaults=create_kwargs,
                        )
                    else:
                        ChatMessage.objects.get_or_create(
                            session_id=data["session_id"],
                            agent_run_id=data.get("agent_run_id", ""),
                            defaults=create_kwargs,
                        )
                    redis_client.delete(key)
                    recovered += 1
                    logger.info("[MsgFallbackRecovery] Recovered: key=%s", key_str)
                except Exception as exc:
                    failed += 1
                    try:
                        redis_client.expire(key, _RENEW_TTL_SECONDS)
                    except Exception:
                        pass  # defensive: 续期 Redis key TTL 失败，依赖原有过期策略
                    logger.warning(
                        "[MsgFallbackRecovery] Failed (TTL renewed): key=%s: %s",
                        key_str, exc,
                    )

            if cursor == 0:
                break
    except SoftTimeLimitExceeded:
        logger.warning(
            "[MsgFallbackRecovery] Interrupted: recovered=%d failed=%d",
            recovered, failed,
        )

    if failed >= 10:
        logger.error(
            "[MsgFallbackRecovery] HIGH FAILURE RATE: recovered=%d failed=%d — "
            "MySQL may be down, check database connectivity",
            recovered, failed,
        )

    if recovered or failed:
        logger.info(
            "[MsgFallbackRecovery] Done: recovered=%d failed=%d", recovered, failed,
        )
    return {"success": True, "recovered": recovered, "failed": failed}


MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE = {
    "recover-msg-fallback-states": {
        "task": "apps.services.agent_engine.tasks.cleanup.msg_fallback_recovery.recover_msg_fallback_states",
        "schedule": crontab(minute="*/5"),
        "options": {"expires": 300},
    },
}
