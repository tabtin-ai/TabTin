"""
Collab Celery 定时任务

- cleanup_expired_versions: 清理过期版本
- downsample_versions: 分级降采样
- async_revoke_collab_access: 异步撤销用户协作连接

两个任务通过分布式锁（Django cache）互斥执行，
防止同时操作 collab_version_history 表导致竞态删除。
"""
import logging

from celery import shared_task
from django.core.cache import cache

from .adapters.base import CollabAdapter
from .models import VersionHistory
from .service import VersionHistoryService
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger("collab.tasks")


class CollabRevocationError(Exception):
    """撤销 collab 连接失败，触发 Celery 任务级重试。"""
    pass

MAINTENANCE_LOCK_KEY = "collab:maintenance_lock"  # 保留向后兼容
MAINTENANCE_LOCK_TTL = 660  # time_limit(600) + 60s buffer

# CC-017: 拆分为独立锁 key，cleanup 和 downsample 可并行执行，
# 避免共享锁导致每轮只有一个任务能运行、有效执行间隔翻倍
CLEANUP_LOCK_KEY = "collab:cleanup_lock"
DOWNSAMPLE_LOCK_KEY = "collab:downsample_lock"

COLLAB_BEAT_SCHEDULE = {
    "collab-cleanup-expired-versions": {
        "task": "collab.cleanup_expired_versions",
        "schedule": 3600.0,
        "options": {"expires": 3000},
    },
    "collab-downsample-versions": {
        "task": "collab.downsample_versions",
        "schedule": 3600.0,
        "options": {"expires": 3000},
    },
    "collab-check-orphan-diffs": {
        "task": "collab.check_orphan_diffs",
        "schedule": 86400.0,  # 每天一次
        "options": {"expires": 82800},
    },
    # TSV-015/TSV-016/CSC-035: SlideHistory → VersionHistory 定时补偿迁移
    # DECISION-002/007: Celery Beat 分批 500 条/小时，全量迁移完成后任务自动停止
    "collab-migrate-slide-histories": {
        "task": "collab.migrate_slide_histories_incremental",
        "schedule": 3600.0,
        "options": {"expires": 3000},
    },
    # MC-01: DocHistory → VersionHistory 定时增量迁移
    "collab-migrate-doc-histories": {
        "task": "collab.migrate_doc_histories_incremental",
        "schedule": 3600.0,
        "options": {"expires": 3000},
    },
}


class _MaintenanceAdapter(CollabAdapter):
    """维护任务专用的轻量适配器，只借用 service 的通用方法。"""

    resource_type = "__maintenance__"

    def serialize_snapshot(self, data): ...
    def deserialize_snapshot(self, blob): ...
    def compute_diff(self, base, current): ...
    def apply_diff(self, base, diff): ...
    def get_resource(self, rid): ...
    def check_permission(self, u, r, a="edit"): ...
    def build_snapshot(self, r): ...
    def persist_changes(self, r, c, e): ...
    def restore(self, r, d): ...


@shared_task(
    bind=True,
    name="collab.revoke_user_collab_access",
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=5,
    retry_backoff=True,
    retry_backoff_max=300,
    time_limit=60,
    soft_time_limit=50,
)
def async_revoke_collab_access(self, user_id: str, organization_id: str):
    """异步通知 collab-live 撤销用户在 organization 下的所有协作连接（RB-004）。

    DS-025: acks_late + reject_on_worker_lost 确保 worker 宕机时任务
    由 broker 重新投递而非静默丢失；max_retries=5 + retry_backoff
    提供指数退避重试作为持久化补偿机制。
    """
    from .api import revoke_user_collab_access

    try:
        result = revoke_user_collab_access(user_id, organization_id)
    except Exception as exc:
        logger.exception(
            "async_revoke_collab_access raised: user=%s organization=%s",
            user_id, organization_id,
        )
        raise self.retry(exc=exc)

    if result.get("error"):
        logger.warning(
            "async_revoke_collab_access soft failure: user=%s organization=%s error=%s",
            user_id, organization_id, result["error"],
        )
        raise self.retry(
            exc=CollabRevocationError(
                f"user={user_id} organization={organization_id} error={result['error']}"
            ),
        )

    if result.get("revoked") or result.get("connections_closed"):
        logger.info(
            "Revoked collab access: user=%s organization=%s result=%s",
            user_id, organization_id, result,
        )
    return result


def sync_revoke_collab_access(user_id: str, organization_id: str) -> dict:
    """同步撤销用户的 collab-live 协作连接（RV-014：高危操作直接调用，绕过 Celery 队列）。"""
    from .api import revoke_user_collab_access

    try:
        result = revoke_user_collab_access(user_id, organization_id)
        if result.get("revoked"):
            logger.info(
                "Sync revoked collab access: user=%s organization=%s result=%s",
                user_id, organization_id, result,
            )
        return result
    except Exception:
        logger.exception(
            "sync_revoke_collab_access failed: user=%s organization=%s",
            user_id, organization_id,
        )
        return {"error": "sync_revoke_failed"}


@shared_task(
    bind=True,
    name="collab.downgrade_collab_to_readonly",
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=5,
    retry_backoff=True,
    retry_backoff_max=300,
    time_limit=60,
    soft_time_limit=50,
)
def async_downgrade_collab_to_readonly(self, user_id: str, organization_id: str):
    """异步将用户的 collab-live 连接降级为只读模式（RV-013）。"""
    from .api import downgrade_user_collab_to_readonly

    try:
        result = downgrade_user_collab_to_readonly(user_id, organization_id)
    except Exception as exc:
        logger.exception(
            "async_downgrade_collab_to_readonly raised: user=%s organization=%s",
            user_id, organization_id,
        )
        raise self.retry(exc=exc)

    if result.get("error"):
        logger.warning(
            "async_downgrade_collab_to_readonly soft failure: user=%s organization=%s error=%s",
            user_id, organization_id, result["error"],
        )
        raise self.retry(
            exc=CollabRevocationError(
                f"downgrade user={user_id} organization={organization_id} error={result['error']}"
            ),
        )

    if result.get("downgraded"):
        logger.info(
            "Downgraded collab to readonly: user=%s organization=%s result=%s",
            user_id, organization_id, result,
        )
    return result


@shared_task(
    bind=True,
    name="collab.revoke_document_collab_access",
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=5,
    retry_backoff=True,
    retry_backoff_max=300,
    time_limit=60,
    soft_time_limit=50,
)
def async_revoke_document_collab_access(
    self, document_name: str, user_id: str, read_only: bool = False,
):
    """异步通知 collab-live 撤销/降级用户在单文档上的连接（RV-015）。"""
    from .api import revoke_document_collab_access

    try:
        result = revoke_document_collab_access(
            document_name, user_id, read_only=read_only,
        )
    except Exception as exc:
        logger.exception(
            "async_revoke_document_collab_access raised: doc=%s user=%s",
            document_name, user_id,
        )
        raise self.retry(exc=exc)

    if result.get("error"):
        logger.warning(
            "async_revoke_document_collab_access soft failure: doc=%s user=%s error=%s",
            document_name, user_id, result["error"],
        )
        raise self.retry(
            exc=CollabRevocationError(
                f"doc={document_name} user={user_id} error={result['error']}"
            ),
        )

    if result.get("revoked"):
        logger.info(
            "Revoked document collab access: doc=%s user=%s read_only=%s result=%s",
            document_name, user_id, read_only, result,
        )
    return result


@shared_task(
    bind=True,
    name="collab.restore_file_checkpoint",
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=120,
    time_limit=60,
    soft_time_limit=50,
)
def async_restore_file_checkpoint(
    self, thread_id: str, file_checkpoint_hash: str, space_id: str = "",
):
    """CC-015: 异步通知 daemon 恢复 TabCode 文件到指定的 checkpoint hash。

    当 restore_space_checkpoint 被 Agent/API 调用时，6 个创作模块的数据
    通过 VersionHistory 恢复，但 TabCode 的文件系统恢复依赖 daemon/前端。
    此任务由 api.py 的 restore_space_checkpoint 在检查点包含
    file_checkpoint_hash 时调用，确保文件也被恢复。
    """
    if not file_checkpoint_hash:
        return {"status": "skipped", "reason": "empty_hash"}

    try:
        from apps.services.agent_engine.services.daemon_checkpoint_service import (
            DaemonCheckpointService,
        )

        success = DaemonCheckpointService.maybe_checkpoint_restore(
            thread_id=thread_id,
            commit_hash=file_checkpoint_hash,
        )

        if success:
            logger.info(
                "File checkpoint restored: thread=%s hash=%s space=%s",
                thread_id, file_checkpoint_hash, space_id,
            )
            return {"status": "ok", "hash": file_checkpoint_hash}

        logger.warning(
            "File checkpoint restore failed: thread=%s hash=%s space=%s",
            thread_id, file_checkpoint_hash, space_id,
        )
        raise self.retry(
            exc=Exception(
                f"File checkpoint restore failed: hash={file_checkpoint_hash}"
            ),
        )
    except self.MaxRetriesExceededError:
        logger.error(
            "File checkpoint restore exhausted retries: "
            "thread=%s hash=%s space=%s",
            thread_id, file_checkpoint_hash, space_id,
        )
        return {"status": "error", "reason": "max_retries_exceeded"}
    except Exception as exc:
        logger.exception(
            "async_restore_file_checkpoint raised: thread=%s hash=%s",
            thread_id, file_checkpoint_hash,
        )
        raise self.retry(exc=exc)


@shared_task(
    name="collab.cleanup_expired_versions",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
)
def cleanup_expired_versions():
    """清理所有过期版本记录（每小时执行）。

    TSV-014 协调说明：此任务清理 VersionHistory 表（统一框架），
    与 tabslide.cleanup_slide_history（私有 SlideHistory 表）独立运行。
    SlideHistory 的清理任务已添加迁移保护逻辑，确保未迁移到
    VersionHistory 的记录不会被提前删除。两个任务通过
    migrate_histories 命令的 metadata.legacy_id 链接保持一致性。
    """
    if not cache.add(CLEANUP_LOCK_KEY, "cleanup", MAINTENANCE_LOCK_TTL):
        logger.warning("Cleanup lock held, skipping cleanup")
        return 0
    try:
        svc = VersionHistoryService(_MaintenanceAdapter())
        count = svc.cleanup_expired_versions()
        if count > 0:
            logger.info("Cleaned up %d expired version histories", count)
        return count
    finally:
        cache.delete(CLEANUP_LOCK_KEY)


@shared_task(
    name="collab.downsample_versions",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
)
def downsample_versions():
    """分级降采样版本记录（每小时执行）。"""
    if not cache.add(DOWNSAMPLE_LOCK_KEY, "downsample", MAINTENANCE_LOCK_TTL):
        logger.warning("Downsample lock held, skipping downsample")
        return 0
    try:
        svc = VersionHistoryService(_MaintenanceAdapter())
        count = svc.downsample_versions()
        if count > 0:
            logger.info("Downsampled %d version histories", count)
        return count
    finally:
        cache.delete(DOWNSAMPLE_LOCK_KEY)


# TSV-015/TSV-016/CSC-035: SlideHistory → VersionHistory 定时补偿迁移锁
_MIGRATE_SLIDE_INCREMENTAL_LOCK_KEY = "collab:migrate_slide_incremental_lock"
_MIGRATE_SLIDE_BATCH_SIZE = 500


@shared_task(
    name="collab.migrate_slide_histories_incremental",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
    max_retries=0,
)
def migrate_slide_histories_incremental():
    """TSV-015/TSV-016/CSC-035: SlideHistory → VersionHistory 定时补偿迁移。

    DECISION-002/007: Celery Beat 分批 500 条/小时，渐进收敛存量数据。
    全量迁移完成后（done=True）任务自动停止（不再写入，幂等安全）。

    与 cleanup_slide_history 的互斥通过 _MIGRATE_SLIDE_LOCK_KEY 实现
    （migrate_histories.py 中定义），本任务使用独立锁避免与手动执行的
    management command 并发。
    """
    from apps.collab.management.commands.migrate_histories import (
        _MIGRATE_SLIDE_LOCK_KEY,
        _MIGRATE_SLIDE_LOCK_TIMEOUT,
        migrate_slide_histories_batch,
    )

    # 检查是否有手动迁移任务正在运行（共享同一把锁）
    if not cache.add(_MIGRATE_SLIDE_LOCK_KEY, "incremental", _MIGRATE_SLIDE_LOCK_TIMEOUT):
        logger.info(
            "migrate_slide_histories_incremental: migration lock held "
            "(manual migration running?), skipping this round"
        )
        return {"status": "skipped", "reason": "lock_held"}

    try:
        result = migrate_slide_histories_batch(batch_size=_MIGRATE_SLIDE_BATCH_SIZE)
    finally:
        cache.delete(_MIGRATE_SLIDE_LOCK_KEY)

    migrated = result.get("migrated", 0)
    failed = result.get("failed", 0)
    done = result.get("done", False)

    if done:
        logger.info(
            "migrate_slide_histories_incremental: all SlideHistory records migrated, "
            "task will continue to run but is a no-op"
        )
    elif migrated > 0 or failed > 0:
        logger.info(
            "migrate_slide_histories_incremental: migrated=%d failed=%d remaining=%d",
            migrated,
            failed,
            result.get("remaining", -1),
        )
        if failed > 0:
            logger.warning(
                "migrate_slide_histories_incremental: %d records failed to migrate, "
                "will retry in next run",
                failed,
            )

    return result


# MC-01: DocHistory → VersionHistory 定时增量迁移锁
_MIGRATE_DOC_INCREMENTAL_LOCK_KEY = "collab:migrate_doc_incremental_lock"
_MIGRATE_DOC_BATCH_SIZE = 500


@shared_task(
    name="collab.migrate_doc_histories_incremental",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
    max_retries=0,
)
def migrate_doc_histories_incremental():
    """MC-01: DocHistory → VersionHistory 定时增量迁移。

    Celery Beat 分批 500 条/小时，渐进收敛存量数据。
    全量迁移完成后（done=True）任务自动幂等空跑。

    Redis 锁策略：
    - _MIGRATE_DOC_LOCK_KEY: 与 management command 共享锁，防止并发写入
    """
    from apps.collab.management.commands.migrate_histories import (
        _MIGRATE_DOC_LOCK_KEY,
        _MIGRATE_DOC_LOCK_TIMEOUT,
        migrate_doc_histories_batch,
    )

    if not cache.add(_MIGRATE_DOC_LOCK_KEY, "incremental", _MIGRATE_DOC_LOCK_TIMEOUT):
        logger.info(
            "migrate_doc_histories_incremental: migration lock held "
            "(manual migration running?), skipping this round"
        )
        return {"status": "skipped", "reason": "lock_held"}

    try:
        result = migrate_doc_histories_batch(batch_size=_MIGRATE_DOC_BATCH_SIZE)
    finally:
        cache.delete(_MIGRATE_DOC_LOCK_KEY)

    migrated = result.get("migrated", 0)
    failed = result.get("failed", 0)
    done = result.get("done", False)

    if done:
        logger.info(
            "migrate_doc_histories_incremental: all DocHistory records migrated, "
            "task will continue to run but is a no-op"
        )
    elif migrated > 0 or failed > 0:
        logger.info(
            "migrate_doc_histories_incremental: migrated=%d failed=%d remaining=%d",
            migrated,
            failed,
            result.get("remaining", -1),
        )
        if failed > 0:
            logger.warning(
                "migrate_doc_histories_incremental: %d records failed to migrate, "
                "will retry in next run",
                failed,
            )

    return result


@shared_task(
    name="collab.check_orphan_diffs",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
)
def check_orphan_diffs():
    """P2-4: 巡检孤儿 diff — base_history 被 SET_NULL 导致无法重建的 diff 记录。

    按 resource_type 分组统计，数量 > 0 时记录 error 告警。
    不做自动修复，仅用于发现和监控。
    """
    from django.db.models import Count

    orphans = (
        VersionHistory.objects.using(postgres_app_db_alias())
        .filter(is_snapshot=False, base_history_id__isnull=True)
        .values("resource_type")
        .annotate(cnt=Count("id"))
    )

    total = 0
    for row in orphans:
        rt, cnt = row["resource_type"], row["cnt"]
        total += cnt
        logger.error(
            "Orphan diffs detected: resource_type=%s count=%d "
            "(base_history=NULL, data unrecoverable)",
            rt, cnt,
        )

    if total == 0:
        logger.info("check_orphan_diffs: no orphan diffs found")
    else:
        logger.error("check_orphan_diffs: total orphan diffs = %d", total)

    return {"total": total}
