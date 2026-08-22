"""
埋点公网采集 API

- POST /collect  — 各端（官网 beacon / 客户端）批量上报事件。匿名、按 IP 限流。

短链 302 跳转不在此（HTTP 语义是重定向，不是 JSON API），见 views.py 的 /dl/<slug>。
"""

from __future__ import annotations

import logging
from typing import List, Optional
from urllib.parse import urlsplit

from django.core.cache import cache
from ninja import Router, Schema
from ninja.errors import HttpError

from .services import hash_ua, resolve_geo, store_event

logger = logging.getLogger(__name__)
router = Router()

# ── 限流：匿名上报按 IP ──
_RATE_PREFIX = "analytics:collect:"
_RATE_MAX = 120  # 每 IP 每分钟最多 120 条（页面浏览 + 交互事件）
_RATE_WINDOW = 60
_BATCH_MAX = 30  # 单次请求最多 30 条


def _client_ip(request) -> str:
    from apps.users.auth.utils import get_client_ip

    return get_client_ip(request) or "unknown"


def _geo_client_ip(request) -> str:
    """地域统计专用取 IP：XFF 最右 = ALB 观察到的真实对端（api-test 前无 CDN）。

    仅用于地域分布统计，不参与鉴权/风控；被伪造顶多让分布不准。
    不复用 get_client_ip，避免依赖全局 TRUSTED_PROXY_COUNT（默认 0 会拿到内网 IP）。
    """
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    ips = [p.strip() for p in xff.split(",") if p.strip()]
    if ips:
        return ips[-1]
    return request.META.get("REMOTE_ADDR", "") or ""


def _origin_host(request) -> str:
    """从 Origin（退回 Referer）取上报页所在站点的 host，用于识别站内自我引用。"""
    src = request.META.get("HTTP_ORIGIN", "") or request.META.get("HTTP_REFERER", "")
    if not src:
        return ""
    try:
        return urlsplit(src).netloc.lower()
    except ValueError:
        return ""


def _external_referrer(referrer: str, own_host: str) -> str:
    """站内跳转（referrer host == 上报站点 host）不算外部来源，置空防污染来源分布。"""
    if not referrer or not own_host:
        return referrer
    try:
        if urlsplit(referrer).netloc.lower() == own_host:
            return ""
    except ValueError:
        pass
    return referrer


def _rate_limited(request) -> bool:
    key = f"{_RATE_PREFIX}{_client_ip(request)}"
    try:
        current = cache.incr(key)
    except ValueError:
        cache.set(key, 1, _RATE_WINDOW)
        current = 1
    return current > _RATE_MAX


class EventInSchema(Schema):
    event_name: str
    source: str = "web"
    occurred_at: Optional[str] = None
    anon_id: str = ""
    session_id: str = ""
    path: str = ""
    referrer: str = ""
    utm_source: str = ""
    utm_medium: str = ""
    utm_campaign: str = ""
    platform: str = ""
    arch: str = ""
    app_version: str = ""
    props: dict = {}


class CollectSchema(Schema):
    events: List[EventInSchema]


@router.post("/collect", auth=None, tags=["Analytics"])
def collect(request, payload: CollectSchema):
    """接收一批埋点事件（匿名）。"""
    if _rate_limited(request):
        raise HttpError(429, "rate limited")

    ua_hash = hash_ua(request.META.get("HTTP_USER_AGENT", ""))
    # 地域：用客户端 IP 现算国家/省份，只落地域不落 IP（隐私）。CF 头存在时兜底国家。
    geo_country, geo_province = resolve_geo(_geo_client_ip(request))
    if not geo_country:
        geo_country = request.META.get("HTTP_CF_IPCOUNTRY", "")[:64]
    own_host = _origin_host(request)

    ingested = 0
    for ev in payload.events[:_BATCH_MAX]:
        # user_id 只信服务端鉴权，不信客户端上报字段（避免伪造归因）
        user_id = str(request.auth.id) if getattr(request, "auth", None) else ""
        result = store_event(
            source=ev.source,
            event_name=ev.event_name,
            occurred_at_raw=ev.occurred_at,
            anon_id=ev.anon_id,
            session_id=ev.session_id,
            user_id=user_id,
            path=ev.path,
            referrer=_external_referrer(ev.referrer, own_host),
            utm_source=ev.utm_source,
            utm_medium=ev.utm_medium,
            utm_campaign=ev.utm_campaign,
            platform=ev.platform,
            arch=ev.arch,
            app_version=ev.app_version,
            geo_country=geo_country,
            geo_province=geo_province,
            ua_hash=ua_hash,
            props=ev.props,
        )
        if result is not None:
            ingested += 1

    return {"success": True, "ingested": ingested}
