"""
TabSite 站点公开访问视图

/s/{slug}/ 路由处理：
  - 查找 slug 对应的已发布站点
  - 重定向到 CDN 上的 dist 地址（index.html）
  - is_public=False 的站点返回 403
  - 密码保护通过 Session 验证：首次访问渲染密码输入页，验证通过后写 Session
"""

import logging

from django.contrib.auth.hashers import check_password
from django.db.models import F
from django.http import HttpResponseForbidden, HttpResponseRedirect, HttpResponseNotFound
from django.shortcuts import render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from apps.tabsite.models import Site

logger = logging.getLogger(__name__)

PASSWORD_SESSION_TTL = 3600 * 24  # 24 小时有效期


def _session_key(site_id: str) -> str:
    return f"tabsite_access_{site_id}"


def _redirect_to_dist(site: Site) -> HttpResponseRedirect:
    Site.objects.filter(id=site.id).update(total_views=F('total_views') + 1)
    dist_url = site.dist_oss_url.rstrip('/')
    response = HttpResponseRedirect(f'{dist_url}/index.html')
    response['X-TabSite-Version'] = str(site.current_version)
    return response


@csrf_protect
@require_http_methods(["GET", "POST"])
def site_access(request, slug: str):
    """公开访问已发布的站点"""
    try:
        site = Site.objects.get(slug=slug)
    except Site.DoesNotExist:
        return HttpResponseNotFound(
            '<html><body><h1>404</h1><p>站点不存在</p></body></html>',
            content_type='text/html',
        )

    if site.status != Site.Status.PUBLISHED:
        return HttpResponseNotFound(
            '<html><body><h1>404</h1><p>站点未发布</p></body></html>',
            content_type='text/html',
        )

    if not site.dist_oss_url:
        return HttpResponseNotFound(
            '<html><body><h1>404</h1><p>站点内容不可用</p></body></html>',
            content_type='text/html',
        )

    if not site.is_public:
        return HttpResponseForbidden(
            '<html><body><h1>403</h1><p>此站点不对外开放</p></body></html>',
            content_type='text/html',
        )

    # 密码保护
    if site.password:
        session_key = _session_key(str(site.id))
        if request.session.get(session_key):
            return _redirect_to_dist(site)

        if request.method == 'POST':
            password = request.POST.get('password', '')
            if check_password(password, site.password):
                request.session[session_key] = True
                request.session.set_expiry(PASSWORD_SESSION_TTL)
                return _redirect_to_dist(site)
            else:
                return render(request, 'tabsite/password.html', {
                    'site_name': site.name,
                    'error': '密码错误，请重试',
                }, status=403)

        return render(request, 'tabsite/password.html', {
            'site_name': site.name,
            'error': None,
        })

    return _redirect_to_dist(site)
