"""
Daily Agent diary distillation.

按 (organization, owner, agent) 分组当日 task_summary 记忆，蒸馏出一条
用户可读的工作日记（memo_type=diary）。#3266 M4.5/C5 分家后 task_summary
与 diary 均落独立 ``AgentMemory`` 表（挂 agent 生命周期），不再写 Memo
用户笔记表。
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, Iterable, Optional

from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone

from apps.agent_memory.models import AgentMemory
from apps.agent_memory.repository import AgentMemoryRepository

logger = logging.getLogger(__name__)

MIN_SUMMARY_CHARS = 30
MAX_INPUT_CHARS = 24_000

DAILY_DIARY_BEAT_SCHEDULE = {
    "agent-daily-diary-distill": {
        "task": "agent_engine.dispatch_daily_diary",
        "schedule": crontab(hour=2, minute=10),
        "options": {"queue": "heavy"},
    },
}


def _parse_target_date(value: Optional[str]) -> date:
    if value:
        return datetime.fromisoformat(value).date()
    return timezone.localdate()


def _day_range(target_date: date):
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(target_date, time.min), tz)
    end = start + timedelta(days=1)
    return start, end


def _json_from_llm(raw: str) -> Dict[str, Any]:
    text = (raw or "").strip()
    text = re.sub(r"^```\w*\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text).strip()
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("diary_distill must return a JSON object")
    return data


def _format_summaries(summaries: Iterable[AgentMemory]) -> str:
    chunks: list[str] = []
    total = 0
    for idx, memo in enumerate(summaries, start=1):
        title = (memo.title or "未命名小结").strip()
        content = (memo.content_markdown or memo.content_plaintext or "").strip()
        if not content:
            continue
        block = f"## 小结 {idx}: {title}\n{content}"
        if total + len(block) > MAX_INPUT_CHARS:
            break
        chunks.append(block)
        total += len(block)
    return "\n\n".join(chunks)


def _render_diary_markdown(data: Dict[str, Any]) -> str:
    diary = str(data.get("diary") or "").strip()
    highlights = [str(x).strip() for x in data.get("highlights") or [] if str(x).strip()]
    open_items = [str(x).strip() for x in data.get("open_items") or [] if str(x).strip()]

    parts = [diary] if diary else []
    if highlights:
        parts.append("关键进展：\n" + "\n".join(f"- {item}" for item in highlights[:5]))
    if open_items:
        parts.append("未完事项：\n" + "\n".join(f"- {item}" for item in open_items[:5]))
    return "\n\n".join(parts).strip()


def validate_diary_result(content: str) -> None:
    """Reuse the diary parser/rendering contract before user settlement."""
    data = _json_from_llm(content)
    if len(_render_diary_markdown(data)) < MIN_SUMMARY_CHARS:
        raise ValueError("diary_distill rendered content is too short")


def _upsert_diary(
    *,
    organization_id: str,
    user_id: str,
    agent_id: str,
    target_date: date,
    data: Dict[str, Any],
) -> AgentMemory:
    """按 (agent, owner, date) 幂等 upsert 一条日记记忆。

    记忆不进用户搜索索引（无 search_vector），日记视图走 AgentMemory 列表。
    """
    source_url = f"diary://{agent_id}/{target_date.isoformat()}"
    title = str(data.get("title") or f"{target_date.isoformat()} 工作日记").strip()[:200]
    content_markdown = _render_diary_markdown(data)
    content_plaintext = re.sub(r"\s+", " ", content_markdown).strip()

    # ：AgentMemory 读写收口到新领域仓储的 base_qs（router 路由，不显式 using）。
    from apps.agent_memory.repository import AgentMemoryRepository

    # forget 语义优先：用户忘记某日日记后，夜间重跑不得把它「复活」成 ACTIVE。
    # update_or_create 的 defaults 会强制 status=ACTIVE，故先探已忘记行并短路。
    existing = (
        AgentMemoryRepository.base_qs()
        .filter(
            organization_id=organization_id,
            agent_id=agent_id,
            owner_id=user_id,
            memo_type=AgentMemory.MemoType.DIARY,
            source_url=source_url,
        )
        .first()
    )
    if existing is not None and existing.forgotten_at is not None:
        logger.info(
            "[DailyDiary] skip revive of forgotten diary: agent=%s owner=%s date=%s",
            agent_id, user_id, target_date.isoformat(),
        )
        return existing

    memory, _created = AgentMemoryRepository.base_qs().update_or_create(
        organization_id=organization_id,
        agent_id=agent_id,
        owner_id=user_id,
        memo_type=AgentMemory.MemoType.DIARY,
        source_url=source_url,
        defaults={
            "organization_id": organization_id,
            "title": title,
            "content_json": data,
            "content_markdown": content_markdown,
            "content_plaintext": content_plaintext,
            "status": AgentMemory.Status.ACTIVE,
            "ai_tags": ["diary"],
            "tags": ["diary"],
        },
    )
    return memory


@shared_task(
    name="agent_engine.dispatch_daily_diary",
    bind=True,
    queue="heavy",
    time_limit=600,
    soft_time_limit=540,
)
def dispatch_daily_diary(self, target_date: Optional[str] = None) -> dict:
    """Scan summary groups and enqueue one diary distillation per Agent."""
    day = _parse_target_date(target_date)
    start, end = _day_range(day)

    groups = (
        AgentMemoryRepository.base_qs()
        .filter(
            memo_type=AgentMemory.MemoType.TASK_SUMMARY,
            status=AgentMemory.Status.ACTIVE,
            forgotten_at__isnull=True,
            created_at__gte=start,
            created_at__lt=end,
        )
        .exclude(owner_id__isnull=True)
        .values("organization_id", "owner_id", "agent_id")
        .distinct()
    )

    dispatched = 0
    for group in groups:
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        try:
            execution = resolve_workspace_memory_dispatch(
                scene_key="diary_distill",
                organization_id=str(group["organization_id"]),
                user_id=str(group["owner_id"]),
            )
        except Exception as exc:
            logger.warning(
                "[DailyDiary] dispatch blocked by Workspace Memory policy: %s",
                type(exc).__name__,
            )
            continue
        if not execution.enabled:
            continue
        distill_daily_diary_task.delay(
            user_id=str(group["owner_id"]),
            organization_id=str(group["organization_id"]),
            agent_id=str(group["agent_id"]),
            target_date=day.isoformat(),
            selected_model_id=execution.selected_model_id,
        )
        dispatched += 1

    return {"target_date": day.isoformat(), "dispatched": dispatched}


@shared_task(
    name="agent_engine.distill_daily_diary",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    # P0: queue 由 CELERY_TASK_ROUTES → ai_background 控制，禁止 decorator 绑部署拓扑
    time_limit=300,
    soft_time_limit=260,
)
def distill_daily_diary_task(
    self,
    *,
    user_id: str,
    organization_id: str,
    agent_id: str,
    target_date: Optional[str] = None,
    selected_model_id: str = "",
) -> dict:
    from apps.agent_memory.workspace_memory_execution import (
        resolve_workspace_memory_worker,
    )

    execution = resolve_workspace_memory_worker(
        scene_key="diary_distill",
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
    )
    if not execution.enabled:
        return {"skipped": True, "reason": "auto_memory_disabled"}

    day = _parse_target_date(target_date)
    start, end = _day_range(day)

    from apps.tabmemo.services.record_style_service import resolve_record_preference

    enabled, record_pref = resolve_record_preference(user_id, organization_id)
    if not enabled:
        return {"skipped": True, "reason": "memory_disabled"}

    summaries = list(
        AgentMemoryRepository.aggregate_scope(
            organization_id=organization_id,
            subject_user_id=user_id,
            agent_id=agent_id,
        )
        .filter(
            memo_type=AgentMemory.MemoType.TASK_SUMMARY,
            status=AgentMemory.Status.ACTIVE,
            forgotten_at__isnull=True,
            created_at__gte=start,
            created_at__lt=end,
        )
        .order_by("created_at")
    )
    summaries_text = _format_summaries(summaries)
    if len(summaries_text) < MIN_SUMMARY_CHARS:
        return {"skipped": True, "reason": "insufficient_input", "summary_count": len(summaries)}

    provider_completed = False
    try:
        from apps.services.llm.services.chat import unified_llm_call
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )

        celery_task_id = str(getattr(self.request, "id", "") or "")
        business_identity = (
            f"{organization_id}:{user_id}:{agent_id}:{day.isoformat()}"
        )
        invocation_context = build_background_scene_invocation(
            scene_key="diary_distill",
            business_identity=business_identity,
            organization_id=organization_id,
            user_id=user_id,
            selected_model_id=execution.selected_model_id,
            business_object_type="daily_diary",
            business_object_id=business_identity,
            task_id=celery_task_id,
            retry_source="celery" if celery_task_id else "",
        )

        llm_result = unified_llm_call(
            scene_key="diary_distill",
            variables={
                "date": day.isoformat(),
                "summaries_text": summaries_text,
                "record_preference": record_pref,
            },
            user_id=user_id,
            organization_id=organization_id,
            selected_model_id=execution.selected_model_id,
            invocation_context=invocation_context,
            result_validator=validate_diary_result,
        )
        data = _json_from_llm(llm_result.content)
        provider_completed = True
        memo = _upsert_diary(
            organization_id=organization_id,
            user_id=user_id,
            agent_id=agent_id,
            target_date=day,
            data=data,
        )
        return {"success": True, "memo_id": str(memo.id), "summary_count": len(summaries)}
    except Exception as exc:
        logger.exception(
            "[daily_diary] distill failed user=%s org=%s agent=%s date=%s: %s",
            user_id,
            organization_id,
            agent_id,
            day,
            exc,
        )
        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        if provider_completed or is_retryable_background_error(exc):
            raise self.retry(exc=exc)
        raise
