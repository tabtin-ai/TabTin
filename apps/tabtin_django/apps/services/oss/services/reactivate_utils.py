"""通用 FileUsage 重激活 + 存储计费恢复工具函数。

与 deactivate_utils.py 对称，用于从回收站恢复资源时重新激活文件引用。
"""

import logging
from dataclasses import dataclass, field
from django.db import models as _models, transaction

logger = logging.getLogger(__name__)


class StorageQuotaExceededError(Exception):
    """存储配额超限，恢复操作被拒绝"""
    def __init__(self, organization_id: str, required_bytes: int, available_bytes: int):
        self.organization_id = organization_id
        self.required_bytes = required_bytes
        self.available_bytes = available_bytes
        super().__init__(
            f"Storage quota exceeded: organization={organization_id}, "
            f"required={required_bytes}, available={available_bytes}"
        )


@dataclass
class ReactivateResult:
    """重激活操作结果"""
    restored_count: int = 0
    failed_files: list = field(default_factory=list)

    @property
    def has_failures(self) -> bool:
        return len(self.failed_files) > 0


def check_restore_storage_quota(
    *,
    module: str,
    context_filter: dict,
    organization_id: str,
) -> dict:
    """预检查恢复操作所需的存储空间是否满足配额。

    Returns:
        dict 包含 allowed, total_bytes, evaluated 等信息。

    Raises:
        StorageQuotaExceededError: 如果配额不足。
    """
    from apps.services.oss.models import FileUsage

    qs = FileUsage.objects.filter(
        module=module,
        is_active=False,
        **context_filter,
    ).select_related("file_record")

    total_bytes = 0
    seen_file_ids: set[str] = set()
    for usage in qs:
        fr = usage.file_record
        fid = str(fr.id) if fr else ""
        if fr and fr.status != "deleted" and fr.file_size and fid not in seen_file_ids:
            total_bytes += fr.file_size
            seen_file_ids.add(fid)

    if total_bytes <= 0 or not organization_id:
        return {"allowed": True, "total_bytes": 0}

    try:
        from apps.services.billing.services import OrganizationStorageBillingService
        evaluation = OrganizationStorageBillingService.evaluate_storage_upload(
            organization_id=organization_id,
            incoming_bytes=total_bytes,
        )
        if not evaluation.get("allowed", True):
            raise StorageQuotaExceededError(
                organization_id=organization_id,
                required_bytes=total_bytes,
                available_bytes=evaluation.get("available_bytes", 0),
            )
        return {"allowed": True, "total_bytes": total_bytes, **evaluation}
    except StorageQuotaExceededError:
        raise
    except Exception as exc:
        # QTA-11 fix: 所有异常统一拒绝恢复，避免瞬时故障导致超限资源被放行
        logger.error(
            "Storage quota check 异常，拒绝恢复: organization=%s, err=%s",
            organization_id, exc,
        )
        raise RuntimeError(f"存储配额检查失败，无法安全恢复: {exc}") from exc


def reactivate_file_usages_and_restore_storage(
    *,
    module: str,
    context_filter: dict,
    organization_id: str,
    user_id: str = "",
    biz_type: str,
    biz_id: str,
    log_prefix: str = "",
) -> ReactivateResult:
    """重激活指定条件的 FileUsage 并恢复 organization 存储计量。

    与 deactivate_file_usages_and_release_storage 对称：
      - deactivate: is_active=True → False, ref_count--, storage--
      - reactivate: is_active=False → True, ref_count++, storage++

    Args:
        module: FileUsage.module 值（如 "tabvideo"、"tabslide"）。
        context_filter: 额外的 ORM 过滤条件（如 context_type、context_id / context_id__in）。
        organization_id: 组织 ID，为空则跳过计费恢复。
        user_id: 操作者 ID。
        biz_type: 计费事件业务类型。
        biz_id: 计费事件业务 ID。
        log_prefix: 日志前缀，便于定位来源模块。

    Returns:
        ReactivateResult: 包含恢复数量和失败文件列表。
        若 FileRecord 已被物理删除（status='deleted'），该条 usage 将被标记为失败。
    """
    from apps.services.oss.models import FileUsage

    prefix = f"{log_prefix} " if log_prefix else ""
    result = ReactivateResult()

    qs = FileUsage.objects.filter(
        module=module,
        is_active=False,
        **context_filter,
    ).select_related("file_record")

    from apps.services.oss.models import FileRecord as _FileRecord

    billed_file_ids: set[str] = set()
    billing_reconciliation_needed = False
    for usage in qs:
        try:
            file_record = usage.file_record
            if not file_record or file_record.status == "deleted":
                result.failed_files.append({
                    "usage_id": str(usage.id),
                    "file_record_id": str(usage.file_record_id),
                    "reason": "file_deleted",
                })
                logger.warning(
                    "%sFileRecord 已被清理，无法恢复: usage=%s, file=%s",
                    prefix, usage.id, usage.file_record_id,
                )
                continue

            file_size = file_record.file_size if file_record else 0
            fid_str = str(usage.file_record_id)

            with transaction.atomic():
                from apps.services.oss.models import FileUsage as _FileUsage
                locked_usage = _FileUsage.objects.select_for_update().get(id=usage.id)
                if locked_usage.is_active:
                    continue

                locked_usage.is_active = True
                locked_usage.deactivated_at = None
                locked_usage.user_id = user_id or locked_usage.user_id
                locked_usage.save(update_fields=["is_active", "deactivated_at", "user_id"])

                _FileRecord.objects.filter(id=file_record.id).update(
                    ref_count=_models.F("ref_count") + 1,
                )

                if organization_id and file_size > 0 and fid_str not in billed_file_ids:
                    try:
                        from apps.services.billing.services import OrganizationStorageBillingService
                        OrganizationStorageBillingService.apply_storage_delta(
                            organization_id=organization_id,
                            file_id=fid_str,
                            delta_bytes=+file_size,
                            user_id=user_id,
                            biz_type=biz_type,
                            biz_id=biz_id,
                        )
                        billed_file_ids.add(fid_str)
                    except Exception as billing_exc:
                        logger.warning(
                            "%s恢复存储计量失败: file=%s, err=%s",
                            prefix, usage.file_record_id, billing_exc,
                        )
                        billing_reconciliation_needed = True
                        try:
                            from apps.services.billing.services.degradation_tracker import (
                                track_billing_degradation,
                            )
                            track_billing_degradation(
                                meter_key="storage.reactivate",
                                organization_id=organization_id,
                                biz_type=biz_type,
                                error=str(billing_exc),
                            )
                        except Exception:
                            pass

            result.restored_count += 1
        except Exception as usage_exc:
            logger.warning(
                "%sreactivate 单条失败: usage=%s, err=%s",
                prefix, usage.id, usage_exc,
            )
            result.failed_files.append({
                "usage_id": str(usage.id),
                "file_record_id": str(usage.file_record_id),
                "reason": str(usage_exc),
            })

    if billing_reconciliation_needed:
        try:
            from apps.services.billing.tasks import (
                schedule_storage_snapshot_reconciliation,
            )
            schedule_storage_snapshot_reconciliation(
                organization_id,
                reason=biz_type,
            )
        except Exception as schedule_exc:
            logger.error(
                "%s恢复存储补偿任务安排失败: organization=%s, err=%s",
                prefix, organization_id, schedule_exc,
            )

    if result.restored_count:
        logger.info(
            "%sreactivated %d FileUsage(s), biz_type=%s, biz_id=%s",
            prefix, result.restored_count, biz_type, biz_id,
        )

    if result.failed_files:
        logger.warning(
            "%s%d FileUsage(s) failed to reactivate, biz_type=%s, biz_id=%s",
            prefix, len(result.failed_files), biz_type, biz_id,
        )

    if result.restored_count and organization_id:
        _wt = organization_id
        def _do_invalidate(w=_wt):
            from apps.services.oss.services.analytics_cache import invalidate_safe
            invalidate_safe(w)
        transaction.on_commit(_do_invalidate)

    return result
