"""
下载短链公网跳转

/dl/<slug>：
  - 查启用中的短链 → 解析真实安装包 URL → 落一条 download 事件 → 302 跳转
  - 短链不存在 / 已停用 / 解析不到目标：返回 404
  - 仿 tabsite.site_access 的挂载方式（Django view + urlpatterns），不走 JSON API
"""

from __future__ import annotations

import logging

from django.http import HttpResponseNotFound, HttpResponseRedirect
from django.views.decorators.http import require_http_methods

from .models import ShortLink
from .services import hash_ua, record_download, resolve_geo, resolve_short_link_target

logger = logging.getLogger(__name__)


def _geo_client_ip(request) -> str:
    """地域统计专用取 IP：XFF 最右 = 边缘观察到的真实对端。仅用于统计，不参与鉴权。"""
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    ips = [p.strip() for p in xff.split(",") if p.strip()]
    if ips:
        return ips[-1]
    return request.META.get("REMOTE_ADDR", "") or ""

_NOT_FOUND_HTML = (
    "<html><body><h1>404</h1><p>下载链接不存在或已停用</p>"
    '<p><a href="/">返回首页</a></p></body></html>'
)


@require_http_methods(["GET"])
def download_redirect(request, slug: str):
    """短链跳转到真实安装包。"""
    link = ShortLink.objects.filter(slug=slug, is_active=True).first()
    if not link:
        return HttpResponseNotFound(_NOT_FOUND_HTML, content_type="text/html; charset=utf-8")

    target = resolve_short_link_target(link)
    if not target:
        logger.warning("[analytics] short link %s has no resolvable target", slug)
        return HttpResponseNotFound(_NOT_FOUND_HTML, content_type="text/html; charset=utf-8")

    geo_country, geo_province = resolve_geo(_geo_client_ip(request))
    if not geo_country:
        geo_country = request.META.get("HTTP_CF_IPCOUNTRY", "")[:64]

    record_download(
        link,
        referrer=request.META.get("HTTP_REFERER", ""),
        utm_source=request.GET.get("utm_source", ""),
        utm_medium=request.GET.get("utm_medium", ""),
        utm_campaign=request.GET.get("utm_campaign", ""),
        geo_country=geo_country,
        geo_province=geo_province,
        ua_hash=hash_ua(request.META.get("HTTP_USER_AGENT", "")),
        anon_id=request.GET.get("aid", ""),
    )

    return HttpResponseRedirect(target)
