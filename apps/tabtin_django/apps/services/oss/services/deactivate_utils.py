"""通用 FileUsage 去活 + 存储计费释放工具函数。"""

import logging
from django.db import transaction

logger = logging.getLogger(__name__)


def deactivate_file_usages_and_release_storage(
    *,
    module: str,
    context_filter: dict,
    organization_id: str,
    user_id: str = "",
    biz_type: str,
    biz_id: str,
    log_prefix: str = "",
    exclude_file_record_id: str = "",
    raise_on_billing_failure: bool = False,
) -> int:
    """去活指定条件的 FileUsage 并释放 organization 存储计量。

    Args:
        module: FileUsage.module 值（如 "tabvideo"、"tabslide"）。
        context_filter: 额外的 ORM 过滤条件（如 context_type、context_id / context_id__in）。
        organization_id: 组织 ID，为空则跳过计费释放。
        user_id: 操作者 ID。
        biz_type: 计费事件业务类型。
        biz_id: 计费事件业务 ID。
        log_prefix: 日志前缀，便于定位来源模块。
        exclude_file_record_id: 排除指定 FileRecord ID 关联的 FileUsage（用于导出后清理旧版本时
            跳过刚创建的记录）。
        raise_on_billing_failure: 当 apply_storage_delta 失败时是否向上传播异常。
            默认 False（向后兼容，仅记录 error 日志）。设为 True 时异常会被重新抛出。

    Returns:
        成功去活的 FileUsage 数量。
    """
    from apps.services.oss.models import FileUsage

    prefix = f"{log_prefix} " if log_prefix else ""

    qs = FileUsage.objects.filter(
        module=module,
        is_active=True,
        **context_filter,
    )
    if exclude_file_record_id:
        qs = qs.exclude(file_record_id=exclude_file_record_id)
    usages = qs.select_related("file_record")

    count = 0
    billed_file_ids: set[str] = set()
    for usage in usages:
        billing_error = None
        try:
            file_size = usage.file_record.file_size if usage.file_record else 0
            fid_str = str(usage.file_record_id)
            with transaction.atomic():
                usage.deactivate()

                if organization_id and file_size > 0 and fid_str not in billed_file_ids:
                    try:
                        from apps.services.billing.services import OrganizationStorageBillingService
                        OrganizationStorageBillingService.apply_storage_delta(
                            organization_id=organization_id,
                            file_id=fid_str,
                            delta_bytes=-file_size,
                            user_id=user_id,
                            biz_type=biz_type,
                            biz_id=biz_id,
                        )
                        billed_file_ids.add(fid_str)
                    except Exception as billing_exc:
                        billing_error = billing_exc
                        logger.error(
                            "%s释放存储计量失败: file=%s, err=%s",
                            prefix, usage.file_record_id, billing_exc,
                            exc_info=True,
                        )
                        try:
                            from apps.services.billing.services.degradation_tracker import track_billing_degradation
                            track_billing_degradation(
                                meter_key="storage.deactivate",
                                organization_id=organization_id,
                                biz_type=biz_type,
                                error=str(billing_exc),
                            )
                        except Exception:
                            pass
                        if raise_on_billing_failure:
                            raise

            count += 1
        except Exception as exc:
            if billing_error is not None and raise_on_billing_failure:
                raise billing_error
            logger.warning(
                "%sdeactivate 单条失败: usage=%s, err=%s",
                prefix, usage.id, exc,
            )

    if count:
        logger.info(
            "%sdeactivated %d FileUsage(s), biz_type=%s, biz_id=%s",
            prefix, count, biz_type, biz_id,
        )

    if count and organization_id:
        _wt = organization_id
        def _do_invalidate(w=_wt):
            from apps.services.oss.services.analytics_cache import invalidate_safe
            invalidate_safe(w)
        transaction.on_commit(_do_invalidate)

    return count
