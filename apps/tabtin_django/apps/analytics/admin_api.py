"""
获客分析 - AdminDash 管理 API

- 短链维护：列表 / 创建 / 更新 / 删除
- 看板数据：概览 / 趋势 / 平台与渠道分布 / 原始事件列表

鉴权：StaffAuth（与 client_errors / updater 后台一致）。数据走 default 库。
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from django.db.models import Count
from django.db.models.functions import TruncDay
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.users.auth.permissions import StaffAuth
from tabtin.pagination import paginate_queryset

from .models import AnalyticsEvent, ShortLink
from .services import resolve_short_link_target

logger = logging.getLogger(__name__)
router = Router(auth=StaffAuth())

_MAX_DAYS = 180


def _clamp_days(days: int) -> int:
    if days < 1:
        return 1
    return min(days, _MAX_DAYS)


def _short_link_dict(link: ShortLink) -> dict:
    return {
        "id": str(link.id),
        "slug": link.slug,
        "name": link.name,
        "description": link.description,
        "target_type": link.target_type,
        "target_url": link.target_url,
        "release_platform": link.release_platform,
        "release_arch": link.release_arch,
        "release_channel": link.release_channel,
        "channel": link.channel,
        "utm_source": link.utm_source,
        "utm_medium": link.utm_medium,
        "utm_campaign": link.utm_campaign,
        "is_active": link.is_active,
        "click_count": link.click_count,
        "last_clicked_at": link.last_clicked_at.isoformat() if link.last_clicked_at else None,
        "resolved_url": resolve_short_link_target(link),
        "created_at": link.created_at.isoformat() if link.created_at else None,
        "updated_at": link.updated_at.isoformat() if link.updated_at else None,
    }


# ── 短链维护 ──


@router.get("/analytics/short-links", tags=["Admin Analytics"])
def list_short_links(request, is_active: Optional[bool] = None, page: int = 1, page_size: int = 50):
    qs = ShortLink.objects.all()
    if is_active is not None:
        qs = qs.filter(is_active=is_active)
    qs = qs.order_by("-created_at")
    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)
    return {"items": [_short_link_dict(x) for x in items], "pagination": pagination}


class ShortLinkInSchema(Schema):
    slug: str
    name: str
    description: str = ""
    target_type: str = "latest_release"
    target_url: str = ""
    release_platform: str = ""
    release_arch: str = ""
    release_channel: str = "stable"
    channel: str = ""
    utm_source: str = ""
    utm_medium: str = ""
    utm_campaign: str = ""
    is_active: bool = True


def _validate_short_link(data: ShortLinkInSchema) -> None:
    if data.target_type == ShortLink.TargetType.STATIC:
        if not data.target_url.strip():
            raise HttpError(400, "固定 URL 模式必须填写 target_url")
    elif data.target_type == ShortLink.TargetType.LATEST_RELEASE:
        if not data.release_platform or not data.release_arch:
            raise HttpError(400, "跟随发版模式必须选择平台和架构")
    else:
        raise HttpError(400, "无效的 target_type")


@router.post("/analytics/short-links", tags=["Admin Analytics"])
def create_short_link(request, payload: ShortLinkInSchema):
    _validate_short_link(payload)
    slug = payload.slug.strip()
    if not slug:
        raise HttpError(400, "slug 不能为空")
    if ShortLink.objects.filter(slug=slug).exists():
        raise HttpError(409, f"短链 {slug} 已存在")
    user_id = getattr(request.auth, "id", None)
    link = ShortLink.objects.create(
        slug=slug,
        name=payload.name.strip() or slug,
        description=payload.description,
        target_type=payload.target_type,
        target_url=payload.target_url.strip(),
        release_platform=payload.release_platform,
        release_arch=payload.release_arch,
        release_channel=payload.release_channel or "stable",
        channel=payload.channel,
        utm_source=payload.utm_source,
        utm_medium=payload.utm_medium,
        utm_campaign=payload.utm_campaign,
        is_active=payload.is_active,
        created_by_id=user_id,
        updated_by_id=user_id,
    )
    return _short_link_dict(link)


@router.put("/analytics/short-links/{link_id}", tags=["Admin Analytics"])
def update_short_link(request, link_id: str, payload: ShortLinkInSchema):
    link = ShortLink.objects.filter(id=link_id).first()
    if not link:
        raise HttpError(404, "短链不存在")
    _validate_short_link(payload)
    new_slug = payload.slug.strip()
    if new_slug and new_slug != link.slug:
        if ShortLink.objects.filter(slug=new_slug).exclude(id=link.id).exists():
            raise HttpError(409, f"短链 {new_slug} 已存在")
        link.slug = new_slug
    link.name = payload.name.strip() or link.slug
    link.description = payload.description
    link.target_type = payload.target_type
    link.target_url = payload.target_url.strip()
    link.release_platform = payload.release_platform
    link.release_arch = payload.release_arch
    link.release_channel = payload.release_channel or "stable"
    link.channel = payload.channel
    link.utm_source = payload.utm_source
    link.utm_medium = payload.utm_medium
    link.utm_campaign = payload.utm_campaign
    link.is_active = payload.is_active
    link.updated_by_id = getattr(request.auth, "id", None)
    link.save()
    return _short_link_dict(link)


@router.delete("/analytics/short-links/{link_id}", tags=["Admin Analytics"])
def delete_short_link(request, link_id: str):
    deleted, _ = ShortLink.objects.filter(id=link_id).delete()
    if not deleted:
        raise HttpError(404, "短链不存在")
    return {"success": True}


# ── 看板数据 ──


@router.get("/analytics/overview", tags=["Admin Analytics"])
def overview(request, days: int = 7):
    """概览：区间内访问 / 访客 / 下载 + 平台、渠道 top。"""
    days = _clamp_days(days)
    since = timezone.now() - timedelta(days=days)
    events = AnalyticsEvent.objects.filter(occurred_at__gte=since)

    page_views = events.filter(event_name="page_view")
    downloads = events.filter(event_name="download")

    platform_breakdown = list(
        downloads.exclude(platform="")
        .values("platform", "arch")
        .annotate(count=Count("id"))
        .order_by("-count")
    )
    top_channels = list(
        downloads.values("utm_source")
        .annotate(count=Count("id"))
        .order_by("-count")[:10]
    )
    top_pages = list(
        page_views.exclude(path="")
        .values("path")
        .annotate(count=Count("id"))
        .order_by("-count")[:10]
    )
    # 地域分布（访问）：只统计已解析出地域的（内网/海外无省份的按国家聚）
    geo_breakdown = list(
        page_views.exclude(geo_country="")
        .values("geo_country", "geo_province")
        .annotate(count=Count("id"))
        .order_by("-count")[:15]
    )
    # 来源网站分布：从哪些站点 / 搜索引擎跳来
    referrer_breakdown = list(
        page_views.exclude(referrer_host="")
        .values("referrer_host")
        .annotate(count=Count("id"))
        .order_by("-count")[:15]
    )

    # 新访客 vs 回访：窗口内有访问的访客里，窗口之前已出现过的算回访
    # order_by() 清掉模型默认排序，否则 occurred_at 会混入 SELECT 破坏 distinct
    window_anon_ids = list(
        page_views.exclude(anon_id="").order_by().values_list("anon_id", flat=True).distinct()
    )
    unique_visitors = len(window_anon_ids)
    returning_visitors = 0
    if window_anon_ids:
        returning_visitors = (
            AnalyticsEvent.objects.filter(
                event_name="page_view", occurred_at__lt=since, anon_id__in=window_anon_ids
            )
            .values("anon_id")
            .distinct()
            .count()
        )
    new_visitors = max(unique_visitors - returning_visitors, 0)

    return {
        "days": days,
        "page_views": page_views.count(),
        "unique_visitors": unique_visitors,
        "new_visitors": new_visitors,
        "returning_visitors": returning_visitors,
        "downloads": downloads.count(),
        "platform_breakdown": platform_breakdown,
        "top_channels": top_channels,
        "top_pages": top_pages,
        "geo_breakdown": geo_breakdown,
        "referrer_breakdown": referrer_breakdown,
    }


@router.get("/analytics/trends", tags=["Admin Analytics"])
def trends(request, days: int = 30, event_name: str = "page_view"):
    """按天趋势序列。"""
    days = _clamp_days(days)
    since = timezone.now() - timedelta(days=days)
    rows = (
        AnalyticsEvent.objects.filter(occurred_at__gte=since, event_name=event_name)
        .annotate(day=TruncDay("occurred_at"))
        .values("day")
        .annotate(count=Count("id"))
        .order_by("day")
    )
    return {
        "event_name": event_name,
        "days": days,
        "series": [
            {"day": r["day"].date().isoformat() if r["day"] else None, "count": r["count"]}
            for r in rows
        ],
    }


@router.get("/analytics/events", tags=["Admin Analytics"])
def list_events(
    request,
    source: str = "",
    event_name: str = "",
    days: int = 7,
    page: int = 1,
    page_size: int = 50,
):
    """原始事件列表（用于核对 / 排查）。"""
    days = _clamp_days(days)
    since = timezone.now() - timedelta(days=days)
    qs = AnalyticsEvent.objects.filter(occurred_at__gte=since)
    if source:
        qs = qs.filter(source=source)
    if event_name:
        qs = qs.filter(event_name=event_name)
    qs = qs.order_by("-occurred_at")
    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)
    return {
        "items": [
            {
                "id": str(e.id),
                "source": e.source,
                "event_name": e.event_name,
                "occurred_at": e.occurred_at.isoformat() if e.occurred_at else None,
                "path": e.path,
                "referrer_host": e.referrer_host,
                "utm_source": e.utm_source,
                "platform": e.platform,
                "arch": e.arch,
                "geo_country": e.geo_country,
                "geo_province": e.geo_province,
                "props": e.props,
            }
            for e in items
        ],
        "pagination": pagination,
    }
