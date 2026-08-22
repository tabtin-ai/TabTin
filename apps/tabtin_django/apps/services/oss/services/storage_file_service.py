"""存储文件管理服务 — Phase 2 文件列表/引用/批量删除。"""

from __future__ import annotations

import logging
from typing import Any, Optional

from django.db import transaction
from django.db.models import Q, F

from apps.services.oss.services.analytics_cache import invalidate_safe
from apps.services.oss.services.storage_analytics import MODULE_DISPLAY

logger = logging.getLogger(__name__)


def _file_to_dict(usage, *, current_user_id: str = "", user_names: dict[str, str] | None = None) -> dict[str, Any]:
    fr = usage.file_record
    ref_count = int(fr.ref_count or 0)
    uid = str(fr.upload_user or "")
    is_own = uid == current_user_id and current_user_id != ""
    return {
        "file_id": str(fr.id),
        "file_name": fr.file_name or "",
        "file_size": int(fr.file_size or 0),
        "file_type": fr.file_type or "other",
        "mime_type": fr.mime_type or "",
        "module": usage.module,
        "module_display": MODULE_DISPLAY.get(usage.module, usage.module),
        "context_type": usage.context_type,
        "context_id": usage.context_id,
        "upload_user": uid,
        "upload_user_display": (user_names or {}).get(uid, uid[:8] if uid else ""),
        "created_at": fr.created_at.isoformat() if fr.created_at else "",
        "cdn_url": fr.cdn_url or fr.access_url or "",
        "ref_count": ref_count,
        "is_safe_to_delete": (ref_count == 0) or (ref_count <= 1 and is_own),
    }


class StorageFileService:

    @classmethod
    def list_files(
        cls,
        organization_id: str,
        *,
        current_user_id: str = "",
        user_role: str = "viewer",
        module: str = "",
        file_type: str = "",
        min_size: int = 0,
        max_size: int = 0,
        uploaded_after: str = "",
        uploaded_before: str = "",
        search: str = "",
        sort: str = "-file_size",
        cursor: str = "",
        limit: int = 20,
    ) -> dict[str, Any]:
        from apps.services.oss.models import FileUsage

        qs = FileUsage.objects.filter(
            file_record__organization_id=organization_id,
            file_record__status="completed",
            is_active=True,
        ).select_related("file_record")

        if user_role == "viewer" and current_user_id:
            qs = qs.filter(file_record__upload_user=current_user_id)

        if module:
            modules = [m.strip() for m in module.split(",") if m.strip()]
            if modules:
                qs = qs.filter(module__in=modules)

        if file_type:
            types = [t.strip() for t in file_type.split(",") if t.strip()]
            if types:
                qs = qs.filter(file_record__file_type__in=types)

        if min_size > 0:
            qs = qs.filter(file_record__file_size__gte=min_size)
        if max_size > 0:
            qs = qs.filter(file_record__file_size__lte=max_size)

        if uploaded_after:
            qs = qs.filter(file_record__created_at__gte=uploaded_after)
        if uploaded_before:
            qs = qs.filter(file_record__created_at__lte=uploaded_before)

        if search:
            qs = qs.filter(file_record__file_name__icontains=search)

        count_qs = qs

        sort_field, desc = cls._parse_sort(sort)
        order_prefix = "-" if desc else ""
        qs = qs.order_by(f"{order_prefix}{sort_field}", "-file_record__created_at", "-file_record__id")

        if cursor:
            try:
                from apps.services.oss.models import FileRecord
                cursor_record = FileRecord.objects.filter(id=cursor, organization_id=organization_id).values("id", "file_size", "created_at", "file_name").first()
                if cursor_record:
                    qs = cls._apply_cursor_filter(qs, sort_field, desc, cursor_record)
            except Exception:
                pass

        fetch_limit = min(limit, 50) + 1
        rows = list(qs[:fetch_limit])
        has_more = len(rows) > min(limit, 50)
        items = rows[:min(limit, 50)]

        from apps.services.oss.services.storage_analytics import _resolve_user_names
        upload_user_ids = list({str(u.file_record.upload_user) for u in items if u.file_record and u.file_record.upload_user})
        user_names = _resolve_user_names(upload_user_ids)
        result_items = [_file_to_dict(u, current_user_id=current_user_id, user_names=user_names) for u in items]
        from apps.services.oss.services.storage_analytics import _resolve_context_display
        _resolve_context_display(result_items)
        next_cursor = result_items[-1]["file_id"] if has_more and result_items else None

        total_estimate = 0
        try:
            total_estimate = count_qs.values("file_record_id").distinct().count()
        except Exception:
            pass

        return {
            "items": result_items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total_estimate": total_estimate,
        }

    @classmethod
    def get_file_usages(cls, organization_id: str, file_id: str) -> list[dict[str, Any]]:
        from apps.services.oss.models import FileUsage, FileRecord

        try:
            fr = FileRecord.objects.get(id=file_id, organization_id=organization_id)
        except FileRecord.DoesNotExist:
            return []

        usages = FileUsage.objects.filter(file_record=fr).order_by("-is_active", "-created_at")
        return [
            {
                "usage_id": str(u.id),
                "module": u.module,
                "module_display": MODULE_DISPLAY.get(u.module, u.module),
                "context_type": u.context_type,
                "context_id": u.context_id,
                "is_active": u.is_active,
                "created_at": u.created_at.isoformat() if u.created_at else "",
            }
            for u in usages
        ]

    @classmethod
    def batch_delete_files(
        cls,
        organization_id: str,
        file_ids: list[str],
        user_id: str,
        user_role: str = "viewer",
    ) -> dict[str, Any]:
        from apps.services.oss.models import FileRecord, FileUsage

        results = []
        success_count = 0
        failed_count = 0

        for fid in file_ids:
            try:
                fr = FileRecord.objects.filter(id=fid, organization_id=organization_id, status="completed").first()
                if not fr:
                    results.append({"file_id": fid, "success": False, "message": "文件不存在", "usage_count_removed": 0})
                    failed_count += 1
                    continue

                is_own = str(fr.upload_user or "") == user_id
                if not is_own and user_role not in ("admin", "owner"):
                    results.append({"file_id": fid, "success": False, "message": "无权删除他人文件", "usage_count_removed": 0})
                    failed_count += 1
                    continue

                usages = FileUsage.objects.filter(file_record=fr, is_active=True)
                removed = 0
                billing_done = False
                file_size = int(fr.file_size or 0)
                for usage in usages:
                    try:
                        with transaction.atomic():
                            usage.deactivate()
                            if not billing_done and organization_id and file_size > 0:
                                from apps.services.billing.services import OrganizationStorageBillingService
                                OrganizationStorageBillingService.apply_storage_delta(
                                    organization_id=organization_id,
                                    file_id=str(fr.id),
                                    delta_bytes=-file_size,
                                    user_id=user_id,
                                    biz_type="storage_manager_delete",
                                    biz_id=str(usage.id),
                                )
                                billing_done = True
                        removed += 1
                    except Exception as exc:
                        logger.warning("batch_delete usage deactivate error: file=%s, usage=%s, err=%s", fid, usage.id, exc)

                results.append({"file_id": fid, "success": True, "message": "", "usage_count_removed": removed})
                success_count += 1
            except Exception as exc:
                results.append({"file_id": fid, "success": False, "message": str(exc), "usage_count_removed": 0})
                failed_count += 1

        if success_count and organization_id:
            transaction.on_commit(lambda: invalidate_safe(organization_id))

        logger.info(
            "batch_delete: organization=%s, user=%s, total=%d, success=%d, failed=%d",
            organization_id, user_id, len(file_ids), success_count, failed_count,
        )

        try:
            from apps.services.oss.models import OSSAdminActionLog
            OSSAdminActionLog.objects.create(
                action_type="storage_manager_batch_delete",
                operator_id=user_id,
                operator_display=user_id[:8],
                organization_ids=[organization_id] if organization_id else [],
                target_file_ids=file_ids,
                requested_count=len(file_ids),
                processed_count=success_count + failed_count,
                deleted_count=success_count,
                skipped_count=failed_count,
                success=failed_count == 0,
                result_payload={"results": results},
            )
        except Exception as log_exc:
            logger.warning("batch_delete audit log failed: %s", log_exc)

        return {
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results,
        }

    @staticmethod
    def _parse_sort(sort: str) -> tuple[str, bool]:
        desc = sort.startswith("-")
        field = sort.lstrip("-")
        field_map = {
            "file_size": "file_record__file_size",
            "created_at": "file_record__created_at",
            "file_name": "file_record__file_name",
        }
        return field_map.get(field, "file_record__file_size"), desc

    @staticmethod
    def _apply_cursor_filter(qs, sort_field: str, desc: bool, cursor_record: dict):
        """基于排序字段的 keyset 分页过滤，与 ORDER BY (..., -created_at, -id) 对齐。"""
        field_to_value = {
            "file_record__file_size": cursor_record.get("file_size"),
            "file_record__created_at": cursor_record.get("created_at"),
            "file_record__file_name": cursor_record.get("file_name"),
        }
        cursor_val = field_to_value.get(sort_field)
        if cursor_val is None:
            return qs
        cursor_id = cursor_record.get("id", "")
        cursor_created = cursor_record.get("created_at")
        comp = "__lt" if desc else "__gt"
        primary_q = Q(**{f"{sort_field}{comp}": cursor_val})
        tier2_q = Q(**{sort_field: cursor_val, "file_record__created_at__lt": cursor_created})
        tier3_q = Q(**{sort_field: cursor_val, "file_record__created_at": cursor_created, "file_record__id__lt": cursor_id})
        return qs.filter(primary_q | tier2_q | tier3_q)
