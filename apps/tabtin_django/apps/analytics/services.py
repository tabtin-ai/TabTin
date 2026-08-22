"""
埋点采集与短链解析服务层。

职责：
  - normalize_and_store：把一条上报事件规范化后落库（永不抛异常，采集失败不影响业务）。
  - resolve_short_link_target：把短链解析成真实跳转 URL（static 直接用，latest_release 查发版）。
  - record_download：短链被访问时落一条 download 事件 + 更新短链冗余计数。
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import threading
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import urlsplit

from django.db.models import F
from django.utils import timezone

from .models import AnalyticsEvent, EventSource, ShortLink

logger = logging.getLogger(__name__)

# ── 地域解析（离线 IP → 国家/省份）──
# 只在采集入口用客户端 IP 现算国家/省份，落地域、不落原始 IP（隐私红线）。
# 数据来源：ip2region 离线库（apps/analytics/data/ip2region_v4.xdb），返回
# "国家|省份|城市|ISP|Code"；内网/保留地址返回 "Reserved|..."。
_GEO_XDB_PATH = os.path.join(os.path.dirname(__file__), "data", "ip2region_v4.xdb")
_GEO_PLACEHOLDERS = {"", "0", "Reserved", "内网IP", "未知"}
_geo_searcher = None
_geo_searcher_ready = False
_geo_lock = threading.Lock()


def _get_geo_searcher():
    """懒加载全内存 ip2region searcher（进程内单例）。加载失败则退化为不解析。"""
    global _geo_searcher, _geo_searcher_ready
    if _geo_searcher_ready:
        return _geo_searcher
    with _geo_lock:
        if _geo_searcher_ready:
            return _geo_searcher
        try:
            import ip2region.searcher as xdb
            import ip2region.util as util

            with open(_GEO_XDB_PATH, "rb") as f:
                buf = f.read()
            _geo_searcher = xdb.new_with_buffer(util.IPv4, buf)
        except Exception:
            logger.exception("[analytics] geo searcher init failed; geo disabled")
            _geo_searcher = None
        _geo_searcher_ready = True
    return _geo_searcher


def resolve_geo(ip: str) -> Tuple[str, str]:
    """把客户端 IP 解析成 (国家, 省份)；内网/无法解析/非 IPv4 返回 ("", "")。"""
    if not ip:
        return "", ""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "", ""
    # 只处理公网 IPv4；私网/回环/保留 及 IPv6 暂不解析（v6 需另配库）
    if addr.version != 4 or not addr.is_global:
        return "", ""
    searcher = _get_geo_searcher()
    if searcher is None:
        return "", ""
    try:
        region = searcher.search(ip) or ""
    except Exception:
        logger.exception("[analytics] geo search failed for ip")
        return "", ""
    parts = region.split("|")
    country = parts[0] if len(parts) > 0 else ""
    province = parts[1] if len(parts) > 1 else ""
    if country in _GEO_PLACEHOLDERS:
        country = ""
    if province in _GEO_PLACEHOLDERS:
        province = ""
    return country[:64], province[:64]

# 字段长度上限（防滥用；与 model max_length 对齐留余量）
_MAX_EVENT_NAME = 64
_MAX_PATH = 512
_MAX_REFERRER = 1024
_MAX_UTM = 128
_MAX_PROPS_KEYS = 50


def _clip(value: Optional[str], limit: int) -> str:
    if not value:
        return ""
    return str(value)[:limit]


def _host_of(url: str) -> str:
    if not url:
        return ""
    try:
        return urlsplit(url).netloc[:255]
    except ValueError:
        return ""


def hash_ua(user_agent: str) -> str:
    """把 User-Agent 哈希成指纹，不存原始 UA（隐私红线）。"""
    if not user_agent:
        return ""
    return hashlib.sha256(user_agent.encode("utf-8", "ignore")).hexdigest()[:64]


def _parse_occurred_at(raw: Optional[str]) -> datetime:
    if raw:
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            pass
    return timezone.now()


def _sanitize_props(props: Optional[dict]) -> dict:
    """限制 props 规模，避免被塞入超大 / 超多字段。"""
    if not isinstance(props, dict):
        return {}
    out: dict = {}
    for i, (k, v) in enumerate(props.items()):
        if i >= _MAX_PROPS_KEYS:
            break
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[str(k)[:64]] = v[:512] if isinstance(v, str) else v
        else:
            # 复杂值转成字符串截断，避免深层嵌套膨胀
            out[str(k)[:64]] = str(v)[:512]
    return out


def store_event(
    *,
    source: str,
    event_name: str,
    occurred_at_raw: Optional[str] = None,
    anon_id: str = "",
    session_id: str = "",
    user_id: str = "",
    path: str = "",
    referrer: str = "",
    utm_source: str = "",
    utm_medium: str = "",
    utm_campaign: str = "",
    platform: str = "",
    arch: str = "",
    app_version: str = "",
    geo_country: str = "",
    geo_province: str = "",
    ua_hash: str = "",
    short_link: Optional[ShortLink] = None,
    props: Optional[dict] = None,
) -> Optional[AnalyticsEvent]:
    """规范化并落库一条事件。永不抛异常。"""
    try:
        if not event_name:
            return None
        valid_sources = set(EventSource.values)
        normalized_source = source if source in valid_sources else EventSource.OTHER
        referrer_clipped = _clip(referrer, _MAX_REFERRER)
        return AnalyticsEvent.objects.create(
            source=normalized_source,
            event_name=_clip(event_name, _MAX_EVENT_NAME),
            occurred_at=_parse_occurred_at(occurred_at_raw),
            anon_id=_clip(anon_id, 64),
            session_id=_clip(session_id, 64),
            user_id=_clip(user_id, 64),
            path=_clip(path, _MAX_PATH),
            referrer=referrer_clipped,
            referrer_host=_host_of(referrer_clipped),
            utm_source=_clip(utm_source, _MAX_UTM),
            utm_medium=_clip(utm_medium, _MAX_UTM),
            utm_campaign=_clip(utm_campaign, _MAX_UTM),
            platform=_clip(platform, 32),
            arch=_clip(arch, 16),
            app_version=_clip(app_version, 64),
            geo_country=_clip(geo_country, 64),
            geo_province=_clip(geo_province, 64),
            ua_hash=_clip(ua_hash, 64),
            short_link=short_link,
            props=_sanitize_props(props),
        )
    except Exception:
        logger.exception("[analytics] store_event failed: %s/%s", source, event_name)
        return None


def resolve_short_link_target(link: ShortLink) -> str:
    """把短链解析成真实跳转 URL；无法解析返回空串。"""
    if link.target_type == ShortLink.TargetType.STATIC:
        return (link.target_url or "").strip()

    # latest_release：查 updater 已发布的最新版本对应安装包
    try:
        from apps.updater.models import AppRelease

        qs = AppRelease.objects.filter(
            platform=link.release_platform,
            arch=link.release_arch,
            channel=link.release_channel or "stable",
            is_draft=False,
            published_at__isnull=False,
            deprecated_at__isnull=True,
        ).order_by("-published_at")
        for release in qs:
            target = release.get_download_file_url()
            if target:
                return target
    except Exception:
        logger.exception("[analytics] resolve latest_release failed for slug=%s", link.slug)
    return ""


def record_download(
    link: ShortLink,
    *,
    referrer: str = "",
    utm_source: str = "",
    utm_medium: str = "",
    utm_campaign: str = "",
    geo_country: str = "",
    geo_province: str = "",
    ua_hash: str = "",
    anon_id: str = "",
) -> None:
    """短链被点击时：落 download 事件 + 更新短链冗余计数。永不抛异常。"""
    try:
        store_event(
            source=EventSource.WEB,
            event_name="download",
            anon_id=anon_id,
            referrer=referrer,
            # 短链自带渠道优先；否则用请求上带来的 utm
            utm_source=link.utm_source or utm_source,
            utm_medium=link.utm_medium or utm_medium,
            utm_campaign=link.utm_campaign or utm_campaign,
            platform=link.release_platform,
            arch=link.release_arch,
            geo_country=geo_country,
            geo_province=geo_province,
            ua_hash=ua_hash,
            short_link=link,
            props={"slug": link.slug, "channel": link.channel},
        )
        ShortLink.objects.filter(pk=link.pk).update(
            click_count=F("click_count") + 1,
            last_clicked_at=timezone.now(),
        )
    except Exception:
        logger.exception("[analytics] record_download failed for slug=%s", link.slug)
