"""
API 日志异步任务

负责 ApiCallLog 的写入、批量写入、聚合统计和过期清理。
"""

import logging
from datetime import timedelta

from celery import shared_task
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)

# Batch size for cleanup deletions to avoid long-running transactions
CLEANUP_BATCH_SIZE = 10_000


# ── Celery Beat 定时调度 ──

API_LOG_BEAT_SCHEDULE = {
    "tabdata-aggregate-api-usage": {
        "task": "tabdata.aggregate_api_usage",
        "schedule": 3600,  # 每小时聚合一次
        "options": {"expires": 3000},
    },
    "tabdata-aggregate-daily-api-usage": {
        "task": "tabdata.aggregate_daily_api_usage",
        "schedule": 86400,  # 每天聚合一次
        "options": {"expires": 80000},
    },
    "tabdata-cleanup-api-logs": {
        "task": "tabdata.cleanup_old_api_logs",
        "schedule": 86400,  # 每天清理一次
        "options": {"expires": 80000},
    },
}


@shared_task(
    name='tabdata.write_api_log',
    ignore_result=True,
    max_retries=1,
    time_limit=300,
    soft_time_limit=280,
)
def write_api_log(log_data: dict):
    """写入单条 API 调用日志。"""
    from apps.tabdata.models_api_log import ApiCallLog

    # 解析 ISO 时间戳
    ts = log_data.get('timestamp')
    if isinstance(ts, str):
        from django.utils.dateparse import parse_datetime
        log_data['timestamp'] = parse_datetime(ts) or timezone.now()

    # 空字符串 UUID 字段转为 None
    for uuid_field in ('space_id', 'table_id'):
        val = log_data.get(uuid_field)
        if not val or val == 'None':
            log_data[uuid_field] = None

    ApiCallLog.objects.using(TABDATA_DB_ALIAS).create(**log_data)


@shared_task(
    name='tabdata.write_api_logs_batch',
    ignore_result=True,
    max_retries=1,
    time_limit=300,
    soft_time_limit=280,
)
def write_api_logs_batch(logs: list[dict]):
    """批量写入 API 调用日志。"""
    from apps.tabdata.models_api_log import ApiCallLog
    from django.utils.dateparse import parse_datetime

    objects = []
    for log_data in logs:
        # 解析时间戳
        ts = log_data.get('timestamp')
        if isinstance(ts, str):
            log_data['timestamp'] = parse_datetime(ts) or timezone.now()

        # 空字符串 UUID 字段转为 None
        for uuid_field in ('space_id', 'table_id'):
            val = log_data.get(uuid_field)
            if not val or val == 'None':
                log_data[uuid_field] = None

        objects.append(ApiCallLog(**log_data))

    if objects:
        ApiCallLog.objects.using(TABDATA_DB_ALIAS).bulk_create(objects)
        logger.info('批量写入 API 日志: %d 条', len(objects))


def _compute_p95(durations: list[int]) -> int:
    """Compute the P95 value from a sorted list of durations.

    Uses nearest-rank method: index = ceil(0.95 * N) - 1.
    Returns 0 for empty lists.
    """
    import math

    if not durations:
        return 0
    durations_sorted = sorted(durations)
    idx = max(0, math.ceil(0.95 * len(durations_sorted)) - 1)
    return durations_sorted[idx]


@shared_task(
    name='tabdata.aggregate_api_usage',
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def aggregate_api_usage():
    """
    聚合最近一小时的 ApiCallLog 到 ApiUsageSummary。

    按 organization_id × space_id × token_id × path_template 维度分组，
    计算请求数、成功/错误分布、耗时分位数、流量等指标。

    P95 computation: attempts PostgreSQL PERCENTILE_CONT first;
    falls back to Python-level sorting if raw SQL is unavailable.
    """
    from django.db import connections
    from django.db.models import Avg, Count, Max, Q, Sum

    from apps.tabdata.models_api_log import ApiCallLog, ApiUsageSummary

    now = timezone.now()
    # 聚合窗口：上一个整点小时
    period_end = now.replace(minute=0, second=0, microsecond=0)
    period_start = period_end - timedelta(hours=1)

    qs = (
        ApiCallLog.objects
        .using(TABDATA_DB_ALIAS)
        .filter(timestamp__gte=period_start, timestamp__lt=period_end)
        .values('organization_id', 'space_id', 'token_id', 'path_template')
        .annotate(
            total_requests=Count('id'),
            success_count=Count('id', filter=Q(status_code__gte=200, status_code__lt=300)),
            client_error_count=Count('id', filter=Q(status_code__gte=400, status_code__lt=500)),
            server_error_count=Count('id', filter=Q(status_code__gte=500)),
            rate_limited_count=Count('id', filter=Q(status_code=429)),
            avg_duration=Avg('duration_ms'),
            max_duration=Max('duration_ms'),
            total_bytes=Sum('response_size'),
        )
    )

    # Try to compute P95 via PostgreSQL PERCENTILE_CONT for all groups at once.
    p95_map = {}  # (organization_id, space_id, token_id, path_template) → p95
    try:
        conn = connections[TABDATA_DB_ALIAS]
        if conn.vendor == 'postgresql':
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT organization_id,
                           space_id::text,
                           COALESCE(token_id, ''),
                           COALESCE(path_template, ''),
                           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int
                    FROM tabdata_api_call_log
                    WHERE timestamp >= %s AND timestamp < %s
                    GROUP BY organization_id, space_id, token_id, path_template
                    """,
                    [period_start, period_end],
                )
                for row in cursor.fetchall():
                    key = (row[0], row[1] if row[1] != 'None' else None, row[2], row[3])
                    p95_map[key] = row[4] or 0
    except Exception:
        logger.debug('PostgreSQL PERCENTILE_CONT unavailable, falling back to Python P95')

    # If raw SQL approach didn't work, compute P95 in Python per group
    use_python_p95 = len(p95_map) == 0
    if use_python_p95:
        group_durations = {}  # same key → list[int]
        duration_qs = (
            ApiCallLog.objects
            .using(TABDATA_DB_ALIAS)
            .filter(timestamp__gte=period_start, timestamp__lt=period_end)
            .values_list('organization_id', 'space_id', 'token_id', 'path_template', 'duration_ms')
        )
        for ws, sp, tid, pt, dur in duration_qs:
            key = (ws, str(sp) if sp else None, tid or '', pt or '')
            group_durations.setdefault(key, []).append(dur or 0)
        for key, durs in group_durations.items():
            p95_map[key] = _compute_p95(durs)

    summaries = []
    for row in qs:
        sp_str = str(row['space_id']) if row['space_id'] else None
        key = (row['organization_id'], sp_str, row['token_id'] or '', row['path_template'] or '')
        p95_val = p95_map.get(key, 0)

        summaries.append(ApiUsageSummary(
            organization_id=row['organization_id'],
            space_id=row['space_id'],
            token_id=row['token_id'] or '',
            path_template=row['path_template'] or '',
            period_type='hour',
            period_start=period_start,
            total_requests=row['total_requests'],
            success_count=row['success_count'],
            client_error_count=row['client_error_count'],
            server_error_count=row['server_error_count'],
            rate_limited_count=row['rate_limited_count'],
            avg_duration_ms=int(row['avg_duration'] or 0),
            p95_duration_ms=p95_val,
            max_duration_ms=row['max_duration'] or 0,
            total_response_bytes=row['total_bytes'] or 0,
        ))

    if summaries:
        ApiUsageSummary.objects.using(TABDATA_DB_ALIAS).bulk_create(
            summaries,
            update_conflicts=True,
            unique_fields=[
                'organization_id', 'space_id', 'token_id',
                'path_template', 'period_type', 'period_start',
            ],
            update_fields=[
                'total_requests', 'success_count', 'client_error_count',
                'server_error_count', 'rate_limited_count',
                'avg_duration_ms', 'p95_duration_ms', 'max_duration_ms',
                'total_response_bytes',
            ],
        )
        logger.info(
            '聚合 API 用量: period=%s → %s, 维度=%d',
            period_start.isoformat(), period_end.isoformat(), len(summaries),
        )


@shared_task(
    name='tabdata.aggregate_daily_api_usage',
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def aggregate_daily_api_usage():
    """
    Roll up hourly ApiUsageSummary rows into daily summaries.

    Runs once per day. Aggregates the previous calendar day's hourly data
    by organization_id x space_id x token_id x path_template.

    avg_duration_ms is computed as a weighted average (weighted by total_requests).
    p95_duration_ms takes the max of hourly P95 values (conservative upper bound).
    """
    from django.db.models import Avg, Count, Max, Sum, F

    from apps.tabdata.models_api_log import ApiUsageSummary

    now = timezone.now()
    # Aggregate window: previous calendar day (UTC)
    day_end = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start = day_end - timedelta(days=1)

    qs = (
        ApiUsageSummary.objects
        .using(TABDATA_DB_ALIAS)
        .filter(
            period_type='hour',
            period_start__gte=day_start,
            period_start__lt=day_end,
        )
        .values('organization_id', 'space_id', 'token_id', 'path_template')
        .annotate(
            total_requests=Sum('total_requests'),
            success_count=Sum('success_count'),
            client_error_count=Sum('client_error_count'),
            server_error_count=Sum('server_error_count'),
            rate_limited_count=Sum('rate_limited_count'),
            _weighted_duration_sum=Sum(F('avg_duration_ms') * F('total_requests')),
            p95_duration_ms=Max('p95_duration_ms'),
            max_duration_ms=Max('max_duration_ms'),
            total_response_bytes=Sum('total_response_bytes'),
        )
    )

    summaries = []
    for row in qs:
        total_reqs = row['total_requests'] or 0
        weighted_sum = row['_weighted_duration_sum'] or 0
        weighted_avg = round(weighted_sum / total_reqs) if total_reqs > 0 else 0

        summaries.append(ApiUsageSummary(
            organization_id=row['organization_id'],
            space_id=row['space_id'],
            token_id=row['token_id'] or '',
            path_template=row['path_template'] or '',
            period_type='day',
            period_start=day_start,
            total_requests=total_reqs,
            success_count=row['success_count'],
            client_error_count=row['client_error_count'],
            server_error_count=row['server_error_count'],
            rate_limited_count=row['rate_limited_count'],
            avg_duration_ms=weighted_avg,
            p95_duration_ms=row['p95_duration_ms'] or 0,
            max_duration_ms=row['max_duration_ms'] or 0,
            total_response_bytes=row['total_response_bytes'] or 0,
        ))

    if summaries:
        ApiUsageSummary.objects.using(TABDATA_DB_ALIAS).bulk_create(
            summaries,
            update_conflicts=True,
            unique_fields=[
                'organization_id', 'space_id', 'token_id',
                'path_template', 'period_type', 'period_start',
            ],
            update_fields=[
                'total_requests', 'success_count', 'client_error_count',
                'server_error_count', 'rate_limited_count',
                'avg_duration_ms', 'p95_duration_ms', 'max_duration_ms',
                'total_response_bytes',
            ],
        )
        logger.info(
            'Daily aggregation: period=%s → %s, groups=%d',
            day_start.isoformat(), day_end.isoformat(), len(summaries),
        )


@shared_task(
    name='tabdata.cleanup_old_api_logs',
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def cleanup_old_api_logs():
    """
    清理过期 API 日志。

    - ApiCallLog: 保留 30 天
    - ApiUsageSummary (hourly): 保留 90 天

    Deletes in batches of CLEANUP_BATCH_SIZE to avoid long-running
    transactions and excessive lock contention.
    """
    from apps.tabdata.models_api_log import ApiCallLog, ApiUsageSummary

    now = timezone.now()

    # Clean up ApiCallLog older than 30 days (in batches)
    log_cutoff = now - timedelta(days=30)
    total_deleted_logs = 0
    while True:
        batch_ids = list(
            ApiCallLog.objects
            .using(TABDATA_DB_ALIAS)
            .filter(timestamp__lt=log_cutoff)
            .values_list('id', flat=True)[:CLEANUP_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = (
            ApiCallLog.objects
            .using(TABDATA_DB_ALIAS)
            .filter(id__in=batch_ids)
            .delete()
        )
        total_deleted_logs += deleted
        logger.debug('API log cleanup batch: deleted %d rows', deleted)

    # Clean up hourly summaries older than 90 days (in batches)
    summary_cutoff = now - timedelta(days=90)
    total_deleted_summaries = 0
    while True:
        batch_ids = list(
            ApiUsageSummary.objects
            .using(TABDATA_DB_ALIAS)
            .filter(period_type='hour', period_start__lt=summary_cutoff)
            .values_list('id', flat=True)[:CLEANUP_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = (
            ApiUsageSummary.objects
            .using(TABDATA_DB_ALIAS)
            .filter(id__in=batch_ids)
            .delete()
        )
        total_deleted_summaries += deleted
        logger.debug('API summary cleanup batch: deleted %d rows', deleted)

    # DATA-32: Clean up daily summaries older than 365 days (in batches)
    daily_cutoff = now - timedelta(days=365)
    total_deleted_daily = 0
    while True:
        batch_ids = list(
            ApiUsageSummary.objects
            .using(TABDATA_DB_ALIAS)
            .filter(period_type='day', period_start__lt=daily_cutoff)
            .values_list('id', flat=True)[:CLEANUP_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = (
            ApiUsageSummary.objects
            .using(TABDATA_DB_ALIAS)
            .filter(id__in=batch_ids)
            .delete()
        )
        total_deleted_daily += deleted
        logger.debug('API daily summary cleanup batch: deleted %d rows', deleted)

    logger.info(
        'API log cleanup complete: logs=%d (>30d), hourly_summaries=%d (>90d), daily_summaries=%d (>365d)',
        total_deleted_logs, total_deleted_summaries, total_deleted_daily,
    )
