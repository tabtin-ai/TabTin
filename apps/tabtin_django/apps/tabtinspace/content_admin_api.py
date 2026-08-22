"""
数据 & 内容后台聚合 API

为 AdminDash 的“数据 & 内容”总览页提供单接口聚合统计，
避免前端并发拼装多个模块接口。
"""

from __future__ import annotations

from datetime import timedelta

from django.db.models import Count, Sum
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.services.oss.models import FileRecord
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabslide.models import SlideProject
from apps.tabtinspace.models import Space, ContextItem, Organization, Workspace, Project
from apps.users.auth.permissions import StaffAuth

router = Router(tags=["Admin Content Operations"], auth=StaffAuth())


@router.get("/content/overview", summary="管理员查看数据与内容总览")
def admin_content_overview(request):

    all_tables = Table.objects.using(TABDATA_DB_ALIAS).all()
    all_documents = Document.objects.all()
    all_slides = SlideProject.objects.all()
    all_oss_files = FileRecord.objects.all()

    total_oss_size = (
        all_oss_files.exclude(status="deleted").aggregate(total=Sum("file_size")).get("total")
        or 0
    )
    orphan_file_qs = all_oss_files.filter(ref_count=0, status="completed")
    orphan_file_size = orphan_file_qs.aggregate(total=Sum("file_size")).get("total") or 0

    now = timezone.now()
    trash_type_stats = list(
        ContextItem.objects.filter(trashed_at__isnull=False)
        .values("item_type")
        .annotate(count=Count("id"))
        .order_by("-count")
    )
    trash_expiring_soon = ContextItem.objects.filter(
        trashed_at__isnull=False,
        trashed_at__lt=now - timedelta(days=27),
    ).count()
    from apps.tabtinspace.models import Project
    trashed_spaces = Project.objects.filter(trashed_at__isnull=False).count()
    total_trashed_resources = sum(int(item["count"] or 0) for item in trash_type_stats)

    tables_summary = {
        "total_tables": all_tables.count(),
        "active_tables": all_tables.filter(is_archived=False).count(),
        "archived_tables": all_tables.filter(is_archived=True).count(),
        "system_tables": all_tables.filter(visibility__in=["system", "hidden"]).count(),
    }
    docs_summary = {
        "total_documents": all_documents.count(),
        "active_documents": all_documents.filter(status="active").count(),
        "archived_documents": all_documents.filter(status="archived").count(),
        "documents_with_permission_overrides": Document.objects.filter(
            permissions__is_active=True
        )
        .distinct()
        .count(),
    }
    slides_summary = {
        "total_projects": all_slides.count(),
        "active_projects": all_slides.filter(status="active", trashed_at__isnull=True).count(),
        "archived_projects": all_slides.filter(
            status="archived",
            trashed_at__isnull=True,
        ).count(),
        "trashed_projects": all_slides.filter(trashed_at__isnull=False).count(),
        "dirty_projects": all_slides.filter(pptx_dirty=True).count(),
        "total_pages": int(
            all_slides.aggregate(total_pages=Sum("page_count")).get("total_pages") or 0
        ),
    }
    assets_summary = {
        "total_files": all_oss_files.count(),
        "completed_files": all_oss_files.filter(status="completed").count(),
        "failed_files": all_oss_files.filter(status="failed").count(),
        "deleted_files": all_oss_files.filter(status="deleted").count(),
        "public_files": all_oss_files.filter(status="completed", is_public=True).count(),
        "private_files": all_oss_files.filter(status="completed", is_public=False).count(),
        "total_size": int(total_oss_size),
        "orphan_files": orphan_file_qs.count(),
        "orphan_size": int(orphan_file_size),
    }
    trash_summary = {
        "total_trashed_resources": total_trashed_resources,
        "trashed_spaces": trashed_spaces,
        "expiring_soon_3_days": trash_expiring_soon,
        "by_type": trash_type_stats,
    }
    organization_summary = {
        "total_organizations": Organization.objects.count(),
        "total_spaces": (
            Workspace.objects.count()
            + Project.objects.filter(trashed_at__isnull=True).count()
        ),
        "trashed_spaces": trashed_spaces,
    }

    managed_resource_total = (
        tables_summary["total_tables"]
        + docs_summary["total_documents"]
        + slides_summary["total_projects"]
        + assets_summary["total_files"]
    )
    pending_attention_total = (
        slides_summary["dirty_projects"]
        + trash_summary["expiring_soon_3_days"]
    )

    return {
        "organizations": organization_summary,
        "tables": tables_summary,
        "docs": docs_summary,
        "slides": slides_summary,
        "assets": assets_summary,
        "trash": trash_summary,
        "totals": {
            "managed_resources": managed_resource_total,
            "pending_attention": pending_attention_total,
        },
    }
