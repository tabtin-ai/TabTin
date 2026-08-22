"""
TabSlide Celery 异步任务

任务清单:
  1. create_slide_history   — 保存后异步创建版本历史快照
  2. cleanup_slide_history  — 定期清理过期历史 + 分级降采样
  3. migrate_fonts_to_oss   — 将旧项目的 font base64 迁移到 OSS
  4. pregenerate_pptx       — 异步预生成 PPTX 缓存
  5. cleanup_page_cache     — 清理过期 PPTX 页面缓存
  6. import_pptx_task       — CRT-01: PPTX 导入异步化
"""

from __future__ import annotations

import logging
import os
import tempfile
from datetime import timedelta
from uuid import UUID

from celery import shared_task
from django.db.models import Count, Q
from django.db.models.functions import TruncDay, TruncHour, TruncWeek
from django.utils import timezone
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

PPTX_IMPORT_OSS_OBJECT_KEY_PREFIX = "temp-parse/tabslide-import"


def _validate_pptx_import_object_key(object_key: str) -> None:
    """只允许本任务生成的临时 PPTX 对象，避免读取或删除任意 OSS 对象。"""
    prefix = f"{PPTX_IMPORT_OSS_OBJECT_KEY_PREFIX}/"
    if not isinstance(object_key, str) or not object_key.startswith(prefix):
        raise ValueError("PPTX 导入临时对象键非法")

    object_name = object_key.removeprefix(prefix)
    if not object_name.endswith(".pptx") or "/" in object_name or "\\" in object_name:
        raise ValueError("PPTX 导入临时对象键非法")

    try:
        parsed_id = UUID(object_name[:-5])
    except (ValueError, AttributeError) as exc:
        raise ValueError("PPTX 导入临时对象键非法") from exc
    if parsed_id.hex != object_name[:-5]:
        raise ValueError("PPTX 导入临时对象键非法")


# ── Celery Beat 配置（注册到 tabtin/celery.py）──
TABSLIDE_BEAT_SCHEDULE = {
    "tabslide-cleanup-history": {
        "task": "tabslide.cleanup_slide_history",
        "schedule": 3600,
        "options": {"expires": 3000},
    },
    "tabslide-cleanup-page-cache": {
        "task": "tabslide.cleanup_page_cache",
        "schedule": 86400,
        "options": {"expires": 3600},
    },
    "tabslide-cleanup-element-changes": {
        "task": "tabslide.cleanup_element_changes",
        "schedule": 86400,
        "options": {"expires": 3600},
    },
}


# ═══════════════════════════════════════════════════════════════════
# 任务 1: 创建版本历史快照
# ═══════════════════════════════════════════════════════════════════

def _resolve_history_ttl(organization_id: str) -> int:
    """根据组织会员等级返回对应的版本历史 TTL（秒）。"""
    from apps.tabslide.models import HISTORY_TTL_FREE, HISTORY_TTL_PRO, HISTORY_TTL_TEAM

    if not organization_id:
        return HISTORY_TTL_FREE

    try:
        from apps.users.membership.models import OrganizationMembership

        membership = (
            OrganizationMembership.objects
            .select_related("tier")
            .filter(
                organization_id=organization_id,
                status="active",
                start_date__lte=timezone.now(),
                end_date__gt=timezone.now(),
            )
            .order_by("-end_date", "-updated_at")
            .first()
        )
        if membership and membership.tier:
            tier_type = membership.tier.tier_type
            if tier_type in ("enterprise", "team"):
                return HISTORY_TTL_TEAM
            elif tier_type == "pro":
                return HISTORY_TTL_PRO
            # basic / free → 默认 FREE
    except Exception:
        logger.debug("Failed to query organization membership for TTL, using FREE default")

    return HISTORY_TTL_FREE


@shared_task(name="tabslide.create_slide_history", bind=True, max_retries=2, time_limit=300, soft_time_limit=280)
def create_slide_history(
    self,
    project_id: str,
    editor_type: str = "",
    editor_id: str = "",
):
    """
    [已废弃] 保存后异步创建 SlideHistory 版本快照。

    私有 SlideHistory 写入路径已下线，版本历史统一通过 VersionHistory 管理。
    保留任务注册以兼容可能残留在队列中的消息，但不再执行实际写入。
    存量 SlideHistory 数据通过 migrate_slide_histories_incremental 迁移任务逐步迁移到 VH。
    """
    logger.info(
        "[DEPRECATED] create_slide_history 被调用但已为 no-op: project=%s editor=%s/%s",
        project_id, editor_type, editor_id,
    )
    return


# ═══════════════════════════════════════════════════════════════════
# 任务 2: 定期清理过期历史 + 分级降采样
# ═══════════════════════════════════════════════════════════════════

_UNMIGRATED_CHECK_BATCH = 500


def _get_unmigrated_slide_history_ids(expired_qs) -> set:
    """找出尚未迁移到 VersionHistory 的 SlideHistory ID 集合。

    CSC-033: 去掉原来 [:_UNMIGRATED_CHECK_BATCH * 4]（2000 条）的硬上限，
    改为循环分批拉取全部过期 ID，确保超过 2000 条时不会漏检导致误删。
    """
    from apps.collab.models import VersionHistory

    # 分批拉取所有过期 ID，避免一次性加载过多到内存。
    all_expired_ids: list = []
    offset = 0
    while True:
        batch_ids = list(
            expired_qs.values_list("id", flat=True)[offset: offset + _UNMIGRATED_CHECK_BATCH]
        )
        if not batch_ids:
            break
        all_expired_ids.extend(batch_ids)
        offset += _UNMIGRATED_CHECK_BATCH

    if not all_expired_ids:
        return set()

    expired_str_ids = [str(eid) for eid in all_expired_ids]

    migrated_legacy_ids = set()
    for i in range(0, len(expired_str_ids), _UNMIGRATED_CHECK_BATCH):
        batch = expired_str_ids[i:i + _UNMIGRATED_CHECK_BATCH]
        migrated_legacy_ids.update(
            VersionHistory.objects.using(postgres_app_db_alias())
            .filter(resource_type="slide", metadata__legacy_id__in=batch)
            .values_list("metadata__legacy_id", flat=True)
        )

    return {eid for eid, sid in zip(all_expired_ids, expired_str_ids) if sid not in migrated_legacy_ids}


@shared_task(name="tabslide.cleanup_slide_history", bind=True, max_retries=1, ignore_result=True, time_limit=300, soft_time_limit=280)
def cleanup_slide_history(self):
    """
    清理过期的 SlideHistory + 分级降采样（对齐 TabDoc）。

    由 Celery Beat 每小时触发。

    清理规则:
      1. 删除 expired_at < now() 的记录（排除命名版本和置顶版本）
      2. 分级降采样:
         - 1-7 天前: 每小时保留 1 个
         - 7-30 天前: 每天保留 1 个
    """
    from apps.tabslide.models import SlideHistory

    now = timezone.now()

    # ── 第 1 步: 删除已过期的记录 ──
    expired_qs = SlideHistory.objects.using(postgres_app_db_alias()).filter(
        expired_at__lt=now,
        is_named=False,
        pinned=False,
    )

    # 保护被任何 diff 引用的 base_history（不限于未过期记录），
    # 防止多级链 A→B→C 中 B 已过期但 C 未过期时 A 被误删致链断裂。
    # 安全策略：从叶节点逐级释放，本轮只删无依赖的过期节点。
    protected_snapshot_ids = set(
        SlideHistory.objects.using(postgres_app_db_alias())
        .filter(base_history__isnull=False)
        .values_list("base_history_id", flat=True)
    )
    if protected_snapshot_ids:
        expired_qs = expired_qs.exclude(id__in=protected_snapshot_ids)

    # TSV-014: 保护尚未迁移到 VersionHistory 的记录。
    # migrate_histories 通过 metadata.legacy_id 做幂等去重，
    # 如果 SlideHistory 在迁移前被清理，这些版本将永久丢失。
    unmigrated_ids = _get_unmigrated_slide_history_ids(expired_qs)
    if unmigrated_ids:
        expired_qs = expired_qs.exclude(id__in=unmigrated_ids)
        logger.warning(
            "Protected %d unmigrated SlideHistory records from cleanup "
            "(run `manage.py migrate_histories --module=slide` to migrate)",
            len(unmigrated_ids),
        )

    expired_count = expired_qs.count()
    if expired_count > 0:
        expired_qs.delete()
        logger.info("Deleted %d expired SlideHistory records", expired_count)

    # 基于“当前仍存在的 diff”重新计算保护集合，供降采样使用。
    referenced_snapshot_ids = set(
        SlideHistory.objects.using(postgres_app_db_alias())
        .filter(base_history__isnull=False)
        .values_list("base_history_id", flat=True)
    )

    # ── 第 2 步: 分级降采样 ──
    downsample_count = 0

    boundary_1d = now - timedelta(days=1)
    boundary_7d = now - timedelta(days=7)
    boundary_30d = now - timedelta(days=30)
    boundary_90d = now - timedelta(days=90)

    # 1-7 天前: 每小时保留 1 个
    downsample_count += _downsample_range(
        boundary_7d,
        boundary_1d,
        "hour",
        protected_snapshot_ids=referenced_snapshot_ids,
    )

    # 7-30 天前: 每天保留 1 个
    downsample_count += _downsample_range(
        boundary_30d,
        boundary_7d,
        "day",
        protected_snapshot_ids=referenced_snapshot_ids,
    )

    # 30-90 天前: 每周保留 1 个（覆盖 TEAM 用户 90 天 TTL 区间）
    downsample_count += _downsample_range(
        boundary_90d,
        boundary_30d,
        "week",
        protected_snapshot_ids=referenced_snapshot_ids,
    )

    if downsample_count > 0:
        logger.info("Downsampled %d SlideHistory records", downsample_count)

    # P3-9: 统计全量未迁移到 VersionHistory 的 SlideHistory 记录数
    try:
        from apps.collab.models import VersionHistory
        total_slide_history = SlideHistory.objects.using(postgres_app_db_alias()).count()
        migrated_count = (
            VersionHistory.objects.using(postgres_app_db_alias())
            .filter(resource_type="slide")
            .values("metadata__legacy_id")
            .distinct()
            .count()
        )
        unmigrated_count = max(total_slide_history - migrated_count, 0)
        if unmigrated_count > 0:
            logger.info(
                "SlideHistory migration progress: %d/%d records remaining to migrate",
                unmigrated_count, total_slide_history,
            )
    except Exception:
        logger.debug("SlideHistory migration progress check failed", exc_info=True)

    logger.info(
        "cleanup_slide_history completed: expired=%d, downsampled=%d",
        expired_count, downsample_count,
    )


def _downsample_range(
    start,
    end,
    truncate_to: str,
    *,
    protected_snapshot_ids: set | None = None,
) -> int:
    """
    对指定时间范围内的 SlideHistory 进行降采样。

    保留每个 (project, time_bucket) 中最新的一条，删除其余的。
    """
    from apps.tabslide.models import SlideHistory

    qs = SlideHistory.objects.using(postgres_app_db_alias()).filter(
        created_at__gte=start,
        created_at__lt=end,
        is_named=False,
        pinned=False,
    )

    if not qs.exists():
        return 0

    trunc_map = {"hour": TruncHour, "day": TruncDay, "week": TruncWeek}
    TruncFunc = trunc_map.get(truncate_to, TruncDay)

    groups = (
        qs.annotate(bucket=TruncFunc("created_at"))
        .values("project_id", "bucket")
        .annotate(
            cnt=Count("id"),
        )
        .filter(cnt__gt=1)
    )

    deleted_count = 0
    for group in groups:
        bucket_qs = (
            qs.filter(project_id=group["project_id"])
            .annotate(bucket=TruncFunc("created_at"))
            .filter(bucket=group["bucket"])
        )
        # UUID 不能代表时间顺序，按 created_at（同秒再按 id）选真正最新。
        keep_id = bucket_qs.order_by("-created_at", "-id").values_list("id", flat=True).first()

        to_delete = bucket_qs.exclude(id=keep_id)
        if protected_snapshot_ids:
            to_delete = to_delete.exclude(id__in=protected_snapshot_ids)
        to_delete = to_delete.exclude(is_snapshot=True)

        cnt = to_delete.count()
        if cnt > 0:
            to_delete.delete()
            deleted_count += cnt

    return deleted_count


# ═══════════════════════════════════════════════════════════════════
# 任务 3: 字体 base64 → OSS 迁移（一次性/按需执行）
# ═══════════════════════════════════════════════════════════════════

@shared_task(name="tabslide.migrate_fonts_to_oss", bind=True, max_retries=1, time_limit=300, soft_time_limit=280)
def migrate_fonts_to_oss(self, batch_size: int = 50):
    """
    将旧项目中 font_meta.embedded_fonts[].data_base64 迁移到 OSS。

    找到所有 font_meta 中包含 data_base64（但没有 oss_url）的项目，
    逐个上传 OSS 并更新 DB。
    """
    from apps.tabslide.models import SlideProject
    from apps.tabslide.services.slide_service import SlideService

    projects = (
        SlideProject.objects.using(postgres_app_db_alias())
        .filter(font_meta__isnull=False, status="active")
        .order_by("-updated_at")[:batch_size]
    )

    migrated = 0
    for project in projects:
        if not project.font_meta or not isinstance(project.font_meta, dict):
            continue

        embedded = project.font_meta.get("embedded_fonts", [])
        if not isinstance(embedded, list):
            continue

        needs_migration = any(
            isinstance(f, dict) and f.get("data_base64") and not f.get("oss_url")
            for f in embedded
        )
        if not needs_migration:
            continue

        try:
            new_embedded = SlideService.upload_fonts_to_oss(
                embedded,
                organization_id=str(getattr(project, "organization_id", "")),
                user_id=str(getattr(project, "created_by_id", "") or ""),
                context_id=str(project.id),
            )
            has_change = any(
                isinstance(f, dict) and f.get("oss_url") and not embedded[i].get("oss_url")
                for i, f in enumerate(new_embedded)
                if i < len(embedded)
            )
            if has_change:
                project.font_meta["embedded_fonts"] = new_embedded
                project.save(update_fields=["font_meta"])
                migrated += 1
                logger.info("Migrated fonts to OSS for project %s", project.id)
        except Exception as e:
            logger.warning("Font migration failed for project %s: %s", project.id, e)

    logger.info("migrate_fonts_to_oss completed: migrated=%d/%d", migrated, len(projects))


# refresh_pages_cache — REMOVED
# SlidePage 是唯一 source of truth，不再反向同步 pages_data。
# 参见 docs/tabslide/single-source-of-truth.md


# ═══════════════════════════════════════════════════════════════════
# 任务 4: 异步 PPTX 预生成（Phase 3）
# ═══════════════════════════════════════════════════════════════════

@shared_task(name="tabslide.pregenerate_pptx", bind=True, max_retries=1, time_limit=300, soft_time_limit=280)
def pregenerate_pptx(self, project_id: str):
    """
    Phase 3: 异步预生成 PPTX 缓存。

    在保存后调用，使用户在导出时无需等待 PPTX 生成。
    只在 pptx_dirty=True 时生成，避免重复工作。

    CRT-14: 使用 Redis 锁实现项目级并发去重，用户快速保存 N 次
    只有第一个任务执行，其余跳过。
    """
    from django.core.cache import cache as django_cache
    from apps.tabslide.models import SlideProject
    from apps.tabslide.services.slide_service import SlideService

    lock_key = f"lock:pregenerate_pptx:{project_id}"
    if not django_cache.add(lock_key, "1", timeout=290):
        logger.debug("pregenerate_pptx: skipped (locked) project=%s", project_id)
        return

    try:
        try:
            project = SlideProject.objects.using(postgres_app_db_alias()).get(id=project_id)
        except SlideProject.DoesNotExist:
            logger.warning("pregenerate_pptx: project %s not found", project_id)
            return

        if not project.pptx_dirty:
            logger.debug("pregenerate_pptx: project %s not dirty, skipping", project_id)
            return

        try:
            pages = SlideService._read_pages_from_slide_pages(project)
            if not pages:
                logger.debug("pregenerate_pptx: project %s has no pages", project_id)
                return

            from apps.tabslide.services.pptx_cache import generate_and_cache_pptx
            oss_url = generate_and_cache_pptx(project, pages)
            if oss_url:
                logger.info("pregenerate_pptx: project=%s cached at %s", project_id, oss_url[:60])
            else:
                logger.debug("pregenerate_pptx: project=%s OSS unavailable", project_id)

        except Exception as exc:
            logger.warning("pregenerate_pptx failed for project %s: %s", project_id, exc)
            raise self.retry(countdown=60) from exc
    finally:
        django_cache.delete(lock_key)


@shared_task(name="tabslide.cleanup_page_cache", bind=True, max_retries=1, ignore_result=True, time_limit=300, soft_time_limit=280)
def cleanup_page_cache(self):
    """
    Phase 3: 清理已归档项目和过期的页面缓存。

    由 Celery Beat 每天触发。
    """
    from apps.tabslide.models import SlidePageCache, SlideProject

    now = timezone.now()

    # 清理已归档项目的缓存
    archived_ids = list(
        SlideProject.objects.using(postgres_app_db_alias())
        .filter(status="archived")
        .values_list("id", flat=True)
    )
    archived_deleted = 0
    if archived_ids:
        archived_deleted = SlidePageCache.objects.using(postgres_app_db_alias()).filter(
            project_id__in=archived_ids,
        ).delete()[0]

    # 清理 30 天未更新的缓存
    stale_boundary = now - timedelta(days=30)
    stale_deleted = SlidePageCache.objects.using(postgres_app_db_alias()).filter(
        updated_at__lt=stale_boundary,
    ).delete()[0]

    logger.info(
        "cleanup_page_cache: archived=%d stale=%d",
        archived_deleted, stale_deleted,
    )


# ═══════════════════════════════════════════════════════════════════
# 任务 6: SlideElementChange TTL 清理
# ═══════════════════════════════════════════════════════════════════

_ELEMENT_CHANGE_RETENTION_DAYS = 30
_ELEMENT_CHANGE_BATCH_SIZE = 2000


@shared_task(
    name="tabslide.cleanup_element_changes",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_element_changes(retention_days: int = _ELEMENT_CHANGE_RETENTION_DAYS):
    """清理过期的 SlideElementChange 记录。

    模型文档声明 TTL 30 天自动过期，此任务实现实际清理。
    由 Celery Beat 每天执行。
    """
    from apps.tabslide.models import SlideElementChange

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0

    while True:
        batch_ids = list(
            SlideElementChange.objects.using(postgres_app_db_alias())
            .filter(created_at__lt=cutoff)
            .values_list("id", flat=True)[:_ELEMENT_CHANGE_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = (
            SlideElementChange.objects.using(postgres_app_db_alias())
            .filter(id__in=batch_ids)
            .delete()
        )
        total_deleted += deleted

    if total_deleted:
        logger.info(
            "cleanup_element_changes: deleted=%d retention=%d days",
            total_deleted, retention_days,
        )


# ═══════════════════════════════════════════════════════════════════
# 任务 7: CRT-01 PPTX 异步导入
# ═══════════════════════════════════════════════════════════════════

IMPORT_PPTX_CACHE_PREFIX = "import_pptx:"
IMPORT_PPTX_CACHE_TTL = 3600


@shared_task(
    name="tabslide.import_pptx_task",
    bind=True,
    max_retries=0,
    time_limit=600,
    soft_time_limit=560,
    ignore_result=True,
)
def import_pptx_task(
    self,
    file_path: str,
    organization_id: str,
    space_id: str,
    file_name: str,
    user_id: str,
    agent_run_id: str = "",
    collection_id: str = "",
):
    """
    兼容部署前已入队的旧任务。

    旧任务仍只携带 API Pod 的本地路径；在多 Pod 环境中可能按原有行为失败，
    但保留任务名和参数契约，确保滚动发布期间不会因未知参数直接丢任务。
    """
    return _execute_import_pptx_task(
        task_id=self.request.id,
        file_path=file_path,
        organization_id=organization_id,
        space_id=space_id,
        file_name=file_name,
        user_id=user_id,
        agent_run_id=agent_run_id,
        collection_id=collection_id,
    )


@shared_task(
    name="tabslide.import_pptx_oss_task",
    bind=True,
    max_retries=0,
    time_limit=600,
    soft_time_limit=560,
    ignore_result=True,
)
def import_pptx_oss_task(
    self,
    object_key: str,
    organization_id: str,
    space_id: str,
    file_name: str,
    user_id: str,
    agent_run_id: str = "",
    collection_id: str = "",
):
    """从 OSS 临时对象导入 PPTX；使用独立队列隔离旧 worker。"""
    return _execute_import_pptx_task(
        task_id=self.request.id,
        file_path="",
        object_key=object_key,
        organization_id=organization_id,
        space_id=space_id,
        file_name=file_name,
        user_id=user_id,
        agent_run_id=agent_run_id,
        collection_id=collection_id,
    )


def _execute_import_pptx_task(
    *,
    task_id: str,
    file_path: str,
    organization_id: str,
    space_id: str,
    file_name: str,
    user_id: str,
    agent_run_id: str = "",
    collection_id: str = "",
    object_key: str = "",
):
    """执行 PPTX 导入，并维护轮询状态及临时文件生命周期。"""
    from django.core.cache import cache

    cache_key = f"{IMPORT_PPTX_CACHE_PREFIX}{task_id}"
    local_file_path = file_path
    oss_service = None
    source_type = "oss" if object_key else "legacy_local_path"

    def _update_progress(stage: str, **extra):
        cache.set(cache_key, {"status": "processing", "stage": stage, **extra}, timeout=IMPORT_PPTX_CACHE_TTL)
        logger.info(
            "import_pptx_task stage: task=%s stage=%s source=%s",
            task_id,
            stage,
            source_type,
        )

    try:
        _update_progress("validating")

        if object_key:
            _validate_pptx_import_object_key(object_key)
            from apps.services.oss.services.factory import get_oss_service

            oss_service = get_oss_service()
            tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
            local_file_path = tmp.name
            tmp.close()
            _update_progress("downloading")
            download_result = oss_service.download_file(
                object_key,
                local_path=local_file_path,
            )
            if not download_result.get("success"):
                raise RuntimeError(
                    download_result.get("message") or "PPTX 临时文件下载失败"
                )
        elif not local_file_path:
            raise ValueError("PPTX 导入缺少源文件")

        from django.contrib.auth import get_user_model
        User = get_user_model()
        user = User.objects.get(id=user_id)

        from apps.tabslide.services.slide_service import SlideService
        svc = SlideService(user=user)

        _update_progress("parsing")

        def _file_chunks(path, chunk_size=50 * 1024 * 1024):
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk

        project, pages = svc.import_pptx(
            organization_id=organization_id,
            space_id=space_id,
            file_name=file_name,
            file_chunks=_file_chunks(local_file_path),
            agent_run_id=agent_run_id,
            collection_id=collection_id or None,
        )

        font_meta = svc.get_font_meta(project)
        cache.set(cache_key, {
            "status": "completed",
            "project_id": str(project.id),
            "page_count": len(pages),
            "embedded_fonts": font_meta.get("embedded_fonts"),
            "theme_fonts": font_meta.get("theme_fonts"),
        }, timeout=IMPORT_PPTX_CACHE_TTL)

        logger.info(
            "import_pptx_task completed: task=%s project=%s pages=%d source=%s",
            task_id,
            project.id,
            len(pages),
            source_type,
        )

    except Exception as exc:
        logger.error(
            "import_pptx_task failed: task=%s source=%s error_type=%s",
            task_id,
            source_type,
            type(exc).__name__,
        )
        cache.set(cache_key, {
            "status": "failed",
            "error": "PPTX 导入失败，请稍后重试",
        }, timeout=IMPORT_PPTX_CACHE_TTL)
        raise RuntimeError("PPTX import failed") from None

    finally:
        if local_file_path:
            try:
                os.unlink(local_file_path)
            except OSError as cleanup_error:
                logger.warning(
                    "import_pptx_task local cleanup failed: task=%s source=%s error_type=%s",
                    task_id,
                    source_type,
                    type(cleanup_error).__name__,
                )
        if object_key and oss_service is not None:
            try:
                delete_result = oss_service.delete_file(object_key)
                if not delete_result.get("success"):
                    logger.warning(
                        "import_pptx_task OSS cleanup rejected: task=%s",
                        task_id,
                    )
            except Exception as cleanup_error:
                logger.warning(
                    "import_pptx_task OSS cleanup failed: task=%s error_type=%s",
                    task_id,
                    type(cleanup_error).__name__,
                )
