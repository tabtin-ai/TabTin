"""
TabData 历史记录 TTL 清理 + 分级降采样任务

策略对齐 TabDoc/TabSlide：
  - 最近 24h：保留所有
  - 1-7 天前：每小时保留 1 条
  - 7-30 天前：每天保留 1 条
  - 过期后：删除（expired_at < now）
"""
import logging
import threading
from datetime import timedelta
from time import monotonic

from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone

logger = logging.getLogger("tabdata.tasks.history")

HISTORY_TTL_FREE = 7 * 24 * 3600
HISTORY_TTL_PRO = 30 * 24 * 3600
HISTORY_TTL_TEAM = 90 * 24 * 3600

_TIER_TTL_MAP = {
    "free": HISTORY_TTL_FREE,
    "basic": HISTORY_TTL_PRO,
    "pro": HISTORY_TTL_PRO,
    "enterprise": HISTORY_TTL_TEAM,
}

def resolve_history_ttl_for_record(record) -> int:
    """根据记录所属表的组织解析 TTL（秒）。

    优先从 record.table 缓存读取 organization_id，
    fallback 到单列查询 Table.organization_id，异常时降级为 FREE。
    """
    try:
        table = getattr(record, "table", None)
        wid = getattr(table, "organization_id", None) if table else None
        if wid is None:
            table_id = getattr(record, "table_id", None)
            if table_id:
                from apps.tabdata.models import Table
                wid = (
                    Table.objects.using("postgresql")
                    .filter(id=table_id)
                    .values_list("organization_id", flat=True)
                    .first()
                )
        return _resolve_history_ttl(wid)
    except Exception:
        logger.debug("resolve_history_ttl_for_record failed, using free TTL", exc_info=True)
        return HISTORY_TTL_FREE


def resolve_history_ttl_for_table(table) -> int:
    """根据表的组织解析 TTL（秒），异常时降级为 FREE。"""
    try:
        wid = getattr(table, "organization_id", None)
        return _resolve_history_ttl(wid)
    except Exception:
        logger.debug("resolve_history_ttl_for_table failed, using free TTL", exc_info=True)
        return HISTORY_TTL_FREE


_ttl_cache: dict[str, tuple[int, float]] = {}
_ttl_cache_lock = threading.Lock()
_TTL_CACHE_SECONDS = 60

_EXPIRED_BATCH_SIZE = 2000


def _get_vh_protected_history_ids(start=None) -> set:
    """获取新系统 VersionHistory(is_named=True) 间接关联的受保护 RecordHistory IDs。

    VH 命名版本通过 created_at 时间点间接关联 RecordHistory：
    对每个 table 类型的命名版本，用 DISTINCT ON 找出其创建时刻
    各记录的最新 RecordHistory，纳入保护集合。

    Args:
        start: 可选，仅查询 created_at >= start 的 VH（降采样场景使用）。
               为 None 时查询所有命名 VH（回填场景使用）。
    """
    from django.db import connections
    from apps.collab.models import VersionHistory

    vh_qs = VersionHistory.objects.using("postgresql").filter(
        is_named=True,
        resource_type="table",
    )
    if start is not None:
        vh_qs = vh_qs.filter(created_at__gte=start)

    named_vhs = list(vh_qs.values_list("resource_id", "created_at"))
    if not named_vhs:
        return set()

    protected = set()
    conn = connections["postgresql"]
    for table_id, vh_created_at in named_vhs:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT DISTINCT ON (rh.record_id) rh.id
                FROM tabdata_history rh
                INNER JOIN tabdata_record tr ON rh.record_id = tr.id
                WHERE tr.table_id = %s
                  AND rh.created_at <= %s
                  AND rh.is_undone = false
                ORDER BY rh.record_id, rh.created_at DESC
                """,
                [str(table_id), vh_created_at],
            )
            protected.update(row[0] for row in cursor.fetchall())

    if protected:
        logger.debug(
            "VH named-version protection: %d RecordHistory IDs from %d VHs",
            len(protected), len(named_vhs),
        )
    return protected


def _resolve_history_ttl(organization_id) -> int:
    """根据组织会员等级返回历史版本 TTL（秒）。

    对齐 TabDoc/TabSlide 的同名函数。
    结果按 organization_id 缓存 60 秒，避免高频写入时重复查询 MySQL。
    """
    if not organization_id:
        return HISTORY_TTL_FREE

    cache_key = str(organization_id)
    now = monotonic()
    with _ttl_cache_lock:
        cached = _ttl_cache.get(cache_key)
        if cached is not None and cached[1] > now:
            return cached[0]

    try:
        from apps.users.membership.models import OrganizationMembership

        ws = OrganizationMembership.objects.select_related("tier").filter(
            organization_id=cache_key,
            status="active",
        ).first()
        if ws is None:
            ttl = HISTORY_TTL_FREE
        elif ws.end_date is not None and ws.end_date < timezone.now():
            ttl = HISTORY_TTL_FREE
        else:
            tier_type = getattr(ws.tier, "tier_type", None)
            ttl = _TIER_TTL_MAP.get(tier_type, HISTORY_TTL_FREE)
    except Exception:
        logger.debug(
            "Failed to resolve organization tier for %s, using free TTL",
            organization_id,
            exc_info=True,
        )
        ttl = HISTORY_TTL_FREE

    with _ttl_cache_lock:
        _ttl_cache[cache_key] = (ttl, now + _TTL_CACHE_SECONDS)
    return ttl

TABDATA_HISTORY_BEAT_SCHEDULE = {
    "tabdata-cleanup-history": {
        "task": "tabdata.cleanup_record_history",
        "schedule": 3600,
        "options": {"expires": 7200},
    },
    "tabdata-backfill-history-ttl": {
        "task": "tabdata.backfill_history_ttl",
        "schedule": 86400,
        "options": {"expires": 80000},
    },
}


@shared_task(
    name="tabdata.cleanup_record_history",
    bind=True,
    max_retries=1,
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_record_history(self):
    """
    清理过期的 RecordHistory + 分级降采样。

    由 Celery Beat 每小时触发。
    """
    from apps.tabdata.models import RecordHistory

    now = timezone.now()

    # Step 1: 分批删除已过期的记录
    expired_count = 0
    while True:
        batch_ids = list(
            RecordHistory.objects.using("postgresql")
            .filter(expired_at__lt=now, expired_at__isnull=False)
            .values_list("id", flat=True)[:_EXPIRED_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = RecordHistory.objects.using("postgresql").filter(id__in=batch_ids).delete()
        expired_count += deleted
    if expired_count > 0:
        logger.info("Deleted %d expired RecordHistory records", expired_count)

    # Step 2: 分级降采样
    downsample_count = 0

    # 1-7 天前: 每小时保留 1 条
    boundary_1d = now - timedelta(days=1)
    boundary_7d = now - timedelta(days=7)
    downsample_count += _downsample_record_history(boundary_7d, boundary_1d, "hour")

    # 7-30 天前: 每天保留 1 条
    boundary_30d = now - timedelta(days=30)
    downsample_count += _downsample_record_history(boundary_30d, boundary_7d, "day")

    # 30-90 天前: 每周保留 1 条（覆盖 Team 用户 90 天 TTL 区间，对齐 VH/SlideHistory）
    boundary_90d = now - timedelta(days=90)
    downsample_count += _downsample_record_history(boundary_90d, boundary_30d, "week")

    if downsample_count > 0:
        logger.info("Downsampled %d RecordHistory records", downsample_count)

    logger.info(
        "cleanup_record_history completed: expired=%d, downsampled=%d",
        expired_count, downsample_count,
    )


def _downsample_record_history(start, end, truncate_to: str) -> int:
    """对指定时间范围内的 RecordHistory 进行降采样。

    DATA-11: 使用 Window Function 一次查询找出所有待删 ID，
    再分批删除，避免原来的 per-group N+1 查询模式（5 万组 = 15 万次往返）。
    """
    from django.db import connections
    from apps.tabdata.models import RecordHistory, TableNamedVersion

    qs = RecordHistory.objects.using("postgresql").filter(
        created_at__gte=start,
        created_at__lt=end,
        is_undone=False,
    )

    if not qs.exists():
        return 0

    protected_ids = set(
        TableNamedVersion.objects.using("postgresql")
        .filter(history_id__isnull=False)
        .values_list("history_id", flat=True)
    )
    protected_ids |= _get_vh_protected_history_ids(start=start)

    _trunc_map = {"hour": "hour", "day": "day", "week": "week"}
    pg_trunc = _trunc_map.get(truncate_to, "day")
    trunc_expr = f"date_trunc('{pg_trunc}', created_at)"

    conn = connections["postgresql"]
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY record_id, {trunc_expr}
                           ORDER BY created_at DESC, id DESC
                       ) AS rn
                FROM {RecordHistory._meta.db_table}
                WHERE created_at >= %s
                  AND created_at < %s
                  AND is_undone = false
            ) ranked
            WHERE rn > 1
            """,
            [start, end],
        )
        ids_to_delete = [row[0] for row in cursor.fetchall()]

    if not ids_to_delete:
        return 0

    if protected_ids:
        ids_to_delete = [i for i in ids_to_delete if i not in protected_ids]

    if not ids_to_delete:
        return 0

    _DELETE_BATCH = 2000
    deleted_count = 0
    for i in range(0, len(ids_to_delete), _DELETE_BATCH):
        batch = ids_to_delete[i:i + _DELETE_BATCH]
        cnt, _ = (
            RecordHistory.objects.using("postgresql")
            .filter(id__in=batch)
            .delete()
        )
        deleted_count += cnt

    return deleted_count


@shared_task(
    name="tabdata.backfill_history_ttl",
    bind=True,
    max_retries=1,
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def backfill_history_ttl(self):
    """
    回填旧的 RecordHistory 的 expired_at 字段。

    DATA-29: 根据记录所属表的 organization 查询实际计划级别，
    赋予对应 TTL（Free=7d, Pro=30d, Team=90d），而非统一使用免费计划。
    同时回扫修正已错误设置为免费 TTL 的付费用户记录。

    每日运行一次，批量更新 10000 条。
    """
    from apps.tabdata.models import RecordHistory, Table, TableNamedVersion

    protected_ids = set(
        TableNamedVersion.objects.using("postgresql")
        .filter(history_id__isnull=False)
        .values_list("history_id", flat=True)
    )
    protected_ids |= _get_vh_protected_history_ids()

    now = timezone.now()

    # --- Phase 1: 回填 expired_at=NULL 的记录 ---
    qs = RecordHistory.objects.using("postgresql").filter(
        expired_at__isnull=True,
    )
    if protected_ids:
        qs = qs.exclude(id__in=protected_ids)

    batch = list(
        qs.values_list("id", "record__table_id")[:10000]
    )

    if batch:
        table_ids = {table_id for _, table_id in batch}
        organization_map = dict(
            Table.objects.using("postgresql")
            .filter(id__in=table_ids)
            .values_list("id", "organization_id")
        )

        ttl_cache = {}
        groups = {}  # ttl_seconds -> [history_id, ...]
        for history_id, table_id in batch:
            ws_id = organization_map.get(table_id)
            ws_key = str(ws_id) if ws_id else None
            if ws_key not in ttl_cache:
                ttl_cache[ws_key] = _resolve_history_ttl(ws_id)
            ttl = ttl_cache[ws_key]
            groups.setdefault(ttl, []).append(history_id)

        total_updated = 0
        for ttl_seconds, ids in groups.items():
            expired_at = now + timedelta(seconds=ttl_seconds)
            updated = RecordHistory.objects.using("postgresql").filter(
                id__in=ids,
            ).update(expired_at=expired_at)
            total_updated += updated

        logger.info("Backfilled expired_at for %d RecordHistory records", total_updated)

    # --- Phase 2: 回扫修正已错误设置为免费 TTL 的付费用户记录 ---
    free_expired_at_approx_start = now + timedelta(seconds=HISTORY_TTL_FREE - 86400)
    free_expired_at_approx_end = now + timedelta(seconds=HISTORY_TTL_FREE + 86400)

    misset_qs = RecordHistory.objects.using("postgresql").filter(
        expired_at__gte=free_expired_at_approx_start,
        expired_at__lte=free_expired_at_approx_end,
    )
    if protected_ids:
        misset_qs = misset_qs.exclude(id__in=protected_ids)

    misset_batch = list(
        misset_qs.values_list("id", "record__table_id")[:5000]
    )

    if misset_batch:
        table_ids = {table_id for _, table_id in misset_batch}
        organization_map = dict(
            Table.objects.using("postgresql")
            .filter(id__in=table_ids)
            .values_list("id", "organization_id")
        )

        ttl_cache = {}
        corrections = {}  # ttl_seconds -> [history_id, ...]
        for history_id, table_id in misset_batch:
            ws_id = organization_map.get(table_id)
            ws_key = str(ws_id) if ws_id else None
            if ws_key not in ttl_cache:
                ttl_cache[ws_key] = _resolve_history_ttl(ws_id)
            ttl = ttl_cache[ws_key]
            if ttl > HISTORY_TTL_FREE:
                corrections.setdefault(ttl, []).append(history_id)

        total_corrected = 0
        for ttl_seconds, ids in corrections.items():
            expired_at = now + timedelta(seconds=ttl_seconds)
            corrected = RecordHistory.objects.using("postgresql").filter(
                id__in=ids,
            ).update(expired_at=expired_at)
            total_corrected += corrected

        if total_corrected > 0:
            logger.info(
                "Corrected expired_at for %d RecordHistory records (paid users with wrong TTL)",
                total_corrected,
            )
