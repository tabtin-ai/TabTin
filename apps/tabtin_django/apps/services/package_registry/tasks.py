"""Package Registry Celery 定时任务。

cleanup_stale_uploading_versions:
    清理 created_at > 24h 且 status=UPLOADING 的 PackageVersion，
    防止客户端崩溃/断网/放弃后遗留记录导致数据库膨胀。

gc_orphan_package_after_skill_uninstall:
    Skills 卸载触发的非定时任务。由 ``SkillService.disable_skill``
    在卸载完成后异步调度,负责检查目标 ``package_id`` 是否仍被任何 Skill
    引用;若无 → yank 该 Package 所有 PUBLISHED 版本释放 OSS 引用,实际 OSS
    字节由 OSS 模块的 GC 后续根据 FileRecord 引用计数清理。

注册方式：
    CLEANUP_BEAT_SCHEDULE 由 celery.py 的 _discover_beat_schedules_auto()
    自动发现并注册到 DatabaseScheduler（每小时执行一次）。
    GC after-uninstall 任务由 Skills.uninstall 即时 ``apply_async`` 触发,不在
    beat schedule 中。
"""

from __future__ import annotations

from django.conf import settings
import logging
import uuid
from datetime import timedelta
from typing import Any

from celery import shared_task
from celery.schedules import schedule as celery_interval
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

_USING_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
_STALE_THRESHOLD_HOURS = 24

CLEANUP_BEAT_SCHEDULE = {
    "package_registry.cleanup_stale_uploads": {
        "task": "package_registry.cleanup_stale_uploads",
        "schedule": celery_interval(run_every=timedelta(hours=1)),
        "options": {"queue": "default"},
    },
    # W7 P1-1: EventOutbox 自动重试任务,5 分钟一次扫描 pending/next_retry_at <= now
    "package_registry.process_event_outbox": {
        "task": "package_registry.process_event_outbox",
        "schedule": celery_interval(run_every=timedelta(minutes=5)),
        "options": {"queue": "default"},
    },
}


@shared_task(
    name="package_registry.cleanup_stale_uploads",
    bind=True,
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
)
def cleanup_stale_uploading_versions(self):
    """清理 24h 前仍处于 UPLOADING 态的 PackageVersion。"""
    from apps.services.package_registry.models import PackageVersion

    cutoff = timezone.now() - timedelta(hours=_STALE_THRESHOLD_HOURS)
    stale_qs = PackageVersion.objects.using(_USING_DB).filter(
        status=PackageVersion.Status.UPLOADING,
        created_at__lt=cutoff,
    )

    BATCH_SIZE = 100
    total_deleted = 0
    while True:
        batch_ids = list(
            stale_qs.values_list("id", flat=True)[:BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted_count, _ = PackageVersion.objects.using(_USING_DB).filter(
            id__in=batch_ids
        ).delete()
        total_deleted += deleted_count

    if total_deleted:
        logger.info(
            "cleanup_stale_uploading_versions: deleted %d stale UPLOADING versions (cutoff=%s)",
            total_deleted,
            cutoff.isoformat(),
        )
    else:
        logger.debug("cleanup_stale_uploading_versions: nothing to clean")
    return {"deleted": total_deleted}


@shared_task(
    name="package_registry.gc_orphan_package_after_skill_uninstall",
    bind=True,
    ignore_result=True,
    time_limit=60,
    soft_time_limit=45,
    max_retries=3,
    default_retry_delay=10,
)
def gc_orphan_package_after_skill_uninstall(
    self, package_id: str, organization_id: str | None = None,
) -> dict[str, Any]:
    """Skills 卸载后的 PR 端 GC 检查。

    职责:
    1. 检查 ``package_id`` 是否仍被任何 Skill 引用(共享场景)
    2. 若仍有引用 → no-op(其它 organization / 用户的 Skill 还在用)
    3. 若无引用 → yank 该 Package 的所有 PUBLISHED 版本,释放 OSS 字节引用
    4. emit ``pkg.package.archived`` 事件,通知运维 / 审计

    幂等:重复触发安全(yank_version 自身幂等,且我们 select_for_update 串行化)。

    边界:
    - Package 已不存在 → 不报错
    - 某 version 已 yank → 跳过(continue)
    """
    from apps.services.package_registry.models import (
        Package, PackageVersion,
    )
    from apps.services.package_registry.services import emit_on_commit

    try:
        pkg_uuid = uuid.UUID(str(package_id))
    except (ValueError, TypeError):
        logger.warning(
            "[PackageRegistry] gc_orphan: invalid package_id=%s,跳过", package_id,
        )
        return {"skipped": True, "reason": "invalid_id"}

    # Wave 1（PRD V3.3 §11.1，2026-05-02）：Skill 表归 PG，跟 Package 同库
    # → GC 直接查 Skill 表本身（race-free，不需要 ref 兜底）。
    from apps.skills.models import Skill

    try:
        still_referenced = Skill.objects.filter(package_id=pkg_uuid).exists()
    except Exception as exc:
        logger.warning(
            "[PackageRegistry] gc_orphan: Skill 表查询失败 package_id=%s: %s,"
            "保守跳过,等下次手动触发", pkg_uuid, exc,
        )
        return {"skipped": True, "reason": "skill_query_failed"}

    if still_referenced:
        logger.debug(
            "[PackageRegistry] gc_orphan: package_id=%s 仍被 ref 索引,no-op",
            pkg_uuid,
        )
        return {"skipped": True, "reason": "still_referenced", "package_id": str(pkg_uuid)}

    # 无引用 → yank 全部 PUBLISHED 版本
    yanked_count = 0
    with transaction.atomic(using=_USING_DB):
        try:
            pkg = Package.objects.using(_USING_DB).select_for_update().get(id=pkg_uuid)
        except Package.DoesNotExist:
            logger.info(
                "[PackageRegistry] gc_orphan: package_id=%s 已不存在,idempotent skip",
                pkg_uuid,
            )
            return {"skipped": True, "reason": "package_not_found"}

        # Wave 1：Skill 表跟 Package 同库（PG），二次确认 race-free。
        try:
            still_after_lock = Skill.objects.filter(package_id=pkg_uuid).exists()
        except Exception:
            still_after_lock = True  # 查询失败保守不动
        if still_after_lock:
            logger.info(
                "[PackageRegistry] gc_orphan: package_id=%s race recovered "
                "(Skill row re-created),取消 yank", pkg_uuid,
            )
            return {"skipped": True, "reason": "race_recovered"}

        now = timezone.now()
        active_versions = list(
            PackageVersion.objects.using(_USING_DB)
            .select_for_update()
            .filter(
                package=pkg,
                status=PackageVersion.Status.PUBLISHED,
                is_yanked=False,
            )
        )
        for v in active_versions:
            v.is_yanked = True
            v.yanked_at = now
            # yanked_by 用 NULL — 这是系统级 GC,不归属任何用户
            v.yanked_by = None
            v.yanked_reason = "AUTO_GC_AFTER_SKILL_UNINSTALL"
            v.save(update_fields=[
                "is_yanked", "yanked_at", "yanked_by", "yanked_reason",
            ])
            yanked_count += 1

        wt_id = organization_id or str(pkg.organization_id)
        emit_on_commit("pkg.package.archived", wt_id, {
            "package_id": str(pkg.id),
            "namespace": pkg.namespace,
            "name": pkg.name,
            "yanked_versions": yanked_count,
            "trigger": "skill_uninstall_gc",
        })

    logger.info(
        "[PackageRegistry] gc_orphan: package_id=%s yanked %d versions",
        pkg_uuid, yanked_count,
    )
    return {
        "package_id": str(pkg_uuid),
        "yanked_versions": yanked_count,
        "skipped": False,
    }


# ---------------------------------------------------------------------------
# W7 P1-1: EventOutbox 周期重试任务
# ---------------------------------------------------------------------------

# 每批扫描的 outbox 记录数,避免单次任务过长
_OUTBOX_BATCH_SIZE = 50

# 单次任务最长执行时间(秒)
_OUTBOX_TASK_TIMEOUT = 60

# 指数退避基数 — 重试间隔 = 2^retry_count 秒(retry=0 时下次立即跑,
# retry=5 时下次 32 秒后跑,retry=10 时 ~17 分钟后跑)。封顶在 max_retries
# 之前不会真正达到 retry=10。
_OUTBOX_BACKOFF_BASE_SECONDS = 2


def _retry_event(record) -> tuple[bool, str]:
    """根据 outbox 记录的 event_type 调对应的业务函数尝试重试。

    返回 ``(success, error_message)``:
    - ``success=True``:重试成功(业务恢复)
    - ``success=False``:仍然失败,error_message 提供给 last_error

    注意:本函数不抛异常,所有失败都返回 (False, msg);catch 任何异常以保护
    主任务 loop 健壮性。
    """
    event_type = record.event_type
    payload = record.payload or {}

    try:
        if event_type == "pkg.skill.upsert_failed":
            # 重试 skill upsert — 但 finalize_version 已经过去,我们只能尝试
            # 再次让 Skill 行与 Package 对齐;成功条件是"upsert 不抛异常"
            # （Wave 1 起 PG 同库 update_or_create）。
            return _retry_skill_upsert(payload)
        elif event_type == "pkg.package.reverted_sync_failed":
            return _retry_revert_sync(payload)
        elif event_type == "pkg.gc.scheduling_failed":
            return _retry_gc_schedule(payload)
        elif event_type == "pkg.managed_skill_ref.create_failed":
            return _retry_managed_skill_ref_create(payload)
        elif event_type == "pkg.managed_skill_ref.delete_failed":
            return _retry_managed_skill_ref_delete(payload)
        else:
            return (False, f"unknown event_type {event_type}")
    except Exception as exc:
        return (False, f"unhandled in _retry_event: {exc}")


def _retry_skill_upsert(payload: dict[str, Any]) -> tuple[bool, str]:
    """重试 ``pkg.skill.upsert_failed``: 重新拉 Package + Version 跑 upsert。"""
    from apps.services.package_registry.models import Package, PackageVersion
    from apps.services.package_registry import services as pr_services

    pkg_id = payload.get("package_id")
    version_seq = payload.get("version_seq")
    if not pkg_id or version_seq is None:
        return (False, "missing package_id/version_seq in payload")

    try:
        pkg = Package.objects.using(_USING_DB).filter(id=pkg_id).first()
        if not pkg:
            # Package 已删 → 视为"业务上无需重试"(不再有目标),标记 done
            return (True, "package no longer exists")
        version = PackageVersion.objects.using(_USING_DB).filter(
            package=pkg, version_seq=version_seq,
        ).first()
        if not version:
            return (True, "version no longer exists")
        result = pr_services._upsert_managed_skill_from_finalize(
            package=pkg, version=version, user_id=str(pkg.created_by),
        )
        if result.get("upserted"):
            return (True, "")
        # not_a_skill / missing_skill_key 等都是"业务上不需要"
        if result.get("reason") in ("not_a_skill", "missing_skill_key"):
            return (True, f"resolved as {result.get('reason')}")
        # cross_db_failed 仍未恢复
        return (False, f"still failed: reason={result.get('reason')}")
    except Exception as exc:
        return (False, str(exc))


def _retry_revert_sync(payload: dict[str, Any]) -> tuple[bool, str]:
    """重试 ``pkg.package.reverted_sync_failed``: 再次同步 Skill 指针 + SPV。"""
    from apps.services.package_registry.models import Package, PackageVersion
    from apps.services.package_registry import services as pr_services

    pkg_id = payload.get("package_id")
    # 历史 payload 字段名 target_version_seq 实际存的是 *新* version_seq
    new_seq = payload.get("target_version_seq")
    source_seq = payload.get("source_version_seq")
    if not pkg_id or new_seq is None:
        return (False, "missing package_id/target_version_seq in payload")

    try:
        pkg = Package.objects.using(_USING_DB).filter(id=pkg_id).first()
        if not pkg:
            return (True, "package no longer exists")
        version = PackageVersion.objects.using(_USING_DB).filter(
            package=pkg, version_seq=new_seq,
        ).first()
        if not version:
            return (True, "version no longer exists")
        affected = pr_services._sync_managed_skill_version_pointer(
            package_id=uuid.UUID(str(pkg.id)),
            version_label=version.version_label,
            new_version_seq=int(new_seq),
            source_version_seq=int(source_seq) if source_seq is not None else None,
            bundle_sha256=version.bundle_sha256,
            user_id=str(pkg.created_by) if pkg.created_by else None,
        )
        return (True, f"affected={affected}")
    except Exception as exc:
        return (False, str(exc))


def _retry_gc_schedule(payload: dict[str, Any]) -> tuple[bool, str]:
    """重试 ``pkg.gc.scheduling_failed``: 再次调度 GC 任务。"""
    pkg_id = payload.get("package_id")
    organization_id = payload.get("organization_id") or None
    if not pkg_id:
        return (False, "missing package_id in payload")

    try:
        gc_orphan_package_after_skill_uninstall.apply_async(
            kwargs={"package_id": str(pkg_id), "organization_id": organization_id},
        )
        return (True, "")
    except Exception as exc:
        return (False, str(exc))


def _retry_managed_skill_ref_create(payload: dict[str, Any]) -> tuple[bool, str]:
    """Wave 1（PRD V3.3 §11.1）：跨库 ref 已删除，retry 直接 done。

    历史 outbox 行（旧 event_type）一次性标记完成，避免 dead 队列堆积。
    """
    return (True, "deprecated_after_wave1_skill_table_pg_migration")


def _retry_managed_skill_ref_delete(payload: dict[str, Any]) -> tuple[bool, str]:
    """Wave 1（PRD V3.3 §11.1）：跨库 ref 已删除，retry 直接 done。"""
    return (True, "deprecated_after_wave1_skill_table_pg_migration")


@shared_task(
    name="package_registry.process_event_outbox",
    bind=True,
    ignore_result=True,
    time_limit=_OUTBOX_TASK_TIMEOUT + 30,
    soft_time_limit=_OUTBOX_TASK_TIMEOUT,
    max_retries=0,
)
def process_event_outbox(self) -> dict[str, Any]:
    """W7 P1-1: 扫描 EventOutbox 重试 pending 记录。

    职责:
    1. ``select_for_update`` 锁定一批 ``status=pending AND next_retry_at <= now``
    2. 逐条根据 ``event_type`` 调业务重试函数
    3. 成功 → ``status=done``;失败 → ``retry_count+=1`` + 指数退避;超 ``max_retries``
       → ``status=dead``,需运维人工干预

    幂等:重复触发安全(SELECT FOR UPDATE 串行化 + status 状态机)。

    范围:只处理 PR 模块的 3 类事件 — ``pkg.package.reverted_sync_failed`` /
    ``pkg.skill.upsert_failed`` / ``pkg.gc.scheduling_failed``。其它模块需自建
    自己的 outbox + retry 任务。
    """
    from apps.services.package_registry.models import EventOutbox

    now = timezone.now()
    stats = {"processed": 0, "succeeded": 0, "failed": 0, "dead": 0}

    with transaction.atomic(using=_USING_DB):
        candidate_ids = list(
            EventOutbox.objects.using(_USING_DB)
            .filter(
                status=EventOutbox.STATUS_PENDING,
                next_retry_at__lte=now,
            )
            .values_list("id", flat=True)[:_OUTBOX_BATCH_SIZE]
        )
        if not candidate_ids:
            return stats

        records = list(
            EventOutbox.objects.using(_USING_DB)
            .select_for_update()
            .filter(id__in=candidate_ids, status=EventOutbox.STATUS_PENDING)
        )
        # 标记为 processing 防止并发 worker 抢同一行
        EventOutbox.objects.using(_USING_DB).filter(
            id__in=[r.id for r in records],
        ).update(status=EventOutbox.STATUS_PROCESSING)

    # 逐条重试(出 atomic 块,避免单条失败回滚 batch 状态)
    for record in records:
        stats["processed"] += 1
        success, err = _retry_event(record)
        if success:
            EventOutbox.objects.using(_USING_DB).filter(id=record.id).update(
                status=EventOutbox.STATUS_DONE,
                last_error=err,
                updated_at=timezone.now(),
            )
            stats["succeeded"] += 1
            logger.info(
                "[PackageRegistry] outbox 重试成功: id=%s event=%s",
                record.id, record.event_type,
            )
            continue

        new_count = record.retry_count + 1
        if new_count >= record.max_retries:
            EventOutbox.objects.using(_USING_DB).filter(id=record.id).update(
                status=EventOutbox.STATUS_DEAD,
                retry_count=new_count,
                last_error=err[:1024],
                updated_at=timezone.now(),
            )
            stats["dead"] += 1
            logger.error(
                "[PackageRegistry] outbox 超过 max_retries 标记 dead: "
                "id=%s event=%s retries=%s err=%s",
                record.id, record.event_type, new_count, err,
            )
        else:
            backoff = _OUTBOX_BACKOFF_BASE_SECONDS ** new_count
            EventOutbox.objects.using(_USING_DB).filter(id=record.id).update(
                status=EventOutbox.STATUS_PENDING,
                retry_count=new_count,
                next_retry_at=timezone.now() + timedelta(seconds=backoff),
                last_error=err[:1024],
                updated_at=timezone.now(),
            )
            stats["failed"] += 1
            logger.info(
                "[PackageRegistry] outbox 重试失败,下次 %ds 后: id=%s event=%s err=%s",
                backoff, record.id, record.event_type, err,
            )

    if stats["processed"]:
        logger.info(
            "[PackageRegistry] process_event_outbox 完成: %s", stats,
        )
    return stats
