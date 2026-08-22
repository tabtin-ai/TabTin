"""
视图版本同步工具

提供单调版本 token 的编解码、增量变更检测和过滤功能。
从 view_data_service.py 拆分而来。
"""
from typing import Dict, Optional
from datetime import datetime

from django.conf import settings
from django.db.models import F, QuerySet, Max
from django.db.models.functions import Greatest
from django.utils import timezone

from .view_constants import VERSION_TOKEN_BASE_DEFAULT


def get_version_token_base() -> int:
    raw_value = getattr(settings, "TABDATA_VERSION_TOKEN_BASE", VERSION_TOKEN_BASE_DEFAULT)
    try:
        base = int(raw_value)
    except (TypeError, ValueError):
        base = VERSION_TOKEN_BASE_DEFAULT
    if base <= 2_000_000_000_000 or base >= 9_000_000_000_000_000:
        return VERSION_TOKEN_BASE_DEFAULT
    return base


def is_monotonic_version_token(version_value: Optional[int]) -> bool:
    if version_value is None:
        return False
    try:
        normalized = int(version_value)
    except (TypeError, ValueError):
        return False
    return normalized >= get_version_token_base()


def encode_monotonic_version_token(latest_record_version: int) -> int:
    if latest_record_version <= 0:
        return 0
    return get_version_token_base() + int(latest_record_version)


def decode_monotonic_version_token(version_token: int) -> int:
    return max(0, int(version_token) - get_version_token_base())


def get_table_record_version_state(*, table_id, db_alias: str) -> Dict[str, int]:
    from apps.tabdata.models import Table

    values = (
        Table.objects.using(db_alias)
        .filter(id=table_id)
        .values('record_version_seq', 'record_delete_version')
        .first()
        or {}
    )
    return {
        'latest_record_version': int(values.get('record_version_seq') or 0),
        'latest_delete_version': int(values.get('record_delete_version') or 0),
    }


def mark_table_record_delete_version(*, table_id, version: int, db_alias: str) -> None:
    """Advance the table delete watermark without allowing concurrent writers to regress it."""
    from apps.tabdata.models import Table

    Table.objects.using(db_alias).filter(id=table_id).update(
        record_delete_version=Greatest(F('record_delete_version'), int(version)),
    )


def get_latest_version_state(
    queryset: QuerySet,
    *,
    table_id=None,
) -> Dict[str, int]:
    summary = queryset.aggregate(max_updated=Max('updated_at'), max_version=Max('version'))
    latest_updated = summary.get('max_updated')
    latest_updated_ms = int(latest_updated.timestamp() * 1000) if latest_updated else 0
    latest_record_version = int(summary.get('max_version') or 0)
    latest_delete_version = 0
    if table_id is not None:
        table_state = get_table_record_version_state(
            table_id=table_id,
            db_alias=queryset.db,
        )
        latest_record_version = max(
            latest_record_version,
            table_state['latest_record_version'],
        )
        latest_delete_version = table_state['latest_delete_version']
    if latest_record_version > 0:
        latest_version = encode_monotonic_version_token(latest_record_version)
    else:
        latest_version = latest_updated_ms
    return {
        'latest_version': int(latest_version),
        'latest_updated_ms': int(latest_updated_ms),
        'latest_record_version': int(latest_record_version),
        'latest_delete_version': int(latest_delete_version),
    }


def get_latest_version(queryset: QuerySet, *, table_id=None) -> int:
    """
    获取同步版本号（优先单调 version token）。

    token 规则：
    - 新语义：base + record.version（base 默认 4e12）
    - 旧兼容：无 version 时回退 updated_at 毫秒时间戳
    """
    return int(get_latest_version_state(queryset, table_id=table_id)['latest_version'])


def has_changes_since_version(
    *,
    since_version: Optional[int],
    version_state: Dict[str, int],
) -> bool:
    if since_version is None:
        return True

    try:
        since_value = int(since_version)
    except (TypeError, ValueError):
        return True
    if since_value == 0:
        return True

    if is_monotonic_version_token(since_value):
        return int(version_state['latest_record_version']) > decode_monotonic_version_token(since_value)

    return int(version_state['latest_updated_ms']) > since_value


def requires_full_reload_since_version(
    *,
    since_version: Optional[int],
    version_state: Dict[str, int],
) -> bool:
    """物理删除无法作为记录增量返回；客户端落后于删除水位时必须全量刷新。"""
    if since_version is None:
        return False

    latest_delete_version = int(version_state.get('latest_delete_version') or 0)
    if latest_delete_version <= 0:
        return False

    try:
        since_value = int(since_version)
    except (TypeError, ValueError):
        return True

    # since_version=0 is the current explicit full-bootstrap contract used by
    # local replica reconciliation. It must return all active rows, not an
    # empty reload sentinel that the replica could mistake for an empty table.
    if since_value == 0:
        return False

    if is_monotonic_version_token(since_value):
        return latest_delete_version > decode_monotonic_version_token(since_value)

    # 旧时间戳 token 不能与单调删除版本可靠比较；触发一次全量刷新后，
    # 客户端会拿到新的单调 token，后续即可精确比较。
    return True


def filter_queryset_since_version(queryset: QuerySet, since_version: int) -> QuerySet:
    """
    按 since_version 过滤增量记录。

    - 新 token（base+version）走 version__gt
    - 旧时间戳 token 走 updated_at__gt
    """
    try:
        since_value = int(since_version)
    except (TypeError, ValueError):
        return queryset

    if is_monotonic_version_token(since_value):
        return queryset.filter(version__gt=decode_monotonic_version_token(since_value))

    try:
        since_datetime = datetime.fromtimestamp(
            since_value / 1000,
            tz=timezone.get_current_timezone()
        )
    except (OSError, OverflowError, ValueError):
        return queryset.none()
    return queryset.filter(updated_at__gt=since_datetime)
