"""存储分析服务 — Phase 1 聚合查询 + 缓存 + 降级。"""

from __future__ import annotations

import logging
from typing import Any

from collections import defaultdict

from django.db.models import Q

from apps.services.oss.services.analytics_cache import (
    get_cached, set_cached, TTL_OVERVIEW, TTL_DETAIL,
)

logger = logging.getLogger(__name__)


def _resolve_user_names(user_ids: list[str]) -> dict[str, str]:
    """批量查询用户显示名。跨库查 MySQL 的 User 表。"""
    if not user_ids:
        return {}
    try:
        from apps.users.auth.models import User
        users = User.objects.filter(id__in=user_ids).only("id", "nickname", "username", "email")
        return {str(u.id): u.get_display_name() for u in users}
    except Exception:
        return {}


_CONTEXT_RESOLVERS: dict[str, tuple[str, str, str, str]] = {}


def register_context_resolver(
    module: str, model_path: str, model_name: str,
    display_field: str, db: str = "postgresql",
) -> None:
    """注册模块的 context_id → 可读名称解析器。

    各 app 的 AppConfig.ready() 或模块顶层调用此函数即可自动注册，
    无需修改 storage_analytics.py。

    Args:
        module: FileUsage.module 值（如 "tabdoc"）
        model_path: 模型所在 Python 模块路径（如 "apps.tabdoc.models"）
        model_name: 模型类名（如 "Document"）
        display_field: 用作显示名的字段名（如 "title"）
        db: 模型所在数据库别名（默认 "postgresql"，MySQL 模型传 "default"）
    """
    _CONTEXT_RESOLVERS[module] = (model_path, model_name, display_field, db)


def _init_default_resolvers() -> None:
    """注册内置模块的解析器（仅首次调用时执行）。"""
    if _CONTEXT_RESOLVERS:
        return
    defaults: list[tuple[str, str, str, str, str]] = [
        ("tabdoc", "apps.tabdoc.models", "Document", "title", "postgresql"),
        ("tabslide", "apps.tabslide.models", "SlideProject", "name", "postgresql"),
        ("tabdata", "apps.tabdata.models", "Table", "name", "postgresql"),
        ("tabsite", "apps.tabsite.models", "Site", "name", "postgresql"),
        ("chat", "apps.chat.conversation.models", "ChatMessage", "content", "default"),
    ]
    for module, path, cls_name, field_name, db_alias in defaults:
        register_context_resolver(module, path, cls_name, field_name, db_alias)


def _resolve_context_display(items: list[dict]) -> None:
    """批量解析 context_id 为可读的业务实体名称，原地更新 items。"""
    _init_default_resolvers()

    grouped: dict[str, list[str]] = {}
    for item in items:
        module = item.get("module", "")
        ctx_id = item.get("context_id", "")
        if module and ctx_id:
            grouped.setdefault(module, []).append(ctx_id)

    name_map: dict[str, str] = {}
    import importlib
    for module, ctx_ids in grouped.items():
        resolver = _CONTEXT_RESOLVERS.get(module)
        if not resolver:
            continue
        module_path, model_name, field, db_alias = resolver
        try:
            mod = importlib.import_module(module_path)
            model_cls = getattr(mod, model_name)
            rows = model_cls.objects.using(db_alias).filter(
                id__in=ctx_ids,
            ).values_list("id", field)
            for rid, val in rows:
                display = str(val).strip() if val else ""
                if len(display) > 40:
                    display = display[:40] + "…"
                name_map[str(rid)] = display
        except Exception:
            pass

    for item in items:
        ctx_id = item.get("context_id", "")
        item["context_display"] = name_map.get(ctx_id, "")


MODULE_DISPLAY = {
    "chat": "对话",
    "tabdata": "表格",
    "tabdoc": "文档",
    "tabslide": "演示",
    "tabsite": "站点",
    "tabmemo": "碎片",
    "tabchat": "即时通讯",
    "tabcode": "代码",
    "media_generation": "AI 生成",
    "crawl": "采集",
    "updater": "桌面更新",
}


def _base_qs(organization_id: str):
    from apps.services.oss.models import FileUsage
    return FileUsage.objects.filter(
        file_record__organization_id=organization_id,
        file_record__status="completed",
        is_active=True,
    )


class StorageAnalyticsService:

    @classmethod
    def get_overview(cls, organization_id: str) -> dict[str, Any]:
        cached = get_cached(organization_id, "overview")
        if cached is not None:
            return cached

        from apps.services.billing.models import OrganizationStorageUsage
        snapshot = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()

        from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
        try:
            alloc = OrganizationBillingPolicyService.evaluate_storage_allocation(
                organization_id,
                current_storage_bytes=int(snapshot.active_storage_bytes or 0) if snapshot else 0,
                incoming_delta_bytes=0,
            )
            quota_bytes = int(alloc.get("storage_package_bytes", 0))
        except Exception:
            quota_bytes = 0

        used_bytes = int(snapshot.active_storage_bytes or 0) if snapshot else 0
        file_count = int(snapshot.active_file_count or 0) if snapshot else 0

        try:
            by_module = cls._aggregate_by_module(organization_id)
            approximate = False
        except Exception as exc:
            logger.warning("storage overview aggregation fallback: %s", exc)
            by_module = []
            approximate = True

        result = {
            "quota_bytes": quota_bytes,
            "used_bytes": used_bytes,
            "used_pct": round(used_bytes / quota_bytes * 100, 1) if quota_bytes > 0 else 0,
            "file_count": file_count,
            "approximate": approximate,
            "by_module": by_module[:7],
        }
        set_cached(organization_id, "overview", result, TTL_OVERVIEW)
        return result

    @classmethod
    def get_by_module(cls, organization_id: str) -> list[dict[str, Any]]:
        cached = get_cached(organization_id, "by_module")
        if cached is not None:
            return cached
        data = cls._aggregate_by_module(organization_id)
        set_cached(organization_id, "by_module", data, TTL_DETAIL)
        return data

    @classmethod
    def get_by_member(cls, organization_id: str, limit: int = 20) -> list[dict[str, Any]]:
        cache_dim = f"by_member:{limit}"
        cached = get_cached(organization_id, cache_dim)
        if cached is not None:
            return cached

        distinct = list(
            _base_qs(organization_id)
            .exclude(Q(file_record__upload_user="") | Q(file_record__upload_user__isnull=True))
            .values_list("file_record__upload_user", "file_record_id", "file_record__file_size")
            .distinct()
        )
        agg: dict[str, dict[str, int]] = defaultdict(lambda: {"total_bytes": 0, "file_count": 0})
        for user, _fid, fsize in distinct:
            agg[user]["total_bytes"] += int(fsize or 0)
            agg[user]["file_count"] += 1
        sorted_members = sorted(agg.items(), key=lambda x: -x[1]["total_bytes"])[:limit]
        user_ids = [uid for uid, _ in sorted_members]
        names = _resolve_user_names(user_ids)
        data = [
            {
                "user_id": uid,
                "display_name": names.get(uid, uid[:8] if uid else ""),
                "total_bytes": s["total_bytes"],
                "file_count": s["file_count"],
            }
            for uid, s in sorted_members
        ]
        set_cached(organization_id, cache_dim, data, TTL_DETAIL)
        return data

    @classmethod
    def get_by_file_type(cls, organization_id: str) -> list[dict[str, Any]]:
        cached = get_cached(organization_id, "by_file_type")
        if cached is not None:
            return cached

        distinct = list(
            _base_qs(organization_id)
            .values_list("file_record__file_type", "file_record_id", "file_record__file_size")
            .distinct()
        )
        agg: dict[str, dict[str, int]] = defaultdict(lambda: {"total_bytes": 0, "file_count": 0})
        for ftype, _fid, fsize in distinct:
            key = ftype or "other"
            agg[key]["total_bytes"] += int(fsize or 0)
            agg[key]["file_count"] += 1
        data = [
            {
                "file_type": ft,
                "total_bytes": s["total_bytes"],
                "file_count": s["file_count"],
            }
            for ft, s in agg.items()
        ]
        data.sort(key=lambda r: -r["total_bytes"])
        set_cached(organization_id, "by_file_type", data, TTL_DETAIL)
        return data

    @classmethod
    def get_large_files(
        cls,
        organization_id: str,
        min_size: int = 1_048_576,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        cache_dim = f"large_files:{min_size}:{limit}"
        cached = get_cached(organization_id, cache_dim)
        if cached is not None:
            return cached

        rows = (
            _base_qs(organization_id)
            .filter(file_record__file_size__gte=min_size)
            .select_related("file_record")
            .order_by("-file_record__file_size")[:limit]
        )
        upload_user_ids = list({u.file_record.upload_user for u in rows if u.file_record and u.file_record.upload_user})
        names = _resolve_user_names(upload_user_ids)
        data = []
        for u in rows:
            fr = u.file_record
            uid = fr.upload_user or ""
            data.append({
                "file_id": str(fr.id),
                "file_name": fr.file_name or "",
                "file_size": int(fr.file_size or 0),
                "file_type": fr.file_type or "other",
                "mime_type": fr.mime_type or "",
                "module": u.module,
                "module_display": MODULE_DISPLAY.get(u.module, u.module),
                "context_type": u.context_type,
                "context_id": u.context_id,
                "upload_user": uid,
                "upload_user_display": names.get(uid, uid[:8] if uid else ""),
                "created_at": fr.created_at.isoformat() if fr.created_at else "",
                "cdn_url": fr.cdn_url or fr.access_url or "",
            })
        _resolve_context_display(data)
        set_cached(organization_id, cache_dim, data, TTL_DETAIL)
        return data

    @classmethod
    def _aggregate_by_module(cls, organization_id: str) -> list[dict[str, Any]]:
        distinct = list(
            _base_qs(organization_id)
            .values_list("module", "file_record_id", "file_record__file_size")
            .distinct()
        )
        agg: dict[str, dict[str, int]] = defaultdict(lambda: {"total_bytes": 0, "file_count": 0})
        for module, _fid, fsize in distinct:
            agg[module]["total_bytes"] += int(fsize or 0)
            agg[module]["file_count"] += 1
        result = [
            {
                "module": m,
                "display_name": MODULE_DISPLAY.get(m, m),
                "total_bytes": s["total_bytes"],
                "file_count": s["file_count"],
            }
            for m, s in agg.items()
        ]
        result.sort(key=lambda r: -r["total_bytes"])
        return result
