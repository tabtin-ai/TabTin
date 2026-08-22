"""PG 持久化失败的 Redis 兜底 state 回写任务。

扫描 state:fallback:* 键，尝试逐个回写 PG，成功后删除 Redis 键。
每 5 分钟运行一次，单次最多处理 500 个键。
"""

import json
import logging

from celery import shared_task
from celery.schedules import crontab

logger = logging.getLogger(__name__)

_SCAN_BATCH_SIZE = 100
_MAX_RECOVER_PER_RUN = 500


@shared_task(
    bind=True,
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def recover_fallback_states(self):
    """扫描 state:fallback:* 键，尝试回写 PG，成功则删除 Redis 键。"""
    from celery.exceptions import SoftTimeLimitExceeded
    from apps.services.agent_engine.persistence.conversation_store import (
        ConversationStore,
        FALLBACK_KEY_PREFIX,
        validate_messages,
    )

    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
    except Exception as exc:
        logger.warning("[FallbackRecovery] Redis unavailable: %s", exc)
        return {"success": False, "error": str(exc)}

    recovered = 0
    failed = 0
    pattern = f"{FALLBACK_KEY_PREFIX}*"
    cursor = 0

    try:
        while recovered + failed < _MAX_RECOVER_PER_RUN:
            cursor, keys = redis_client.scan(
                cursor, match=pattern, count=_SCAN_BATCH_SIZE,
            )
            for key in keys:
                key_str = key.decode("utf-8") if isinstance(key, bytes) else key
                thread_id = key_str[len(FALLBACK_KEY_PREFIX):]
                try:
                    raw = redis_client.get(key)
                    if not raw:
                        redis_client.delete(key)
                        continue

                    data = json.loads(raw)
                    state = dict(data.get("state_json", {}))
                    state["messages"] = validate_messages(
                        data.get("messages_json", []), thread_id,
                    )
                    state["thread_id"] = thread_id

                    ConversationStore.save_state(thread_id, state)
                    redis_client.delete(key)
                    recovered += 1
                    logger.info(
                        "[FallbackRecovery] Recovered: thread=%s", thread_id,
                    )
                except Exception as exc:
                    failed += 1
                    logger.warning(
                        "[FallbackRecovery] Recovery failed: thread=%s: %s",
                        thread_id, exc,
                    )

            if cursor == 0:
                break
    except SoftTimeLimitExceeded:
        logger.warning(
            "[FallbackRecovery] Interrupted by SoftTimeLimitExceeded: "
            "recovered=%d failed=%d",
            recovered, failed,
        )
        return {"success": True, "recovered": recovered, "failed": failed, "interrupted": True}

    if recovered or failed:
        logger.info(
            "[FallbackRecovery] Completed: recovered=%d failed=%d",
            recovered, failed,
        )
    return {"success": True, "recovered": recovered, "failed": failed}


STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE = {
    "recover-fallback-states": {
        "task": "apps.services.agent_engine.tasks.cleanup.state_fallback_recovery.recover_fallback_states",
        "schedule": crontab(minute="*/5"),
        "options": {"expires": 300},
    },
}
