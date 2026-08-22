"""
view column_meta / columnMeta 兼容期观测辅助。

内部统一以 ``column_meta`` 为主；本模块只负责在 API 边界记录
legacy alias 的使用情况，方便后续评估下线窗口。
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from prometheus_client import Counter

_compat_logger = logging.getLogger('tabdata.deprecation.view_column_meta')
_WARN_FIRST_N = 5
_WARN_CHECKPOINTS = {10, 20, 50, 100}

VIEW_COLUMN_META_COMPAT_USAGE_TOTAL = Counter(
    'tabtin_view_column_meta_compat_usage_total',
    'Total deprecated view column meta alias usages observed at API boundaries',
    ['source', 'shape'],
)

_legacy_view_column_meta_alias_log_counts: dict[str, int] = defaultdict(int)
_legacy_view_column_meta_alias_usage_counts: dict[tuple[str, str], int] = defaultdict(int)


def log_legacy_view_column_meta_alias_usage(source: str, *, shape: str) -> int:
    """记录 legacy alias 使用，并对 warning 做简单节流。"""
    VIEW_COLUMN_META_COMPAT_USAGE_TOTAL.labels(source=source, shape=shape).inc()
    _legacy_view_column_meta_alias_usage_counts[(source, shape)] += 1

    count = _legacy_view_column_meta_alias_log_counts.get(source, 0) + 1
    _legacy_view_column_meta_alias_log_counts[source] = count
    if count <= _WARN_FIRST_N or count in _WARN_CHECKPOINTS:
        _compat_logger.warning(
            "[compat] deprecated view column meta alias used: source=%s shape=%s count=%s; prefer column_meta",
            source,
            shape,
            count,
            extra={
                'event': 'view_column_meta_legacy_alias',
                'compat_source': source,
                'compat_shape': shape,
                'compat_count': count,
            },
        )

    return count


def get_legacy_view_column_meta_alias_log_count(source: str) -> int:
    return _legacy_view_column_meta_alias_log_counts.get(source, 0)


def get_view_column_meta_compat_usage_total(source: str, shape: str) -> float:
    return float(
        VIEW_COLUMN_META_COMPAT_USAGE_TOTAL.labels(
            source=source,
            shape=shape,
        )._value.get(),
    )


def get_view_column_meta_compat_summary() -> dict[str, Any]:
    source_entries = [
        {
            'source': source,
            'shape': shape,
            'count': count,
        }
        for (source, shape), count in sorted(
            _legacy_view_column_meta_alias_usage_counts.items(),
            key=lambda item: (-item[1], item[0][0], item[0][1]),
        )
    ]
    return {
        'process_local': True,
        'prometheus_metric': 'tabtin_view_column_meta_compat_usage_total',
        'warning_throttle': {
            'warn_first_n': _WARN_FIRST_N,
            'warn_checkpoints': sorted(_WARN_CHECKPOINTS),
        },
        'total_legacy_alias_usages': sum(item['count'] for item in source_entries),
        'sources': source_entries,
    }


def reset_legacy_view_column_meta_alias_log_counts() -> None:
    _legacy_view_column_meta_alias_log_counts.clear()
    _legacy_view_column_meta_alias_usage_counts.clear()
