"""Electron 本机文件回退两阶段确认的短租约。

``rollback`` 已落对话投影、Host 尚未回填真实文件结果时，任何会消费或改写
这次回退的操作都必须停下。租约只负责拒绝过期 Host 的迟到回执；没有真实
fencing token 时，过期仅能把文件层标成结果未知，不能自动放行会消费时间线的
操作。
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Optional

from django.utils import timezone
from django.utils.dateparse import parse_datetime


FILE_RESTORE_FINALIZE_LEASE_SECONDS = 120


class FileRestoreFinalizePendingError(RuntimeError):
    def __init__(self, apply_id: str, *, result_unknown: bool = False):
        super().__init__(f"local file restore result is pending for apply {apply_id}")
        self.apply_id = apply_id
        self.result_unknown = result_unknown


def build_file_restore_finalize_expiry() -> str:
    return (
        timezone.now() + timedelta(seconds=FILE_RESTORE_FINALIZE_LEASE_SECONDS)
    ).isoformat()


def _entry_expiry(entry: dict[str, Any]):
    raw = entry.get('file_restore_finalize_expires_at')
    parsed = parse_datetime(str(raw)) if raw else None
    if parsed is not None:
        return parsed
    created = parse_datetime(str(entry.get('created_at') or ''))
    if created is not None:
        return created + timedelta(seconds=FILE_RESTORE_FINALIZE_LEASE_SECONDS)
    # 缺失/损坏的老 pending 不能永久锁死会话。
    return timezone.now() - timedelta(seconds=1)


def _latest_pending_index(history: list[dict[str, Any]]) -> Optional[int]:
    for index in range(len(history) - 1, -1, -1):
        entry = history[index]
        if (
            entry.get('type') == 'rollback'
            and entry.get('file_restore_finalize_required') is True
            and entry.get('file_restore_status') == 'pending'
        ):
            return index
    return None


def get_pending_file_restore_apply(session, *, expire: bool = True) -> Optional[dict[str, Any]]:
    """返回仍有效的 pending apply；到期时原位结算为结果未知并保持冻结。"""
    history = list(session.revert_history or [])
    index = _latest_pending_index(history)
    if index is None:
        return None

    entry = dict(history[index])
    if _entry_expiry(entry) > timezone.now():
        return entry
    if not expire:
        return None

    entry.update({
        'file_restore_status': 'failed',
        # 超时只代表没有拿到 Host 的最终回执，不能反推文件一定没恢复。
        'file_restore_reason': 'file_restore_result_unknown',
        'failed_files': [],
        'file_restore_finalize_required': False,
        # 没有真实 fencing token 时，超时不能自动放行会消费时间线的操作。
        # 保持冻结，只允许重新预览/后续显式恢复流程处理未知结果。
        'file_restore_reconfirmation_required': True,
        'file_restore_finalize_expired_at': timezone.now().isoformat(),
        'apply_result': 'partial_success',
        'partial_success_details': {
            'workspace_files': {
                'success': False,
                'status': 'failed',
                'reason': 'file_restore_result_unknown',
            },
        },
    })
    history[index] = entry
    session.revert_history = history
    session.save(update_fields=['revert_history', 'updated_at'])
    return None


def require_no_pending_file_restore(session) -> None:
    entry = get_pending_file_restore_apply(session)
    if entry is not None:
        raise FileRestoreFinalizePendingError(str(entry.get('apply_id') or 'unknown'))

    for candidate in reversed(list(session.revert_history or [])):
        if (
            candidate.get('type') == 'rollback'
            and candidate.get('file_restore_reconfirmation_required') is True
        ):
            raise FileRestoreFinalizePendingError(
                str(candidate.get('apply_id') or 'unknown'),
                result_unknown=True,
            )
