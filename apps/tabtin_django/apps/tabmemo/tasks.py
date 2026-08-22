"""
TabMemo Celery 异步任务

目前仅包含 AI 自动打标任务。
"""

from __future__ import annotations

import json
import logging
import re
import uuid as _uuid_mod
from datetime import timedelta

from celery import shared_task
from celery.exceptions import MaxRetriesExceededError, Retry, SoftTimeLimitExceeded
from celery.schedules import crontab
from django.utils import timezone

from apps.tabmemo.constants import TABMEMO_DB

logger = logging.getLogger(__name__)

MIN_CONTENT_LENGTH = 30
TRASH_RETENTION_DAYS = 30

# 幂等锁超时必须 > time_limit(120s)，防止任务超时后锁提前释放导致并发重入
_IDEMPOTENCY_LOCK_TTL = 150

def auto_tag_lock_key(memo_id: str) -> str:
    """统一的 auto_tag 幂等锁 key，供 tasks.py 和 memo_service.py 共用。"""
    return f"tabmemo:auto_tag:lock:{memo_id}"


@shared_task(
    name="tabmemo.auto_tag_memo",
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    time_limit=120,
    soft_time_limit=100,
    queue="heavy",
    ignore_result=True,
)
def auto_tag_memo(self, memo_id: str) -> dict:
    """异步为碎片笔记生成 AI 标签。幂等：重复调用只覆盖 ai_tags。"""
    from django.core.cache import cache
    from apps.tabmemo.models import Memo

    lock_key = auto_tag_lock_key(memo_id)
    if not cache.add(lock_key, "1", _IDEMPOTENCY_LOCK_TTL):
        logger.info("[auto_tag] memo %s 已有任务在执行，跳过", memo_id)
        return {"skipped": True, "reason": "already_running"}

    # P0-2: 初始化 raw，防止 JSONDecodeError 分支引用未定义变量
    raw = None

    try:
        try:
            memo = Memo.objects.using(TABMEMO_DB).get(id=memo_id)
        except Memo.DoesNotExist:
            logger.warning("[auto_tag] memo %s 不存在，跳过", memo_id)
            return {"skipped": True, "reason": "not_found"}

        content = (memo.content_plaintext or memo.content_markdown or "").strip()
        if len(content) < MIN_CONTENT_LENGTH:
            logger.info("[auto_tag] memo %s 内容过短 (%d 字)，跳过", memo_id, len(content))
            return {"skipped": True, "reason": "too_short"}

        truncated = content[:2000]

        _memo_uid = str(memo.created_by_id or getattr(memo, "owner_id", "") or "")
        _memo_wid = str(getattr(memo, "organization_id", "") or "")
        if not _memo_wid:
            logger.warning("[auto_tag] memo %s organization_id 为空，跳过 AI 标签以防计费缺口", memo_id)
            return {"skipped": True, "reason": "missing_organization_id"}

        from apps.services.llm.services.chat import unified_llm_call

        try:
            llm_result = unified_llm_call(
                scene_key="memo_generation",
                variables={"content": truncated},
                user_id=_memo_uid,
                organization_id=_memo_wid,
            )
        except Exception as call_exc:
            logger.warning("[auto_tag] memo %s LLM 调用未成功: %s", memo_id, call_exc)
            raise self.retry(
                exc=RuntimeError(f"LLM 调用未成功 (memo={memo_id})"),
                countdown=60,
            )

        raw = llm_result.content.strip()
        # BI-30: strip triple-backtick fences (with optional language tag like ```json)
        raw = re.sub(r"^```\w*\s*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)
        raw = raw.strip()

        tags = json.loads(raw)
        if not isinstance(tags, list):
            raise ValueError(f"Expected list, got {type(tags)}")
        tags = [str(t).strip() for t in tags if isinstance(t, str) and 1 <= len(str(t).strip()) <= 20][:5]

        if not tags:
            logger.info("[auto_tag] memo %s LLM 返回空标签列表", memo_id)
            return {"success": True, "memo_id": memo_id, "ai_tags": []}

        # /#2678：合并去重而非整包覆盖。capture.py 写入的
        # emotion:* 等前缀标签已存在于 ai_tags，整包赋值 ``memo.ai_tags = tags``
        # 会冲掉它们。这里把已有标签保留在前、LLM 新生成标签去重追加在后
        # （dict.fromkeys 保序去重），既保留 capture 语义标签又不重复堆积。
        merged_tags = list(dict.fromkeys([*(memo.ai_tags or []), *tags]))
        memo.ai_tags = merged_tags
        memo.save(using=TABMEMO_DB, update_fields=["ai_tags", "updated_at"])

        from apps.tabmemo.search import refresh_search_vector
        refresh_search_vector(memo)

        logger.info("[auto_tag] memo %s 打标完成: %s", memo_id, merged_tags)
        return {"success": True, "memo_id": memo_id, "ai_tags": merged_tags}

    # Retry 异常必须透传，不能被 except Exception 捕获
    except Retry:
        raise
    except SoftTimeLimitExceeded:
        logger.warning("[auto_tag] memo %s 软超时，重试", memo_id)
        try:
            raise self.retry(exc=SoftTimeLimitExceeded(), countdown=10)
        except MaxRetriesExceededError:
            logger.error(
                "[auto_tag] memo %s 软超时重试耗尽",
                memo_id,
                extra={
                    "memo_id": memo_id,
                    "max_retries": self.max_retries,
                    "alert": "tabmemo_retag_exhausted",
                },
            )
            return {"skipped": True, "reason": "max_retries_exceeded"}
    except MaxRetriesExceededError:
        logger.error(
            "[auto_tag] memo %s 重试耗尽，最终失败",
            memo_id,
            extra={
                "memo_id": memo_id,
                "max_retries": self.max_retries,
                "alert": "tabmemo_retag_exhausted",
            },
        )
        return {"skipped": True, "reason": "max_retries_exceeded"}
    except json.JSONDecodeError as exc:
        logger.warning("[auto_tag] memo %s JSON 解析失败: %s, raw=%s", memo_id, exc, (raw or "")[:200])
        try:
            raise self.retry(exc=exc)
        except MaxRetriesExceededError:
            logger.error(
                "[auto_tag] memo %s JSON 解析重试耗尽",
                memo_id,
                extra={
                    "memo_id": memo_id,
                    "max_retries": self.max_retries,
                    "last_error": str(exc),
                    "alert": "tabmemo_retag_exhausted",
                },
            )
            return {"skipped": True, "reason": "max_retries_exceeded"}
    except Exception as exc:
        logger.exception("[auto_tag] memo %s 打标失败: %s", memo_id, exc)
        try:
            raise self.retry(exc=exc)
        except MaxRetriesExceededError:
            logger.error(
                "[auto_tag] memo %s 重试耗尽，最终失败: %s",
                memo_id,
                exc,
                extra={
                    "memo_id": memo_id,
                    "max_retries": self.max_retries,
                    "last_error": str(exc),
                    "last_error_type": type(exc).__name__,
                    "alert": "tabmemo_retag_exhausted",
                },
            )
            return {"skipped": True, "reason": "max_retries_exceeded"}
    finally:
        # BIZ-18: 总是释放幂等锁，包括 Retry 场景。
        # 旧逻辑在 Retry 时保留锁，但锁 TTL(150s) > retry countdown(10-60s)，
        # 导致重试任务被锁阻断后静默 skip，笔记永久无法打标。
        # Celery retry 有 countdown 延迟保证不并发，释放锁是安全的。
        cache.delete(lock_key)


@shared_task(
    name="tabmemo.purge_expired_trash",
    queue="default",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=260,
)
def purge_expired_trash() -> dict:
    """永久删除进入回收站超过保留期的 Memo。"""
    from apps.tabmemo.models import Attachment, Memo

    cutoff = timezone.now() - timedelta(days=TRASH_RETENTION_DAYS)
    qs = Memo.objects.using(TABMEMO_DB).filter(
        status=Memo.Status.TRASHED,
        updated_at__lt=cutoff,
    )
    memo_ids = list(qs.values_list("id", flat=True)[:5000])
    if not memo_ids:
        return {"success": True, "deleted": 0}

    Attachment.objects.using(TABMEMO_DB).filter(memo_id__in=memo_ids).delete()
    deleted_count, _ = Memo.objects.using(TABMEMO_DB).filter(id__in=memo_ids).delete()
    return {"success": True, "deleted": deleted_count}


TABMEMO_BEAT_SCHEDULE = {
    "tabmemo-purge-expired-trash": {
        "task": "tabmemo.purge_expired_trash",
        "schedule": crontab(hour=4, minute=20),
        "options": {"queue": "default"},
    },
}


